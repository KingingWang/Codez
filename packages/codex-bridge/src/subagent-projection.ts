import type {
  BackgroundWorkSummary,
  ConversationRow,
  SubagentProjectionState,
} from "@codez/shared/codez-protocol-v4";
import { isCodexKnownItem, type CodexThread, type CodexTurn } from "./codex-types.js";
import type { RowBase } from "./projection-item-extras.js";

/**
 * 子代理下钻的父侧事实聚合（specs/codex-desktop-subagent-drilldown.md）。
 * 事实源只有父线程自己的 collab item：bridge 不为投影额外请求原生，也不猜
 * 子线程状态。子线程的真实 nickname/role/时间戳只在打开子会话或查目录时读取。
 */

/** 父线程 item 不含 agent_type；与原生缺 agentType 时同一 fallback，不伪造类型。 */
export const SUBAGENT_TYPE_FALLBACK = "subagent";

/** `thread/list` 的 sourceKinds：只有这些来源是子代理线程（交互式来源不含子线程）。 */
export const SUBAGENT_THREAD_SOURCE_KINDS = [
  "subAgent",
  "subAgentReview",
  "subAgentCompact",
  "subAgentThreadSpawn",
  "subAgentOther",
] as const;

export type SubagentStatus = "running" | "success" | "failed" | "cancelled";

export interface SubagentFact {
  childThreadId: string;
  /** spawn collab item id；历史里只有 activity 时缺失，UI 走 legacy 同 turn 配对。 */
  parentToolCallId?: string;
  agentPath?: string;
  prompt?: string;
  status: SubagentStatus;
  /** 行锚点：spawn item 优先，否则首个 activity item。 */
  turnId: string;
  anchorItemId: string;
  /** 锚定 turn 的 startedAt（同 turn 内的近似下界）；原生 item 无逐项时间戳。 */
  startedAt?: number;
}

const SUMMARY_MAX_CHARS = 200;
const TITLE_MAX_CHARS = 80;

interface Pending extends Omit<SubagentFact, "status"> {
  /** subAgentActivity 的终态：生命周期权威，优先于 agentsStates。 */
  activityStatus?: SubagentStatus;
  /** agentsStates 的最后一次有效观测；notFound 不覆盖已有事实。 */
  statesStatus?: SubagentStatus;
}

function statesStatusOf(status: string): SubagentStatus | undefined {
  switch (status) {
    case "completed":
      return "success";
    case "errored":
      return "failed";
    case "interrupted":
    case "shutdown":
      return "cancelled";
    case "pendingInit":
    case "running":
      return "running";
    default:
      // notFound 与未来新增取值：无信息，不覆盖已有观测。
      return undefined;
  }
}

function firstLine(text: string | undefined, max: number): string | undefined {
  const line = text
    ?.split("\n")
    .map((part) => part.trim())
    .find((part) => part.length > 0);
  if (!line) return undefined;
  return line.length <= max ? line : `${line.slice(0, max)}…`;
}

/** 行摘要：spawn prompt 首个非空行，其次 agentPath；都没有则空串（schema 允许）。 */
export function subagentSummaryText(fact: SubagentFact): string {
  return (
    firstLine(fact.prompt, SUMMARY_MAX_CHARS) ?? firstLine(fact.agentPath, SUMMARY_MAX_CHARS) ?? ""
  );
}

/** 状态面板/目录标题：agentPath 是原生给的身份串，比 prompt 更适合当标题。 */
export function subagentTitle(fact: SubagentFact): string {
  return (
    firstLine(fact.agentPath, TITLE_MAX_CHARS) ??
    firstLine(fact.prompt, TITLE_MAX_CHARS) ??
    fact.childThreadId
  );
}

