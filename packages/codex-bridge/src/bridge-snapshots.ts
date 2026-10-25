import { randomUUID } from "node:crypto";
import { formatModelPickerValue, getCodexPermissionModes } from "@codez/shared";
import {
  compactConversationRowForWire,
  subagentProjectionStateSchema,
  workspaceConfigSnapshotSchema,
  type ConversationRow,
  type ConversationSnapshot,
} from "@codez/shared/codez-protocol-v4";
import type { BridgeControlContext } from "./contract.js";
import {
  DeletedThreadError,
  type ThreadProjectionState,
  type ThreadStateStore,
} from "./thread-state.js";
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
import {
  sparseNativeTurnUsage,
  sparseNativeUsage,
  type NativeTurnUsageAccumulator,
} from "./bridge-snapshot-usage.js";
import type { AttachmentStore, AttachmentReadAuthorization } from "./attachments.js";
import { projectGoalActionAvailability, projectNativeThreadGoal } from "./thread-goal.js";

/** in-flight 合并表容量：与 MAX_BRIDGE_SUBSCRIPTIONS 同阶，避免多窗口订阅时无界增长。 */
const MAX_CONVERSATION_IN_FLIGHT = 32;
/** 未命中轮次的原生 turn 先按尾部探测：流式期间未命中的几乎总是最后一轮。 */
const RAW_TURN_TAIL_PROBE = 16;
const NO_ROWS: readonly ConversationRow[] = [];

type RawTurn = {
  id: string;
  status?: unknown;
  items?: unknown;
  changes?: unknown;
  tokenUsage?: unknown;
};
type OwnedInputProjection = Awaited<ReturnType<typeof projectOwnedInput>>;

/**
 * additionalDirectories 只影响 store.ensure 的加载入参，不影响同一 state 版本的投影结果；
 * 规范化（去重 + 排序）后作为 in-flight key 的一部分，避免同一会话因入参顺序不同而重复构建。
 */
function additionalDirectoriesKey(directories?: readonly string[]): string {
  if (!directories || directories.length === 0) return "";
  return [...new Set(directories)].sort().join("\u0000");
}

function rawTurnId(candidate: unknown): string | undefined {
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return undefined;
  const id = (candidate as { id?: unknown }).id;
  return typeof id === "string" ? id : undefined;
}

/** 单个已 settled 轮次的行富化结果；键是 projectRows 复用的 turnHeader 行对象身份。 */
interface SettledRunEnrichment {
  sessionId: string;
  rowCount: number;
  idle: boolean;
  writerConflict: boolean;
  turnRef: RawTurn | undefined;
  isLastTurn: boolean;
  /** 该轮 turnHeader 实际解析到的原生 usage 来源，用于精确失效。 */
  usageRef: unknown;
  reverted: boolean;
  /** 富化时读到的附件投影身份；重投影后身份变化即失效。 */
  attachmentRefs: ReadonlyArray<readonly [string, unknown]>;
  /** [轮内偏移, 替换行]；空数组表示该轮无需改写，命中时零写回。 */
  patches: ReadonlyArray<readonly [number, ConversationRow]>;
  subagentRows: ReadonlyArray<ConversationRow>;
}

