import {
  V4_METHODS,
  commandsQueryParamsSchema,
  codexConversationHistoryRunsParamsSchema,
  v4ConversationFileChangesParamsSchema,
  v4ConversationFileRewindProjectionOverlayParamsSchema,
} from "@codez/shared/codez-protocol-v4";
import type { BridgeControlContext, CodexProcess } from "./contract.js";
import { DeletedThreadError, ThreadStateStore } from "./thread-state.js";
import { InteractionBroker } from "./interactions.js";
import { CommandLedger } from "./command-ledger.js";
import { CommandRouter } from "./commands.js";
import { RewindNoticeStore, relativizeRewindNoticePath } from "./rewind-notice.js";
import { BridgeSnapshots } from "./bridge-snapshots.js";
import { BridgeSubscriptions, type ConversationStateVersion } from "./subscriptions.js";
import { AttachmentStore } from "./attachments.js";
import { isRowBudgetExceeded, type RowBudgetExceededError } from "./projection-bounds.js";
import { supportsControlMethod, handleControlRequest } from "./control-plane.js";
import { ensureOfficialRegistered } from "./control-official-plugins.js";
import { OfficialPluginMarketplace } from "./official-plugin-marketplace.js";
import { handleLegacySession } from "./legacy-sessions.js";
import { array, object, string, unsupported } from "./json.js";
import { projectTurnFileChanges } from "./file-changes.js";
import { projectCodexHistoryRuns } from "./history-runs.js";
import { join } from "node:path";
import { AuxiliaryText } from "./auxiliary-text.js";
import { SessionTitleCoordinator } from "./session-title.js";
import {
  queryBridgePlans,
  queryBridgeRowPayload,
  queryBridgeRowsRange,
  reconcileBridgeSessions,
} from "./thread-queries.js";
import { queryCodexAppUsageStats } from "./codex-app-usage.js";
import { scopeWorkspaceParams, handleCodexNativeRequest } from "./request-scope.js";
import type { BridgeFailureOrigin } from "./diagnostics.js";
import {
  isRuntimeNoticeMethod,
  readRuntimeNotice,
  type CodexRuntimeNoticeLog,
} from "./runtime-notices.js";

export interface BridgeResponse {
  result: unknown;
  afterResponse?: () => Promise<void>;
}
export interface BridgeRuntimeOptions {
  rpc: CodexProcess;
  cwd: string;
  workspaceId: string;
  stateRoot: string;
  officialMarketplaceRoot?: string;
  notify(method: string, params: unknown): Promise<void>;
  logRuntimeNotice(notice: CodexRuntimeNoticeLog): void;
  fatal(error: Error, origin?: BridgeFailureOrigin): void;
  nativeBrowserCua?: BridgeControlContext["nativeBrowserCua"];
  providerKeyGate?: import("./provider-key-gate.js").CodexProviderKeyGate;
}

export class BridgeRuntime {
  private readonly store: ThreadStateStore;
  private readonly interactions: InteractionBroker;
  private readonly ledger: CommandLedger;
  private readonly commands: CommandRouter;
  private readonly rewindNotices = new RewindNoticeStore();
  private readonly snapshots: BridgeSnapshots;
  private readonly subscriptions: BridgeSubscriptions;
  private readonly attachments: AttachmentStore;
  private readonly auxiliary: AuxiliaryText;
  private readonly title: SessionTitleCoordinator;
  private readonly officialPlugins: OfficialPluginMarketplace | undefined;
  private readonly unsubscribe: (() => void)[] = [];
  private readonly pendingChangedIds = new Set<string>();
  private changeFlushScheduled = false;
  private eventTail: Promise<void> = Promise.resolve();
  private closed = false;