/**
 * 单轮 subagent 事实的轻量操作条目（op）。
 *
 * 原因：`collectSubagentFacts` 以前每条流式 delta 都要重扫全部历史 turn 的全部 item
 * （1 万轮 × 4 item ≈ 4 万次类型判定），而历史里绝大多数轮次根本没有 subagent item。
 * 这里把「按 item 提取」与「按线程聚合」拆开：settled turn 的提取结果按 turn 引用缓存
 * （普通轮次是空数组 `[]`），线程级聚合状态按 settled 前缀增量维护，
 * 每条 delta 只做引用校验 + 重放末尾活动轮，成本与活动轮大小相关而不是全史。
 */
type SubagentOp =
  | {
      kind: "spawn";
      childThreadId: string;
      turnId: string;
      anchorItemId: string;
      startedAt: number;
      /** 并发 spawn 的多个 receiver 共享同一 item；prompt 只在唯一 receiver 时归属明确。 */
      prompt: string | undefined;
    }
  | {
      kind: "states";
      childThreadId: string;
      turnId: string;
      anchorItemId: string;
      startedAt: number;
      status: SubagentStatus;
    }
  | {
      kind: "activity";
      childThreadId: string;
      turnId: string;
      anchorItemId: string;
      startedAt: number;
      agentPath: string | undefined;
      activityStatus: SubagentStatus | undefined;
    };

const turnSubagentOpsCache = new WeakMap<
  CodexTurn,
  {
    itemsRef: CodexTurn["items"];
    itemsLength: number;
    /** startedAt 回退到 thread.createdAt，所以 createdAt 变化必须让缓存失效。 */
    threadCreatedAt: number;
    ops: SubagentOp[];
  }
>();

/** 与旧实现逐 item 等价的提取：顺序即 item 顺序，重放后 pending 插入顺序不变。 */
function extractSubagentOps(turn: CodexTurn, startedAt: number): SubagentOp[] {
  const ops: SubagentOp[] = [];
  for (const item of turn.items) {
    if (!isCodexKnownItem(item)) continue;
    if (item.type === "collabAgentToolCall") {
      if (item.tool === "spawnAgent") {
        const prompt = item.prompt && item.receiverThreadIds.length === 1 ? item.prompt : undefined;
        for (const childThreadId of item.receiverThreadIds) {
          ops.push({
            kind: "spawn",
            childThreadId,
            turnId: turn.id,
            anchorItemId: item.id,
            startedAt,
            prompt,
          });
        }
      }
      for (const [childThreadId, state] of Object.entries(item.agentsStates)) {
        const status = statesStatusOf(state.status);
        if (status === undefined) continue;
        ops.push({
          kind: "states",
          childThreadId,
          turnId: turn.id,
          anchorItemId: item.id,
          startedAt,
          status,
        });
      }
      continue;
    }
    if (item.type !== "subAgentActivity") continue;
    ops.push({
      kind: "activity",
      childThreadId: item.agentThreadId,
      turnId: turn.id,
      anchorItemId: item.id,
      startedAt,
      agentPath: item.agentPath || undefined,
      activityStatus:
        item.kind === "completed"
          ? "success"
          : item.kind === "interrupted"
            ? "cancelled"
            : undefined,
    });
  }
  return ops;
}

/**
 * settled turn 的 op 按 turn 引用缓存；活动轮每次重取——原生 `item/completed` 会原位
 * 替换 `items[index]`（数组引用与长度都不变），缓存活动轮会漏掉 agentsStates 的终态收敛。
 */
function subagentOpsOf(turn: CodexTurn, threadCreatedAt: number): SubagentOp[] {
  const startedAt = (turn.startedAt ?? threadCreatedAt) * 1000;
  if (turn.status === "inProgress") return extractSubagentOps(turn, startedAt);
  const cached = turnSubagentOpsCache.get(turn);
  if (
    cached &&
    cached.itemsRef === turn.items &&
    cached.itemsLength === turn.items.length &&
    cached.threadCreatedAt === threadCreatedAt
  ) {
    return cached.ops;
  }
  const ops = extractSubagentOps(turn, startedAt);
  turnSubagentOpsCache.set(turn, {
    itemsRef: turn.items,
    itemsLength: turn.items.length,
    threadCreatedAt,
    ops,
  });
  return ops;
}