interface RowEnrichmentContext {
  sessionId: string;
  idle: boolean;
  writerConflict: boolean;
  lastTurnId: string | undefined;
  turnTokenUsage: Record<string, NativeTurnUsageAccumulator> | undefined;
  threadUsage: unknown;
  userProjections: Map<string, OwnedInputProjection>;
  imageViewFileNames: Map<string, string>;
  rawTurnOf(turnId: string): RawTurn | undefined;
}

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
  /**
   * 同一 (session, epoch, revision, seq, additionalDirectories) 的在途构建合并表。
   * N 个并发订阅者刷新同一版本只做一次逻辑快照构建；键含版本水位，状态替换或 touch 后不会污染新版本。
   */
  private readonly conversationInFlight = new Map<string, Promise<ConversationSnapshot>>();
  /**
   * 已 settled 轮次的富化行缓存：流式 delta 期间按轮复用补丁行，只写回被改写的少数克隆行，
   * 不原地修改 settledTurnRowsCache 的原行，使后处理保持 O(active)。
   */
  private readonly settledRunEnrichments = new WeakMap<ConversationRow, SettledRunEnrichment>();
  /** 子线程活性一次性种子调度（实现见 subagent-activity.ts；tracker 归 store 所有）。 */
  private readonly subagentActivitySeeds: SubagentActivitySeedScheduler;
  private readonly attachmentViews = new Map<
    string,
    { epoch: string; rows: ConversationSnapshot["rows"]["window"] }
  >();
  private readonly revertedTurns = new Map<string, Set<string>>();
  /** 已完成 turn 的附件与图片文件名投影缓存，避免流式期间每帧重跑历史附件解析。 */
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
    const flightKey = [
      id,
      state.epoch,
      state.revision,
      state.seq,
      additionalDirectoriesKey(additionalDirectories),
    ].join("\u0001");
    const inFlight = this.conversationInFlight.get(flightKey);
    // 并发订阅者共享同一次构建；构建内部的 await 期间 state 版本变化不会改写这个 key。
    if (inFlight && process.env.BENCH_NO_MERGE !== "1") return inFlight;
    const pending = this.buildConversation(id, state);
    this.conversationInFlight.set(flightKey, pending);
    if (this.conversationInFlight.size > MAX_CONVERSATION_IN_FLIGHT) {
      const oldest = this.conversationInFlight.keys().next();
      if (!oldest.done && oldest.value !== flightKey)
        this.conversationInFlight.delete(oldest.value);
    }
    try {
      return await pending;
    } finally {
      // 只清理自己登记的那一条：容量淘汰或后续版本覆盖后不能误删别人的在途构建。
      if (this.conversationInFlight.get(flightKey) === pending)
        this.conversationInFlight.delete(flightKey);
    }
  }

  private async buildConversation(
    id: string,
    state: NonNullable<ReturnType<ThreadStateStore["get"]>>,
  ): Promise<ConversationSnapshot> {
    this.conversationCache.delete(id);
    const startSeq = state.seq;
    const startRevision = state.revision;
    const startEpoch = state.epoch;
    const attachmentStore = this.attachments;
    const userProjections = new Map<string, OwnedInputProjection>();
    const queueProjections = new Map<string, OwnedInputProjection>();
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
      // 辅助对话 child：fork 继承的父历史只进模型上下文，不进 UI 投影。
      ...(state.sideChat ? { hiddenTurnIds: state.sideChat.inheritedTurnIds } : {}),
      ...(state.autoApprovalReviews ? { autoApprovalReviews: state.autoApprovalReviews } : {}),
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
    if (this.attachments) {
      for (const queueItem of snapshot.queue.items) {
        const projected = queueProjections.get(queueItem.queueItemId);
        if (!projected) continue;
        queueItem.text = projected.text;
        queueItem.attachments = projected.refs;
      }
    }
    // 行富化按轮进行：已 settled 的轮次命中缓存时只写回被改写的少数行，
    // 同时顺带收集 subagent 行，避免每帧再对整段历史跑一次 subagentsStateFromRows。
    const subagentRows = this.enrichRows(id, snapshot.rows.window, state, {
      idle,
      writerConflict,
      userProjections,
      imageViewFileNames,
    });
    // 子代理下钻（specs/codex-desktop-subagent-drilldown.md）：running/ended 从已投影的
    // subagent 行派生，不额外请求原生；revision 交给 store 记账，语义不变则不递增。
    // 必须在 tail window 截断前用完整 rows 计算，否则旧会话的子代理会从目录里消失；
    // 富化阶段收集的就是完整窗口里的全部 subagent 行（非 subagent 行原本也被跳过）。
    const subagents = subagentsStateFromRows(subagentRows, {
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

  /** 按轮切分窗口并富化：未命中轮次（流式期间即活跃轮）才做克隆与派生计算。 */
  private enrichRows(
    id: string,
    rowsWindow: ConversationRow[],
    state: ThreadProjectionState,
    facts: {
      idle: boolean;
      writerConflict: boolean;
      userProjections: Map<string, OwnedInputProjection>;
      imageViewFileNames: Map<string, string>;
    },
  ): readonly ConversationRow[] {
    const rawTurns = array(state.thread.turns);
    const context: RowEnrichmentContext = {
      sessionId: id,
      idle: facts.idle,
      writerConflict: facts.writerConflict,
      lastTurnId: rawTurnId(rawTurns.at(-1)),
      turnTokenUsage: state.turnTokenUsage,
      threadUsage: state.thread.tokenUsage,
      userProjections: facts.userProjections,
      imageViewFileNames: facts.imageViewFileNames,
      rawTurnOf: this.rawTurnResolver(rawTurns),
    };
    const subagentRows: ConversationRow[] = [];
    let runStart = 0;
    while (runStart < rowsWindow.length) {
      const turnId = rowsWindow[runStart]!.turnId;
      let runEnd = runStart + 1;
      while (runEnd < rowsWindow.length && rowsWindow[runEnd]!.turnId === turnId) runEnd += 1;
      this.enrichRun(rowsWindow, runStart, runEnd, turnId, context, subagentRows);
      runStart = runEnd;
    }
    return subagentRows;
  }

  /** turnId → 原生 turn 的惰性索引：未命中轮次几乎总在尾部，探测失败才建全量索引。 */
  private rawTurnResolver(rawTurns: readonly unknown[]): (turnId: string) => RawTurn | undefined {
    let index: Map<string, RawTurn> | undefined;
    return (turnId) => {
      if (index) return index.get(turnId);
      for (
        let cursor = rawTurns.length - 1, step = 0;
        cursor >= 0 && step < RAW_TURN_TAIL_PROBE;
        cursor -= 1, step += 1
      ) {
        if (rawTurnId(rawTurns[cursor]) === turnId) return rawTurns[cursor] as RawTurn;
      }
      index = new Map();
      for (const candidate of rawTurns) {
        const candidateId = rawTurnId(candidate);
        if (candidateId !== undefined) index.set(candidateId, candidate as RawTurn);
      }
      return index.get(turnId);
    };
  }

  private resolveTurnUsage(
    turnRef: RawTurn | undefined,
    isLastTurn: boolean,
    turnId: string,
    context: RowEnrichmentContext,
  ): unknown {
    // 快照 await 期间若 reload 清空了 turns，lastTurnId 安全降级为不可匹配，避免抛异常使连接崩溃。
    return (
      context.turnTokenUsage?.[turnId] ??
      turnRef?.tokenUsage ??
      (isLastTurn ? context.threadUsage : undefined)
    );
  }

  private resolveAttachmentRef(entityId: string, context: RowEnrichmentContext): unknown {
    return context.userProjections.get(entityId) ?? context.imageViewFileNames.get(entityId);
  }

  private enrichRun(
    rowsWindow: ConversationRow[],
    start: number,
    end: number,
    turnId: string,
    context: RowEnrichmentContext,
    subagentSink: ConversationRow[],
  ): void {
    const rowCount = end - start;
    const baseRow = rowsWindow[start]!;
    // 只有终态轮次的行对象才会被 projectRows 的 settledTurnRowsCache 复用；
    // running 轮次每帧都是新对象，缓存它只会白占 WeakMap 条目。
    const cacheable = baseRow.kind === "turnHeader" && baseRow.state !== "running";
    const isLastTurn = turnId === context.lastTurnId;
    const reverted = this.isFileChangesReverted(context.sessionId, turnId);
    const cached = cacheable ? this.settledRunEnrichments.get(baseRow) : undefined;
    if (
      cached &&
      cached.sessionId === context.sessionId &&
      cached.rowCount === rowCount &&
      cached.idle === context.idle &&
      cached.writerConflict === context.writerConflict &&
      cached.isLastTurn === isLastTurn &&
      cached.reverted === reverted &&
      // turnTokenUsage 记录与 thread.tokenUsage 每次原生事件都整体替换，身份比较即可精确失效；
      // baseRow 身份不变意味着 parsed/raw turn 未变（settledTurnRowsCache 的既有不变量），
      // 因此 turn.tokenUsage 与 fileChanges 的输入也不可能变。
      cached.usageRef ===
        this.resolveTurnUsage(cached.turnRef, cached.isLastTurn, turnId, context) &&
      cached.attachmentRefs.every(
        ([entityId, value]) => this.resolveAttachmentRef(entityId, context) === value,
      )
    ) {
      for (const [offset, row] of cached.patches) rowsWindow[start + offset] = row;
      for (const row of cached.subagentRows) subagentSink.push(row);
      return;
    }
    const rawTurn = context.rawTurnOf(turnId);
    const usageRef = this.resolveTurnUsage(rawTurn, isLastTurn, turnId, context);
    const patches: Array<readonly [number, ConversationRow]> = [];
    const attachmentRefs: Array<readonly [string, unknown]> = [];
    let runSubagents: ConversationRow[] | undefined;
    for (let index = start; index < end; index += 1) {
      const row = rowsWindow[index]!;
      if (row.kind === "subagent") (runSubagents ??= []).push(row);
      const patched = this.enrichRow(row, {
        context,
        rawTurn,
        usageRef,
        reverted,
        attachmentRefs,
      });
      if (patched) patches.push([index - start, patched]);
    }
    if (cacheable) {
      this.settledRunEnrichments.set(baseRow, {
        sessionId: context.sessionId,
        rowCount,
        idle: context.idle,
        writerConflict: context.writerConflict,
        turnRef: rawTurn,
        isLastTurn,
        usageRef,
        reverted,
        attachmentRefs,
        patches,
        subagentRows: runSubagents ?? NO_ROWS,
      });
    }
    for (const [offset, row] of patches) rowsWindow[start + offset] = row;
    if (runSubagents) for (const row of runSubagents) subagentSink.push(row);
  }

  /**
   * 单行富化：返回替换行（克隆体）或 undefined 表示无需改写。
   * 绝不原地修改传入的行——它们可能是 projectRows 的 settledTurnRowsCache 共享对象，
   * 原地写会让 idle 期间挂上的 actions 在切回 busy 后残留。
   */
  private enrichRow(
    row: ConversationRow,
    facts: {
      context: RowEnrichmentContext;
      rawTurn: RawTurn | undefined;
      usageRef: unknown;
      reverted: boolean;
      attachmentRefs: Array<readonly [string, unknown]>;
    },
  ): ConversationRow | undefined {
    const { context, rawTurn, usageRef, reverted, attachmentRefs } = facts;
    let next: ConversationRow | undefined;
    const ensureMutable = (): ConversationRow => (next ??= { ...row });
    if (context.idle && row.kind === "assistantText") {
      ensureMutable().actions = { canFork: true };
    }
    if (context.idle && !context.writerConflict && row.kind === "userInput") {
      ensureMutable().actions = { canEdit: true, canRetry: true, editDisposition: "rewind" };
    }
    if (row.kind === "turnHeader") {
      const turnUsage = sparseNativeTurnUsage(usageRef);
      if (turnUsage) {
        const mutable = ensureMutable() as Extract<ConversationRow, { kind: "turnHeader" }>;
        mutable.turnUsage = turnUsage;
        if (turnUsage.outputTokens !== undefined) {
          mutable.outputTokens = turnUsage.outputTokens;
        }
      }
      if (rawTurn) {
        const filesResult = projectTurnFileChanges(rawTurn, reverted ? "reverted" : "active");
        if (filesResult.files) {
          (ensureMutable() as Extract<ConversationRow, { kind: "turnHeader" }>).fileChanges = {
            files: filesResult.files,
            additions: filesResult.additions,
            deletions: filesResult.deletions,
            state: filesResult.state,
          };
        }
        // 行级撤销入口只描述「该轮存在可投影的文件变更」这一事实；
        // 能力门禁与 Desktop 事务所有者仍在 UI/服务层判定。
        // 运行中的轮次变更不完整，不开放撤销；已撤销的轮次不重复开放。
        if (filesResult.files > 0 && filesResult.state !== "reverted" && row.state !== "running") {
          const mutable = ensureMutable();
          mutable.actions = { ...mutable.actions, canRewindFiles: true };
        }
      }
    }
    if (row.kind === "userInput" && this.attachments) {
      // entityId 仍是 turn 作用域展示键；与预投影后的唯一派生结果对应。
      const entityId = row.entityId ?? "";
      const projected = context.userProjections.get(entityId);
      attachmentRefs.push([entityId, projected]);
      if (projected) {
        const mutable = ensureMutable() as Extract<ConversationRow, { kind: "userInput" }>;
        mutable.text = projected.text;
        mutable.attachments = projected.refs;
      }
    }
    if (row.kind === "toolCall" && row.toolName === "view_image" && this.attachments) {
      const entityId = row.entityId ?? "";
      const fileName = context.imageViewFileNames.get(entityId);
      attachmentRefs.push([entityId, fileName]);
      if (fileName && row.input && typeof row.input === "object" && !Array.isArray(row.input)) {
        const nextInput = { ...(row.input as Record<string, unknown>), fileName };
        const mutable = ensureMutable() as Extract<ConversationRow, { kind: "toolCall" }>;
        mutable.input = nextInput;
        mutable.inputText = JSON.stringify(nextInput);
      }
    }
    return next;
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
