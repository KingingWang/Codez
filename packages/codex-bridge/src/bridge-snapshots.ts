import { randomUUID } from "node:crypto";
import { formatModelPickerValue, getCodexPermissionModes } from "@codez/shared";
import {
  compactConversationRowForWire,
  subagentProjectionStateSchema,
  workspaceConfigSnapshotSchema,
  type ConversationSnapshot,
} from "@codez/shared/codez-protocol-v4";
import type { BridgeControlContext } from "./contract.js";
import { DeletedThreadError, type ThreadStateStore } from "./thread-state.js";
import type { InteractionBroker } from "./interactions.js";
import { readControlModelSettings, readControlPresentation } from "./control-presentation.js";
import { projectThreadMode } from "./command-input.js";
import { parseCodexThreadIncremental, projectThread, projectSessionsIndex } from "./projection.js";
import { array, object } from "./json.js";
import { projectTurnFileChanges } from "./file-changes.js";
import { itemEntityId } from "./projection-rows.js";
import { codexUserInputSchema, type CodexTurn } from "./codex-types.js";
import { projectOwnedInput } from "./native-file-projection.js";
import { projectConversationTailWindow } from "./projection-window.js";
import { subagentsStateFromRows } from "./subagent-projection.js";
import { SubagentActivitySeedScheduler } from "./subagent-activity.js";
import { sparseNativeTurnUsage, sparseNativeUsage } from "./bridge-snapshot-usage.js";
import type { AttachmentStore, AttachmentReadAuthorization } from "./attachments.js";
import type { RuntimeNoticeStore } from "./runtime-notices.js";
import { projectGoalActionAvailability, projectNativeThreadGoal } from "./thread-goal.js";

export class BridgeSnapshots {
  private readonly indexEpoch = randomUUID();
  private readonly configEpoch = randomUUID();
  private indexSeq = 0;
  private configSeq = 0;
  /** Only derived, replaceable projections; Codex and ThreadStateStore retain the facts. */
  private readonly conversationCache = new Map<
    string,
    {
      state: NonNullable<ReturnType<ThreadStateStore["get"]>>;
      seq: number;
      revision: number;
      epoch: string;
      snapshot: ConversationSnapshot;
    }
  >();
  /** 子线程活性一次性种子调度（实现见 subagent-activity.ts；tracker 归 store 所有）。 */
  private readonly subagentActivitySeeds: SubagentActivitySeedScheduler;
  private readonly attachmentViews = new Map<
    string,
    { epoch: string; rows: ConversationSnapshot["rows"]["window"] }
  >();
  private readonly revertedTurns = new Map<string, Set<string>>();
  /**
   * 已完成 turn 的附件与图片文件名投影缓存：避免流式期间每个快照都重跑整段历史的
   * projectOwnedInput / findNativeAttachment / findNativeImageAttachment。
   */
  private readonly settledTurnAttachmentCache = new WeakMap<
    CodexTurn,
    {
      sessionId: string;
      itemsRef: CodexTurn["items"];
      itemsLength: number;
      turn: CodexTurn;
      userProjections: Array<[string, Awaited<ReturnType<typeof projectOwnedInput>>]>;
      imageViewFileNames: Array<[string, string]>;
    }
  >();

  constructor(
    private readonly context: BridgeControlContext,
    private readonly store: ThreadStateStore,
    private readonly interactions: InteractionBroker,
    readonly workspaceId: string,
    private readonly attachments?: AttachmentStore,
    private readonly runtimeNotices?: RuntimeNoticeStore,
  ) {
    this.subagentActivitySeeds = new SubagentActivitySeedScheduler({
      rpc: context.rpc,
      nativeThreadStatus: (childId) => store.nativeThreadStatus(childId),
      tracker: store.subagentActivityTracker(),
      touchParent: (parentId) => store.touch(parentId),
    });
  }