function ensurePending(
  pending: Map<string, Pending>,
  childThreadId: string,
  turnId: string,
  anchorItemId: string,
  startedAt: number,
): Pending {
  const existing = pending.get(childThreadId);
  if (existing) return existing;
  const created: Pending = { childThreadId, turnId, anchorItemId, startedAt };
  pending.set(childThreadId, created);
  return created;
}

function replayOps(pending: Map<string, Pending>, ops: readonly SubagentOp[]): void {
  for (const op of ops) {
    const fact = ensurePending(pending, op.childThreadId, op.turnId, op.anchorItemId, op.startedAt);
    if (op.kind === "spawn") {
      if (op.prompt && !fact.prompt) fact.prompt = op.prompt;
      if (!fact.parentToolCallId) fact.parentToolCallId = op.anchorItemId;
      continue;
    }
    if (op.kind === "states") {
      fact.statesStatus = op.status;
      continue;
    }
    if (op.agentPath && !fact.agentPath) fact.agentPath = op.agentPath;
    if (op.activityStatus) fact.activityStatus = op.activityStatus;
  }
}

/** 尾部重放不能污染前缀聚合状态：Pending 全是标量，浅拷贝即可。 */
function clonePending(pending: Map<string, Pending>): Map<string, Pending> {
  const clone = new Map<string, Pending>();
  for (const [childThreadId, value] of pending) clone.set(childThreadId, { ...value });
  return clone;
}

function factsOf(pending: Map<string, Pending>): SubagentFact[] {
  return [...pending.values()].map(({ activityStatus, statesStatus, ...fact }) => ({
    ...fact,
    status: activityStatus ?? statesStatus ?? "running",
  }));
}

/** 事实内容未变时复用旧数组引用，让下游（行前缀缓存）继续命中。 */
function sameFacts(left: readonly SubagentFact[], right: readonly SubagentFact[]): boolean {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) {
    const a = left[index]!;
    const b = right[index]!;
    if (
      a.childThreadId !== b.childThreadId ||
      a.status !== b.status ||
      a.turnId !== b.turnId ||
      a.anchorItemId !== b.anchorItemId ||
      a.parentToolCallId !== b.parentToolCallId ||
      a.agentPath !== b.agentPath ||
      a.prompt !== b.prompt ||
      a.startedAt !== b.startedAt
    ) {
      return false;
    }
  }
  return true;
}

export interface SubagentAggregate {
  facts: SubagentFact[];
  anchors: Map<string, Map<string, SubagentFact[]>>;
}

interface SubagentAggregateCache extends SubagentAggregate {
  threadCreatedAt: number;
  hiddenTurnIds: ReadonlySet<string> | undefined;
  /** 已聚合进 pending 的 settled 前缀；引用与 items 长度用于逐轮校验。 */
  turnRefs: CodexTurn[];
  itemsRefs: CodexTurn["items"][];
  itemsLengths: number[];
  pending: Map<string, Pending>;
}

/**
 * 线程级聚合缓存，按「首个可见 turn」弱引用分桶（同时投影父会话与子代理下钻时互不挤占），
 * 按前缀校验自愈。所有派生事实仍由父线程 item 决定，缓存只是避免每条 delta 重扫全史；
 * 前缀被改写（rewind / 历史替换）时按 op 缓存重放。
 */
const aggregateCaches = new WeakMap<object, SubagentAggregateCache>();

/**
 * 聚合父线程全部 collab 事实并给出行锚点索引；两者引用同步失效，
 * 让 projection-rows 用「anchors 引用是否变化」判定子代理终态是否收敛。
 */