  constructor(private readonly options: BridgeRuntimeOptions) {
    const { rpc, cwd, workspaceId, stateRoot, notify } = options;
    this.store = new ThreadStateStore(rpc, cwd);
    this.auxiliary = new AuxiliaryText({ rpc, cwd, providerKeyGate: options.providerKeyGate });
    const titleDeps = { rpc, store: this.store, auxiliary: this.auxiliary, cwd, workspaceId };
    this.title = new SessionTitleCoordinator(titleDeps);
    this.officialPlugins = options.officialMarketplaceRoot
      ? new OfficialPluginMarketplace(options.officialMarketplaceRoot)
      : undefined;
    this.interactions = new InteractionBroker(rpc, (id) => this.store.touch(id));
    this.ledger = new CommandLedger(join(stateRoot, "commands"));
    this.attachments = new AttachmentStore({
      cwd,
      root: join(stateRoot, "attachments"),
      authorizeRead: (query) => this.snapshots.authorizeAttachment(query),
    });
    this.commands = new CommandRouter({
      rpc,
      store: this.store,
      interactions: this.interactions,
      ledger: this.ledger,
      workspaceId,
      attachments: (refs, sessionId) => this.attachments.toNativeInput(refs, sessionId),
      rewindNotices: this.rewindNotices,
      title: this.title,
      providerKeyGate: options.providerKeyGate,
    });
    this.snapshots = new BridgeSnapshots(
      { rpc, cwd, auxiliary: this.auxiliary },
      this.store,
      this.interactions,
      workspaceId,
      this.attachments,
    );
    this.subscriptions = new BridgeSubscriptions({
      workspaceId,
      snapshot: (topic, additionalDirectories) =>
        this.snapshots.topic(topic, additionalDirectories),
      notify,
      // 只有确定性、只读、可安全 resync 的行预算故障允许按 state 版本粘住重试；
      // 其余错误保持原有 dirty 重投与 fatal 判定（依据见 subscriptions.ts changed()）。
      recoverableProjectionFault: isRowBudgetExceeded,
    });
    this.unsubscribe.push(
      this.store.onChange((id) => {
        this.pendingChangedIds.add(id);
        if (this.changeFlushScheduled) return;
        this.changeFlushScheduled = true;
        queueMicrotask(() => {
          this.changeFlushScheduled = false;
          if (this.closed) {
            this.pendingChangedIds.clear();
            return;
          }
          const ids = [...this.pendingChangedIds];
          this.pendingChangedIds.clear();
          for (const changedId of ids) {
            const state = this.store.get(changedId);
            const stateVersion: ConversationStateVersion | undefined = state
              ? { epoch: state.epoch, revision: state.revision, seq: state.seq }
              : undefined;
            void this.subscriptions
              .changed(`conversation/${changedId}`, stateVersion)
              .catch((error: Error) => {
                if (this.closed || error instanceof DeletedThreadError) return;
                // 修复原因：单条投影行超出组装预算过去走同一条 fatal 分支，于是 bridge 进程退出
                // （main.ts stop(true) → process.exitCode = 1）。超限 item 已持久化在原生 rollout，
                // 该会话因此永久打不开，且每次尝试都连带杀死同一窗口内其他会话。
                // 修复依据：specs/codex-desktop-adapter.md:364-367 —— fatal 只保留给 invalid JSON、
                // invalid UTF-8、畸形信封等「resync 不可证明安全」的协议违规；行预算超限是只读投影
                // 的确定性结果，没有 mutation，resync 显然安全。:392-393 同时要求它仍然显式失败、
                // 不得静默截断，所以这里只把故障限定在本订阅路由内：不 fatal、不截断，输出一条
                // 闭合诊断，显式拒绝留给请求路径（subscribe/resync/rows/range 仍会带同一 typed
                // error 失败）。只教这一个 fatal 站点：assertRowBudget 仅经 projectRows 可达，其
                // 调用方是 bridge-snapshots.ts:333（本推送/请求路径）与三个 command 路径；
                // native-event(:189)、native-interaction(:204)、refreshSidebar(:237) 都不构建
                // ConversationRow，放宽它们会让原生事件协议损坏与侧栏索引失败变成非 fatal，
                // 与 spec:824-826 冲突。
                if (isRowBudgetExceeded(error)) {
                  this.reportRowBudgetFault(error);
                  return;
                }
                options.fatal(error, "conversation-projection");
              });
          }
        });
      }),
    );
    this.unsubscribe.push(
      rpc.onNotification((event) => {
        this.eventTail = this.eventTail
          .then(async () => {
            if (this.closed) return;
            const noticeMethod = isRuntimeNoticeMethod(event.method);
            const notice = readRuntimeNotice(event);
            if (notice) options.logRuntimeNotice(notice);
            const params: Record<string, unknown> = noticeMethod ? {} : object(event.params ?? {});
            // 事件已在 eventTail 上串行；await 保证归属解析不会让后到的事件插队。
            // 运行期通知只写日志，不经过 thread 状态门禁或快照广播；malformed 通知
            // 也不能被通用 params 强校验升级为 native-event fatal。
            if (!noticeMethod) await this.store.apply(event);
            void this.title.onNotification(event).catch(() => {});
            if (event.method === "serverRequest/resolved") {
              await this.interactions.resolved(string(params.threadId), params.requestId);
            }
            if (event.method === "thread/queue/changed" && typeof params.threadId === "string") {
              await this.store.refreshQueue(params.threadId);
            }
            if (event.method === "turn/completed") {
              await this.interactions.expireTurn(
                string(params.threadId),
                string(object(params.turn).id),
              );
            }
            if (
              [
                "thread/started",
                "thread/archived",
                "thread/deleted",
                "thread/name/updated",
                "turn/started",
                "turn/completed",
              ].includes(event.method) ||
              // 原因：原生预热线程首轮前无 rollout，command ACK 后的首次 thread/list
              // 可能早于首条用户消息落盘；在此补刷 sessions-index，避免界面等待改名或整轮完成。
              (event.method === "item/completed" && object(params.item).type === "userMessage")
            ) {
              this.refreshSidebar("sessions-index");
            }
            if (
              ["account/updated", "account/login/completed", "skills/changed"].includes(
                event.method,
              )
            ) {
              this.refreshSidebar("workspace-config");
            }
          })
          .catch((error: Error) => {
            if (!this.closed) options.fatal(error, "native-event");
          });
      }),
    );
    this.unsubscribe.push(
      rpc.onRequest((request) => {
        void this.interactions
          .accept(request)
          .catch(async () => {
            await rpc.respondError(request.id, {
              code: -32602,
              message: "Invalid native interaction",
            });
          })
          .catch((error: Error) => {
            if (!this.closed) options.fatal(error, "native-interaction");
          });
      }),
    );
    // 设置 → Codex「插件与市场」走原生 plugin/list，不经商店控制面；启动即用
    // 已物化的快照预热官方市场注册（cachedOnly，不触网），首次打开面板即可见。
    void ensureOfficialRegistered(this.control(), { cachedOnly: true });
  }