  /** 测试与诊断用：等待所有进行中的子线程活性种子完成。 */
  async whenSubagentActivitySeedsSettled(): Promise<void> {
    await this.subagentActivitySeeds.whenSettled();
  }

  /**
   * Desktop 成功事务是文件恢复的事实来源，但原生历史不可重写。
   * 仅在投影层把同一 session/turn 标为 reverted；touch 复用既有全量快照发布，
   * 让同一 logEpoch 下的 revision/seq 变化负责失效 UI 终态缓存。
   */
  isFileChangesReverted(sessionId: string, turnId: string): boolean {
    return this.revertedTurns.get(sessionId)?.has(turnId) === true;
  }

  markFileChangesReverted(sessionId: string, turnId: string): (() => void) | undefined {
    let turns = this.revertedTurns.get(sessionId);
    if (!turns) {
      turns = new Set();
      this.revertedTurns.set(sessionId, turns);
    }
    if (turns.has(turnId)) return undefined;
    turns.add(turnId);
    // Revision/touch happens only after the mutation RPC is ready to ACK; otherwise the
    // store listener can publish a reverted snapshot before the transaction sees its ACK.
    return () => this.store.touch(sessionId);
  }

  async conversation(id: string, additionalDirectories?: string[]): Promise<ConversationSnapshot> {
    const state = await this.store.ensure(id, additionalDirectories);
    const cached = this.conversationCache.get(id);
    if (
      cached?.state === state &&
      cached.seq === state.seq &&
      cached.revision === state.revision &&
      cached.epoch === state.epoch
    ) {
      // 原因：rows/range、rowPayload 和 plans 以前每次都重投影完整历史，
      // 长会话向上翻页会反复做 O(全史) 工作；同一版本只重用派生结果。
      this.conversationCache.delete(id);
      this.conversationCache.set(id, cached);
      return cached.snapshot;
    }
    this.conversationCache.delete(id);
    const startSeq = state.seq;
    const startRevision = state.revision;
    const startEpoch = state.epoch;
    const attachmentStore = this.attachments;
    const userProjections = new Map<string, Awaited<ReturnType<typeof projectOwnedInput>>>();
    const queueProjections = new Map<string, Awaited<ReturnType<typeof projectOwnedInput>>>();
    const imageViewFileNames = new Map<string, string>();
    const nativeThread = attachmentStore ? parseCodexThreadIncremental(state.thread) : undefined;
    // 原因：原生模型输入可包含多份完整内联文件，原始正文在剥离附件前可能超过 UI 单行预算。
    // 先按会话所有权逐项校验并派生展示文本，避免历史规模超过 store 的并发操作上限；
    // 再让纯投影执行行预算。只复制本次快照输入，不修改原生事实或另存队列。
    let presentationThread: unknown = state.thread;
    if (attachmentStore && nativeThread) {
      const turns: typeof nativeThread.turns = [];
      for (const turn of nativeThread.turns) {
        if (state.sideChat?.inheritedTurnIds.has(turn.id)) {
          turns.push(turn);
          continue;
        }
        const canCacheTurn = turn.status !== "inProgress";
        if (canCacheTurn) {
          const cachedTurn = this.settledTurnAttachmentCache.get(turn);
          if (
            cachedTurn &&
            cachedTurn.sessionId === id &&
            cachedTurn.itemsRef === turn.items &&
            cachedTurn.itemsLength === turn.items.length
          ) {
            for (const [key, value] of cachedTurn.userProjections) userProjections.set(key, value);
            for (const [key, value] of cachedTurn.imageViewFileNames)
              imageViewFileNames.set(key, value);
            turns.push(cachedTurn.turn);
            continue;
          }
        }
        const items: typeof turn.items = [];
        const turnUserProjections: Array<[string, Awaited<ReturnType<typeof projectOwnedInput>>]> =
          [];
        const turnImageViewFileNames: Array<[string, string]> = [];
        let changedItems = false;
        for (const item of turn.items) {
          if (item.type === "imageView" && typeof item.path === "string") {
            const owned = await attachmentStore.findNativeAttachment(item.path, id);
            if (owned?.fileName) {
              const entityKey = itemEntityId(turn.id, item.id);
              imageViewFileNames.set(entityKey, owned.fileName);
              turnImageViewFileNames.push([entityKey, owned.fileName]);
            }
            items.push(item);
            continue;
          }
          if (item.type !== "userMessage") {
            items.push(item);
            continue;
          }
          const projected = await projectOwnedInput(
            codexUserInputSchema.array().parse(array(item.content)),
            id,
            attachmentStore,
          );
          const entityKey = itemEntityId(turn.id, item.id);
          userProjections.set(entityKey, projected);
          turnUserProjections.push([entityKey, projected]);
          changedItems = true;
          items.push({
            ...item,
            content: [{ type: "text", text: projected.text, text_elements: [] }],
          });
        }
        // 若该轮次没有任何 userMessage 改写，直接保留原 turn 引用，使下游 settledTurnRowsCache 命中 WeakMap。
        const projectedTurn = changedItems ? { ...turn, items } : turn;
        if (canCacheTurn) {
          this.settledTurnAttachmentCache.set(turn, {
            sessionId: id,
            itemsRef: turn.items,
            itemsLength: turn.items.length,
            turn: projectedTurn,
            userProjections: turnUserProjections,
            imageViewFileNames: turnImageViewFileNames,
          });
        }
        turns.push(projectedTurn);
      }
      presentationThread = { ...nativeThread, turns };
    }
    let presentationQueue: unknown[] = state.queue;
    if (attachmentStore) {
      presentationQueue = [];
      for (const entry of state.queue) {
        const source = object(entry);
        const projected = await projectOwnedInput(
          codexUserInputSchema.array().parse(array(source.input)),
          id,
          attachmentStore,
        );
        if (typeof source.id === "string") queueProjections.set(source.id, projected);
        presentationQueue.push({
          ...source,
          input: [{ type: "text", text: projected.text, text_elements: [] }],
        });
      }
    }
    const snapshot = projectThread(presentationThread, {
      workspacePath: this.store.cwd,
      workspaceId: this.workspaceId,
      logEpoch: state.epoch,
      seq: state.seq,
      revision: state.revision,
      queue: presentationQueue,
      interactions: this.interactions.list(id),
      apiRetry:
        state.apiRetry && state.apiRetry.turnId === object(array(state.thread.turns).at(-1)).id
          ? state.apiRetry.status
          : null,
      runtimeNotices: this.runtimeNotices?.list(id) ?? [],
      // 辅助对话 child：fork 继承的父历史只进模型上下文，不进 UI 投影。
      ...(state.sideChat ? { hiddenTurnIds: state.sideChat.inheritedTurnIds } : {}),
    });
    // Batch A/B 的稀疏事实边界：只有原生明确给到的非负安全整数才是观测值。
    // 旧 dense usage 字段保持缺省（UI 展示为不可用），不能把缺席/坏值归零。
    const observed = sparseNativeUsage(state.thread.tokenUsage);
    if (observed) {
      snapshot.usage = {
        ...snapshot.usage,
        cumulative: observed.cumulative,
        contextWindow: observed.contextWindow,
        codexObserved: observed.codexObserved,
      };
    }
    const idle = snapshot.control.phase !== "running";
    // 记住的显式档位优先；无记录按原生生效值推导（specs/codex-permission-modes.md）。
    snapshot.config.mode = projectThreadMode(state.thread);
    if (state.thread.collaborationMode)
      snapshot.config.planEnabled = object(state.thread.collaborationMode).mode === "plan";
    const projectedGoal = projectNativeThreadGoal(state.goal);
    if (projectedGoal) snapshot.goal = projectedGoal;
    const allowed = { allowed: true as const };
    // writer-conflict 只读：另一进程持有写锁。fork 保持 idle 门禁不变（逃生通道）；
    // 其余写操作的 availability 与命令层的 deny guard 同一 reasonCode，UI 直接禁用。
    const writerConflict = state.readOnly === "writer-conflict";
    if (writerConflict) snapshot.writerConflict = { readOnly: true };
    // 子代理会话只读不设 writerConflict（那条文案语义是「被别的窗口/进程占用」），
    // 只用 availability 报禁用；reasonCode 与原生 flavor 同词，UI tooltip 直接复用。
    const readOnlyBlocked = state.readOnly
      ? {
          allowed: false as const,
          reasonCode:
            state.readOnly === "subagent-child"
              ? "guard.subagentReadOnly"
              : "guard.codex.writerConflict",
        }
      : undefined;
    snapshot.availability = {
      ...snapshot.availability,
      fork: idle ? allowed : { allowed: false, reasonCode: "guard.codex.activeTurn" },
      compact:
        readOnlyBlocked ??
        (idle ? allowed : { allowed: false, reasonCode: "guard.codex.activeTurn" }),
      switchModelConfig: readOnlyBlocked ?? allowed,
      queueEdit: readOnlyBlocked ?? allowed,
      // busy 也可用：命令层 interrupt+start 抢占（specs/codex-desktop-adapter.md）。
      sendQueuedNow: readOnlyBlocked ?? allowed,
      ...projectGoalActionAvailability(projectedGoal, readOnlyBlocked),
    };
    // 子代理下钻（specs/codex-desktop-subagent-drilldown.md）：running/ended 从已投影的
    // subagent 行派生，不额外请求原生；revision 交给 store 记账，语义不变则不递增。
    // 必须在 tail window 截断前用完整 rows 计算，否则旧会话的子代理会从目录里消失。
    const subagents = subagentsStateFromRows(snapshot.rows.window, {
      isChildActive: (childThreadId) => {
        const status = this.store.nativeThreadStatus(childThreadId);
        if (status) return status.type === "active";
        // 未加载子线程退回事件/种子观测：父线程经常永远没有终态事实（v1 只在
        // wait/send_input 观测时写 agentsStates，v2 只在 Completed 时写 activity），
        // 没有这条旁路，状态面板会在子代理结束后一直计时。
        return this.store.observedThreadActive(childThreadId);
      },
    });
    this.store.noteSubagentChildren(id, subagents.childSessionIds);
    this.subagentActivitySeeds.schedule(id, subagents.running);
    snapshot.subagents = subagentProjectionStateSchema.parse({
      revision: this.store.rememberSubagents(
        id,
        JSON.stringify(subagents),
        subagents.childSessionIds.length,
      ),
      ...subagents,
    });
    if (this.attachments) {
      for (const queueItem of snapshot.queue.items) {
        const projected = queueProjections.get(queueItem.queueItemId);
        if (!projected) continue;
        queueItem.text = projected.text;
        queueItem.attachments = projected.refs;
      }
    }
    // 预构建 turnId → turn 索引，将 turnHeader 遍历中的线性查找 O(Turns²) 降为 O(1)。
    const rawTurns = array(state.thread.turns);
    const turnsById = new Map<
      string,
      { id: string; status?: unknown; items?: unknown; changes?: unknown; tokenUsage?: unknown }
    >();
    for (const candidate of rawTurns) {
      if (candidate && typeof candidate === "object" && !Array.isArray(candidate)) {
        const turnObj = candidate as {
          id?: unknown;
          status?: unknown;
          items?: unknown;
          changes?: unknown;
          tokenUsage?: unknown;
        };
        if (typeof turnObj.id === "string") {
          turnsById.set(turnObj.id, turnObj as { id: string });
        }
      }
    }
    const lastTurnEntry = rawTurns.at(-1);
    const lastTurnId =
      lastTurnEntry && typeof lastTurnEntry === "object" && !Array.isArray(lastTurnEntry)
        ? (lastTurnEntry as { id?: unknown }).id
        : undefined;
    for (const row of snapshot.rows.window) {
      if (idle && row.kind === "assistantText") row.actions = { canFork: true };
      if (idle && !writerConflict && row.kind === "userInput")
        row.actions = { canEdit: true, canRetry: true, editDisposition: "rewind" };
      if (row.kind === "turnHeader") {
        const turn = turnsById.get(row.turnId);
        // 修复原因：快照编码的 attachments 投影会让出 await，期间 editUserQuery/compact
        // 触发的 reloadAfterHistoryChange 会把 state.thread.turns 清空；行投影来自编码前
        // 拷贝的 presentationThread，turnHeader 仍在而 turns 已空。此处用 object() 强断言
        // 会抛 "Expected a JSON object" 并使整个 bridge 连接崩溃（原生冒烟因此失败）。
        // lastTurnId 只作 tokenUsage 兜底匹配，取不到时安全降级为不可匹配。
        const rawTurnUsage =
          state.turnTokenUsage?.[row.turnId] ??
          turn?.tokenUsage ??
          (row.turnId === lastTurnId ? state.thread.tokenUsage : undefined);
        const turnUsage = sparseNativeTurnUsage(rawTurnUsage);
        if (turnUsage) {
          row.turnUsage = turnUsage;
          if (turnUsage.outputTokens !== undefined) {
            row.outputTokens = turnUsage.outputTokens;
          }
        }
        if (turn) {
          const filesResult = projectTurnFileChanges(
            turn,
            this.isFileChangesReverted(id, turn.id) ? "reverted" : "active",
          );
          if (filesResult.files)
            row.fileChanges = {
              files: filesResult.files,
              additions: filesResult.additions,
              deletions: filesResult.deletions,
              state: filesResult.state,
            };
          // 行级撤销入口只描述「该轮存在可投影的文件变更」这一事实；
          // 能力门禁与 Desktop 事务所有者仍在 UI/服务层判定。
          // 运行中的轮次变更不完整，不开放撤销；已撤销的轮次不重复开放。
          if (filesResult.files > 0 && filesResult.state !== "reverted" && row.state !== "running")
            row.actions = { ...row.actions, canRewindFiles: true };
        }
      }
      if (row.kind === "userInput" && this.attachments) {
        // entityId 仍是 turn 作用域展示键；与预投影后的唯一派生结果对应。
        const projected = userProjections.get(row.entityId ?? "");
        if (projected) {
          row.text = projected.text;
          row.attachments = projected.refs;
        }
      }
      if (row.kind === "toolCall" && row.toolName === "view_image" && this.attachments) {
        const fileName = imageViewFileNames.get(row.entityId ?? "");
        if (fileName && row.input && typeof row.input === "object" && !Array.isArray(row.input)) {
          const nextInput = { ...(row.input as Record<string, unknown>), fileName };
          row.input = nextInput;
          row.inputText = JSON.stringify(nextInput);
        }
      }
    }
    if (this.store.get(id) !== state) throw new DeletedThreadError();
    this.attachmentViews.set(id, { epoch: snapshot.logEpoch, rows: snapshot.rows.window });
    if (state.seq === startSeq && state.revision === startRevision && state.epoch === startEpoch) {
      this.conversationCache.set(id, {
        state,
        seq: startSeq,
        revision: startRevision,
        epoch: startEpoch,
        snapshot,
      });
      // 派生缓存不随已加载 session 总数增长：冷开多个大型历史时最多保留两份。
      if (this.conversationCache.size > 2)
        this.conversationCache.delete(this.conversationCache.keys().next().value!);
    }
    return snapshot;
  }