export function collectSubagentAggregate(
  thread: CodexThread,
  hiddenTurnIds?: ReadonlySet<string>,
): SubagentAggregate {
  const turns = hiddenTurnIds?.size
    ? thread.turns.filter((turn) => !hiddenTurnIds.has(turn.id))
    : thread.turns;
  const cacheKey = turns[0];
  const cached = cacheKey ? aggregateCaches.get(cacheKey) : undefined;
  const prefixUsable =
    cached !== undefined &&
    cached.threadCreatedAt === thread.createdAt &&
    cached.hiddenTurnIds === hiddenTurnIds;
  let reuse = 0;
  if (prefixUsable) {
    const limit = Math.min(cached!.turnRefs.length, turns.length);
    while (reuse < limit) {
      const turn = turns[reuse]!;
      if (
        turn !== cached!.turnRefs[reuse] ||
        turn.items !== cached!.itemsRefs[reuse] ||
        turn.items.length !== cached!.itemsLengths[reuse]!
      ) {
        break;
      }
      reuse += 1;
    }
  }
  const entry = prefixUsable && reuse === cached!.turnRefs.length ? cached : undefined;
  // 前缀只收连续 settled 轮：活动轮及其后的轮次每次重放（原生会原位改写活动轮 item）。
  let prefixLength = reuse;
  while (prefixLength < turns.length && turns[prefixLength]!.status !== "inProgress")
    prefixLength += 1;
  const pending = entry ? entry.pending : new Map<string, Pending>();
  const turnRefs = entry ? entry.turnRefs : [];
  const itemsRefs = entry ? entry.itemsRefs : [];
  const itemsLengths = entry ? entry.itemsLengths : [];
  for (let index = entry ? reuse : 0; index < prefixLength; index += 1) {
    const turn = turns[index]!;
    replayOps(pending, subagentOpsOf(turn, thread.createdAt));
    turnRefs.push(turn);
    itemsRefs.push(turn.items);
    itemsLengths.push(turn.items.length);
  }
  const tail = prefixLength === turns.length ? pending : clonePending(pending);
  for (let index = prefixLength; index < turns.length; index += 1)
    replayOps(tail, subagentOpsOf(turns[index]!, thread.createdAt));
  const facts = factsOf(tail);
  // 内容未变则保持 facts/anchors 引用稳定：流式期间行前缀缓存与每轮行缓存据此继续命中。
  if (entry && sameFacts(entry.facts, facts)) return entry;
  const anchors = subagentRowAnchors(facts);
  const next: SubagentAggregateCache = entry ?? {
    threadCreatedAt: thread.createdAt,
    hiddenTurnIds,
    turnRefs,
    itemsRefs,
    itemsLengths,
    pending,
    facts,
    anchors,
  };
  next.threadCreatedAt = thread.createdAt;
  next.hiddenTurnIds = hiddenTurnIds;
  next.pending = pending;
  next.facts = facts;
  next.anchors = anchors;
  if (cacheKey) aggregateCaches.set(cacheKey, next);
  return next;
}

/** 按 childThreadId 聚合父线程全部 collab 事实；顺序即父线程历史顺序。 */
export function collectSubagentFacts(
  thread: CodexThread,
  hiddenTurnIds?: ReadonlySet<string>,
): SubagentFact[] {
  return collectSubagentAggregate(thread, hiddenTurnIds).facts;
}

/** 行锚点索引：projection-rows 在锚点 item 行之后紧跟插入 subagent 行。 */
export function subagentRowAnchors(
  facts: readonly SubagentFact[],
): Map<string, Map<string, SubagentFact[]>> {
  const anchors = new Map<string, Map<string, SubagentFact[]>>();
  for (const fact of facts) {
    let byItem = anchors.get(fact.turnId);
    if (!byItem) {
      byItem = new Map<string, SubagentFact[]>();
      anchors.set(fact.turnId, byItem);
    }
    const bucket = byItem.get(fact.anchorItemId);
    if (bucket) bucket.push(fact);
    else byItem.set(fact.anchorItemId, [fact]);
  }
  return anchors;
}