  private control(): BridgeControlContext {
    return {
      rpc: this.options.rpc,
      cwd: this.options.cwd,
      officialPlugins: this.officialPlugins,
      auxiliary: this.auxiliary,
      nativeBrowserCua: this.options.nativeBrowserCua,
    };
  }

  /** writer-conflict 只读投影在 subscribe/resync 时失效，下一次快照读取重新 load 并重试 resume。 */
  private invalidateReadOnlyProjection(params: unknown): void {
    // params 的形状校验归 subscriptions；这里仅 best-effort 提取 topic，健康线程不受影响。
    const topic = (params as { topic?: unknown } | null)?.topic;
    if (typeof topic === "string" && topic.startsWith("conversation/"))
      this.store.invalidate(topic.slice("conversation/".length));
  }

  private refreshSidebar(topic: "sessions-index" | "workspace-config"): void {
    // 列表/配置读取不能卡住下一轮原生事件；复用 publisher 的 dirty 合并与代际校验。
    // 关闭时在途读取的拒绝属于旧连接，不应再触发运行时崩溃。
    void this.subscriptions
      .changed(`${topic}/${this.options.workspaceId}`)
      .catch((error: Error) => {
        if (!this.closed) this.options.fatal(error, topic);
      });
  }

  /**
   * 只输出闭合字段：origin、故障码、行类别、字节数与预算，绝不输出行正文、entityId 或路径。
   * 依据：specs/codex-desktop-adapter.md:394-396（超限诊断不得含 JSON 前缀、正文、参数或路径）
   * 与 :824-826（生产诊断只暴露白名单分类与安全代码位置）。粘性故障保证同一 state 版本只写一行。
   * 行类别同样按闭合形状复核，避免未来新增 kind 时把非白名单文本带进 stderr。
   */
  private reportRowBudgetFault(error: RowBudgetExceededError): void {
    const kind = /^[A-Za-z]{1,32}$/.test(error.kind) ? error.kind : "unknown";
    const bytes = Number.isSafeInteger(error.bytes) && error.bytes >= 0 ? error.bytes : -1;
    const budget = Number.isSafeInteger(error.budget) && error.budget >= 0 ? error.budget : -1;
    process.stderr.write(
      `Codex desktop bridge warn: conversation row over budget; origin=conversation-projection; code=${error.code}; kind=${kind}; bytes=${bytes}; budget=${budget}\n`,
    );
  }

