import {
  V4_METHODS,
  commandsQueryParamsSchema,
  v4ConversationRowsRangeParamsSchema,
  v4ConversationPlansParamsSchema,
  v4ConversationFileChangesParamsSchema,
} from "@codez/shared/codez-protocol-v4";
import type { CodexProcess } from "./contract.js";
import { DeletedThreadError, ThreadStateStore } from "./thread-state.js";
import { InteractionBroker } from "./interactions.js";
import { CommandLedger } from "./command-ledger.js";
import { CommandRouter } from "./commands.js";
import { BridgeSnapshots } from "./bridge-snapshots.js";
import { BridgeSubscriptions } from "./subscriptions.js";
import { AttachmentStore } from "./attachments.js";
import { supportsControlMethod, handleControlRequest } from "./control-plane.js";
import { handleLegacySession } from "./legacy-sessions.js";
import { array, object, string, unsupported } from "./json.js";
import { projectTurnFileChanges } from "./file-changes.js";
import { join } from "node:path";
import { AuxiliaryText } from "./auxiliary-text.js";
import { scopeWorkspaceParams, scopedNativeRequest } from "./request-scope.js";
import type { BridgeFailureOrigin } from "./diagnostics.js";

export interface BridgeResponse {
  result: unknown;
  afterResponse?: () => Promise<void>;
}
export interface BridgeRuntimeOptions {
  rpc: CodexProcess;
  cwd: string;
  workspaceId: string;
  stateRoot: string;
  notify(method: string, params: unknown): Promise<void>;
  fatal(error: Error, origin?: BridgeFailureOrigin): void;
}

export class BridgeRuntime {
  private readonly store: ThreadStateStore;
  private readonly interactions: InteractionBroker;
  private readonly ledger: CommandLedger;
  private readonly commands: CommandRouter;
  private readonly snapshots: BridgeSnapshots;
  private readonly subscriptions: BridgeSubscriptions;
  private readonly attachments: AttachmentStore;
  private readonly auxiliary: AuxiliaryText;
  private readonly unsubscribe: (() => void)[] = [];
  private eventTail: Promise<void> = Promise.resolve();
  private closed = false;

  constructor(private readonly options: BridgeRuntimeOptions) {
    const { rpc, cwd, workspaceId, stateRoot, notify } = options;
    this.store = new ThreadStateStore(rpc, cwd);
    this.auxiliary = new AuxiliaryText({ rpc, cwd });
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
    });
    this.snapshots = new BridgeSnapshots(
      { rpc, cwd },
      this.store,
      this.interactions,
      workspaceId,
      this.attachments,
    );
    this.subscriptions = new BridgeSubscriptions({
      workspaceId,
      snapshot: (topic) => this.snapshots.topic(topic),
      notify,
    });
    this.unsubscribe.push(
      this.store.onChange((id) => {
        void this.subscriptions.changed(`conversation/${id}`).catch((error: Error) => {
          if (!this.closed && !(error instanceof DeletedThreadError))
            options.fatal(error, "conversation-projection");
        });
      }),
    );
    this.unsubscribe.push(
      rpc.onNotification((event) => {
        this.eventTail = this.eventTail
          .then(async () => {
            if (this.closed) return;
            const params = object(event.params ?? {});
            // 事件已在 eventTail 上串行；await 保证归属解析不会让后到的事件插队。
            await this.store.apply(event);
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
                "turn/completed",
              ].includes(event.method)
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

  async request(method: string, params: unknown): Promise<BridgeResponse> {
    const { rpc, cwd, workspaceId } = this.options;
    params = await scopeWorkspaceParams(params, cwd, workspaceId);
    if (this.auxiliary.supports(method))
      return { result: await this.auxiliary.handle(method, params) };
    if (method === "codex/request") {
      const request = await scopedNativeRequest(params, rpc, cwd);
      const result = await rpc.request(request.method, request.params);
      return {
        result,
        afterResponse: async () => {
          if (
            [
              "config/value/write",
              "config/batchWrite",
              "account/logout",
              "skills/config/write",
            ].includes(request.method)
          ) {
            await this.subscriptions.changed(`workspace-config/${workspaceId}`);
          }
        },
      };
    }
    if (supportsControlMethod(method))
      return { result: await handleControlRequest(method, params, { rpc, cwd }) };
    if (method.startsWith("session/")) {
      const result = await handleLegacySession(method, params, rpc, this.store, workspaceId);
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
        const parsed = v4ConversationRowsRangeParamsSchema.parse(params);
        const snapshot = await this.snapshots.conversation(parsed.sessionId);
        const all = snapshot.rows.window.filter(
          (row) => parsed.beforeRowId === undefined || row.rowId < parsed.beforeRowId,
        );
        return {
          result: {
            rows: all.slice(-parsed.limit),
            atSeq: snapshot.seq,
            atRevision: snapshot.revision,
            atLogEpoch: snapshot.logEpoch,
            hasMore: all.length > parsed.limit,
          },
        };
      }
      case V4_METHODS.conversationPlans: {
        const parsed = v4ConversationPlansParamsSchema.parse(params);
        const snapshot = await this.snapshots.conversation(parsed.sessionId);
        return {
          result: {
            plans: snapshot.rows.window.filter(
              (row) => row.kind === "toolCall" && row.toolName === "ExitPlanMode",
            ),
            atSeq: snapshot.seq,
            atLogEpoch: snapshot.logEpoch,
          },
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
        return { result: projectTurnFileChanges(turn) };
      }
      case V4_METHODS.attachmentChunk:
      case V4_METHODS.attachmentCommit:
      case V4_METHODS.attachmentAbort:
        return { result: await this.attachments.handle(method, params) };
      default:
        unsupported(method);
    }
  }

  async close(): Promise<void> {
    this.closed = true;
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