/** 供单轮投影缓存比对：当子代理终态在后续轮次收敛时，锚定轮的签名变化并刷新缓存。 */
export function turnSubagentSignature(
  turnAnchors: ReadonlyMap<string, readonly SubagentFact[]> | undefined,
): string {
  if (!turnAnchors || turnAnchors.size === 0) return "";
  const parts: string[] = [];
  for (const [itemId, facts] of turnAnchors) {
    for (const fact of facts) {
      parts.push(
        `${itemId}:${fact.childThreadId}:${fact.status}:${fact.parentToolCallId ?? ""}:${fact.agentPath ?? ""}:${fact.prompt ?? ""}`,
      );
    }
  }
  return parts.join("\u0001");
}

/** 子代理行：与原生 subagentRowSchema 同形，childSessionId 即子线程 id。 */
export function subagentRow(fact: SubagentFact, base: RowBase): ConversationRow {
  return {
    ...base,
    kind: "subagent",
    ...(fact.parentToolCallId ? { parentToolCallId: fact.parentToolCallId } : {}),
    subagentType: SUBAGENT_TYPE_FALLBACK,
    status: fact.status,
    summaryText: subagentSummaryText(fact),
    childSessionId: fact.childThreadId,
    ...(fact.startedAt === undefined ? {} : { startedAt: fact.startedAt }),
  };
}

export function subagentEntityId(childThreadId: string): string {
  return `codex:subagent:${encodeURIComponent(childThreadId)}`;
}

/** snapshot.subagents 的语义部分；revision 由 ThreadStateStore 记账（单一所有者）。 */
export type SubagentsSemanticState = Omit<SubagentProjectionState, "revision">;

/** #32：同一 running 投影派生 Stop 身份，不新建执行状态、不声称原生已 backgrounded。 */
export function subagentBackgroundWorks(
  running: SubagentsSemanticState["running"],
  createdAt: number,
  cancellable: boolean,
): BackgroundWorkSummary[] {
  return running.map((child) => ({
    workId: child.childSessionId,
    kind: "subagent",
    title: child.title,
    status: "running",
    startedAt: child.startedAt ?? createdAt * 1000,
    cancellable,
    anchorRowId: null,
    childSessionId: child.childSessionId,
  }));
}

/**
 * 从已投影的 subagent 行派生会话级子代理态（不再回读原生，避免重复解析整段历史）。
 * `isChildActive` 只用于收敛假阳性：bridge 已持有该子线程且原生明确非 active 时，
 * 父线程还没有终态事实也不继续报「运行中」；返回 undefined 表示无观测，保持父侧事实。
 */
export function subagentsStateFromRows(
  rows: readonly ConversationRow[],
  options: { isChildActive?: (childThreadId: string) => boolean | undefined } = {},
): SubagentsSemanticState {
  const childSessionIds: string[] = [];
  const seen = new Set<string>();
  const running: SubagentsSemanticState["running"] = [];
  for (const row of rows) {
    if (row.kind !== "subagent" || !row.childSessionId) continue;
    if (!seen.has(row.childSessionId)) {
      seen.add(row.childSessionId);
      childSessionIds.push(row.childSessionId);
    }
    if (row.status !== "running") continue;
    if (options.isChildActive?.(row.childSessionId) === false) continue;
    running.push({
      childSessionId: row.childSessionId,
      ...(row.parentToolCallId ? { toolCallId: row.parentToolCallId } : {}),
      subagentType: row.subagentType || SUBAGENT_TYPE_FALLBACK,
      title: firstLine(row.summaryText, TITLE_MAX_CHARS) ?? row.childSessionId,
      status: "running",
      ...(row.startedAt === undefined ? {} : { startedAt: row.startedAt }),
    });
  }
  return {
    childSessionIds,
    running,
    endedTotal: Math.max(0, childSessionIds.length - running.length),
  };
}