  async request(method: string, params: unknown): Promise<BridgeResponse> {
    const { rpc, cwd, workspaceId } = this.options;
    // 保留调用方原始 workspacePath 拼写（如软链接路径 /home/user/...），供 session/* 回包对齐 Host
    // 项目 root；scopeWorkspaceParams 校验物理路径一致后会把内部执行路径规范化为物理 cwd。
    const rawWorkspacePath =
      params && typeof params === "object" && "workspace" in params && params.workspace
        ? object(params.workspace).workspacePath
        : undefined;
    const requestedWorkspacePath =
      typeof rawWorkspacePath === "string" && rawWorkspacePath.trim().length > 0
        ? rawWorkspacePath
        : undefined;
    params = await scopeWorkspaceParams(params, cwd, workspaceId);
    if (this.auxiliary.supports(method))
      return { result: await this.auxiliary.handle(method, params) };
    if (method === "codex/request")
      return handleCodexNativeRequest(params, this.control(), () =>
        this.subscriptions.changed(`workspace-config/${workspaceId}`),
      );
    if (supportsControlMethod(method))
      return { result: await handleControlRequest(method, params, this.control()) };
    if (method.startsWith("session/")) {
      const result = await handleLegacySession(
        method,
        params,
        rpc,
        this.store,
        workspaceId,
        requestedWorkspacePath,
      );
      return {
        result,
        // 外部 CLI 不会向此连接发 thread 事件；显式打开项目后的列表扫描必须让
        // 既有 task-index/侧栏订阅重新读取事实。定向修复读取不能触发刷新回环。
        ...(method === "session/list" && object(params ?? {}).sessionIds === undefined
          ? { afterResponse: async () => this.refreshSidebar("sessions-index") }
          : {}),
      };
    }
    switch (method) {
      case V4_METHODS.conversationSubscribe:
        this.invalidateReadOnlyProjection(params);
        return this.subscriptions.subscribe(params);
      case V4_METHODS.sessionsIndexReconcile:
        return {
          result: await reconcileBridgeSessions(params, {
            rpc,
            cwd,
            workspaceId,
            store: this.store,
          }),
        };
      case V4_METHODS.conversationResync:
        this.invalidateReadOnlyProjection(params);
        return this.subscriptions.resync(params);
      case V4_METHODS.conversationUnsubscribe:
        return { result: await this.subscriptions.unsubscribe(params) };
      case V4_METHODS.connectionFlow:
        return { result: await this.subscriptions.flow(params) };
      case V4_METHODS.command:
        return {
          result: await this.commands.execute(params),
          afterResponse: async () => {
            await this.subscriptions.changed(`sessions-index/${workspaceId}`);
          },
        };
      case V4_METHODS.commandsQuery: {
        const parsed = commandsQueryParamsSchema.parse(params);
        const results = await Promise.all(
          parsed.commands.map(async (key) => ({
            key,
            result: (await this.ledger.lookup(key.sessionId, key.commandId)) ?? "unknown",
          })),
        );
        return { result: { results } };
      }
      case V4_METHODS.conversationRowsRange: {
        return {
          result: await queryBridgeRowsRange(params, (id) => this.snapshots.conversation(id)),
        };
      }
      case V4_METHODS.conversationRowPayload: {
        return {
          result: await queryBridgeRowPayload(params, (id) => this.snapshots.conversation(id)),
        };
      }
      case V4_METHODS.conversationPlans: {
        return {
          result: await queryBridgePlans(params, (id) => this.snapshots.conversation(id)),
        };
      }
      case V4_METHODS.usageStats: {
        return {
          result: await queryCodexAppUsageStats(params),
        };
      }
      case V4_METHODS.codexConversationHistoryRuns: {
        const parsed = codexConversationHistoryRunsParamsSchema.parse(params);
        const state = await this.store.ensure(parsed.sessionId);
        return {
          result: projectCodexHistoryRuns({
            thread: state.thread,
            params: parsed,
            seq: state.seq,
            revision: state.revision,
            logEpoch: state.epoch,
          }),
        };
      }
      case V4_METHODS.attachmentBegin:
        return { result: await this.attachments.handle(method, params) };
      case V4_METHODS.attachmentRead:
      case V4_METHODS.conversationAttachmentRead:
      case V4_METHODS.conversationAttachmentStat: {
        await this.snapshots.conversation(string(object(params).sessionId));
        return { result: await this.attachments.handle(method, params) };
      }
      case V4_METHODS.conversationFileChanges: {
        const parsed = v4ConversationFileChangesParamsSchema.parse(params);
        const snapshot = await this.snapshots.conversation(parsed.sessionId);
        if (snapshot.revision !== parsed.baseRevision || snapshot.logEpoch !== parsed.baseLogEpoch)
          throw new Error("Conversation changed; refresh file changes");
        const row = snapshot.rows.window.find(
          (candidate) =>
            candidate.rowId === parsed.target.rowId &&
            candidate.entityId === parsed.target.entityId,
        );
        if (!row) throw new Error("File change target no longer exists");
        const state = await this.store.ensure(parsed.sessionId);
        const turn = array(state.thread.turns)
          .map(object)
          .find((candidate) => candidate.id === row.turnId);
        if (!turn) throw new Error("File change turn no longer exists");
        return {
          result: projectTurnFileChanges(
            turn,
            this.snapshots.isFileChangesReverted(parsed.sessionId, row.turnId)
              ? "reverted"
              : "active",
          ),
        };
      }
      case V4_METHODS.attachmentChunk:
      case V4_METHODS.attachmentCommit:
      case V4_METHODS.attachmentAbort:
        return { result: await this.attachments.handle(method, params) };
      case V4_METHODS.conversationFileRewindProjectionOverlay: {
        const parsed = v4ConversationFileRewindProjectionOverlayParamsSchema.parse(params);
        const snapshot = await this.snapshots.conversation(parsed.sessionId);
        const row = snapshot.rows.window.find(
          (candidate) =>
            candidate.rowId === parsed.target.rowId &&
            candidate.entityId === parsed.target.entityId,
        );
        if (!row || row.kind !== "turnHeader" || row.turnId !== parsed.turnId)
          throw new Error("File rewind overlay target does not exist");
        const publishReverted = this.snapshots.markFileChangesReverted(
          parsed.sessionId,
          parsed.turnId,
        );
        if (publishReverted) {
          // 全新撤销（非重放）：登记一次性模型通知。投影层只改 UI 语义，
          // 模型不知道文件已被恢复；下一次 sendText 会把撤销事实 prepend 进用户文本。
          const state = await this.store.ensure(parsed.sessionId);
          const turn = array(state.thread.turns)
            .map(object)
            .find((candidate) => candidate.id === parsed.turnId);
          if (turn) {
            const changes = projectTurnFileChanges(turn);
            this.rewindNotices.record(parsed.sessionId, {
              turnId: parsed.turnId,
              files: changes.items.map((item) => ({
                path: relativizeRewindNoticePath(this.store.cwd, item.path),
                additions: item.additions,
                deletions: item.deletions,
              })),
            });
          }
        }
        return {
          result: {},
          // 先让成功事务收到 overlay ACK，再发布新的 revision，避免旧终端在
          // 得知恢复完成前收到一个无法解释的中间投影。
          afterResponse: async () => {
            if (publishReverted) {
              publishReverted();
              await this.subscriptions.changed(`conversation/${parsed.sessionId}`);
            }
          },
        };
      }
      default:
        unsupported(method);
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    this.title.close();
    for (const dispose of this.unsubscribe) dispose();
    this.subscriptions.close();
    // 派生资源清理失败不能跳过原生进程关闭，避免 Host 重启后残留上一代运行时。
    try {
      await this.auxiliary.close();
    } finally {
      try {
        await this.attachments.close();
      } finally {
        await this.options.rpc.close();
      }
    }
  }
}