  authorizeAttachment(query: AttachmentReadAuthorization): boolean {
    const view = this.attachmentViews.get(query.sessionId);
    const state = this.store.get(query.sessionId);
    if (!view || !state || view.epoch !== state.epoch) return false;
    return view.rows.some(
      (row) =>
        row.kind === "userInput" &&
        (!query.target ||
          (row.rowId === query.target.rowId && row.entityId === query.target.entityId)) &&
        row.attachments?.some(
          (ref, index) =>
            ref.ref === query.ref &&
            (query.attachmentIndex === undefined || index === query.attachmentIndex),
        ),
    );
  }

  async topic(
    topic: string,
    additionalDirectories?: string[],
  ): Promise<{ snapshot: unknown; seq: number; logEpoch: string }> {
    if (topic.startsWith("conversation/")) {
      const full = await this.conversation(
        topic.slice("conversation/".length),
        additionalDirectories,
      );
      // 历史分页和实时尾窗分离，避免一个大型历史会话超出物理传输预算。
      // firstRowId/totalCount 必须保持全序口径：客户端以 window[0].rowId === firstRowId
      // 判定是否已到顶，跟随截尾改写会让 hasOlderRows 恒为 false，rows/range 分页、
      // 问题目录补齐与「加载更早」入口全部静默失效（specs/codex-desktop-adapter.md）。
      const snapshot = {
        ...full,
        rows: {
          ...full.rows,
          window: projectConversationTailWindow(full.rows.window).map(
            compactConversationRowForWire,
          ),
        },
      };
      return { snapshot, seq: snapshot.seq, logEpoch: snapshot.logEpoch };
    }
    if (topic === `sessions-index/${this.workspaceId}`) {
      const threads = await this.store.consumeDiscoveredListOrScan();
      return {
        snapshot: projectSessionsIndex(threads, {
          workspacePath: this.store.cwd,
          workspaceId: this.workspaceId,
          logEpoch: this.indexEpoch,
        }),
        seq: ++this.indexSeq,
        logEpoch: this.indexEpoch,
      };
    }
    if (topic === `workspace-config/${this.workspaceId}`) {
      const [settings, presentation] = await Promise.all([
        readControlModelSettings(this.context),
        readControlPresentation(
          { workspacePath: this.store.cwd, workspaceKey: this.workspaceId },
          this.context,
        ),
      ]);
      const snapshot = workspaceConfigSnapshotSchema.parse({
        protocolVersion: 1,
        workspaceId: this.workspaceId,
        logEpoch: this.configEpoch,
        config: {
          slashCommands: presentation.slashCommands,
          configOptions: [
            {
              id: "model",
              name: "Codex model",
              type: "select",
              currentValue: formatModelPickerValue(settings.model.current),
              options: settings.model.available.map((model) => ({
                value: formatModelPickerValue(model.ref),
                name: model.label,
                description: model.description,
                origin: "native",
                modelProviderId: model.ref.providerId,
                modelProviderName: model.providerLabel,
                modelThoughtLevels: model.reasoning?.levels.map((level) => level.value),
                modelDefaultThoughtLevel: model.reasoning?.defaultLevel,
              })),
            },
            {
              id: "thought_level",
              name: "Reasoning",
              type: "select",
              currentValue: settings.thoughtLevel.current ?? "",
              options: settings.thoughtLevel.available.map((level) => ({
                value: level.value,
                name: level.label,
              })),
            },
            {
              id: "mode",
              name: "Codex mode",
              type: "select",
              currentValue: settings.mode.current,
              // Plan 是独立勾选维度，保留旧 configOptions 消费方的兼容条目；
              // 权限档位目录与 composer 菜单同源（shared getCodexPermissionModes）。
              options: [
                { value: "plan", name: "Plan" },
                ...getCodexPermissionModes().map((mode) => ({
                  value: mode.id,
                  name: mode.name,
                  description: mode.description,
                })),
              ],
            },
          ],
        },
      });
      return { snapshot, seq: ++this.configSeq, logEpoch: this.configEpoch };
    }
    throw new Error("Subscription topic is outside this workspace");
  }
}
