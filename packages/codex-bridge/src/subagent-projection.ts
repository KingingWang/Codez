import type { ConversationRow, SubagentProjectionState } from "@codez/shared/codez-protocol-v4";
import { isCodexKnownItem, type CodexThread } from "./codex-types.js";
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

/** 按 childThreadId 聚合父线程全部 collab 事实；顺序即父线程历史顺序。 */
export function collectSubagentFacts(
  thread: CodexThread,
  hiddenTurnIds?: ReadonlySet<string>,
): SubagentFact[] {
  const pending = new Map<string, Pending>();
  const ensure = (
    childThreadId: string,
    turnId: string,
    anchorItemId: string,
    startedAt: number | undefined,
  ): Pending => {
    const existing = pending.get(childThreadId);
    if (existing) return existing;
    const created: Pending = {
      childThreadId,
      turnId,
      anchorItemId,
      ...(startedAt === undefined ? {} : { startedAt }),
    };
    pending.set(childThreadId, created);
    return created;
  };
  const turns = hiddenTurnIds?.size
    ? thread.turns.filter((turn) => !hiddenTurnIds.has(turn.id))
    : thread.turns;
  for (const turn of turns) {
    const startedAt = (turn.startedAt ?? thread.createdAt) * 1000;
    for (const item of turn.items) {
      if (!isCodexKnownItem(item)) continue;
      if (item.type === "collabAgentToolCall") {
        if (item.tool === "spawnAgent") {
          for (const childThreadId of item.receiverThreadIds) {
            const fact = ensure(childThreadId, turn.id, item.id, startedAt);
            // 并发 spawn 的多个 receiver 共享同一 item；prompt 只在唯一 receiver 时归属明确。
            if (item.prompt && item.receiverThreadIds.length === 1 && !fact.prompt)
              fact.prompt = item.prompt;
            if (!fact.parentToolCallId) fact.parentToolCallId = item.id;
          }
        }
        for (const [childThreadId, state] of Object.entries(item.agentsStates)) {
          const status = statesStatusOf(state.status);
          if (status === undefined) continue;
          ensure(childThreadId, turn.id, item.id, startedAt).statesStatus = status;
        }
        continue;
      }
      if (item.type !== "subAgentActivity") continue;
      const fact = ensure(item.agentThreadId, turn.id, item.id, startedAt);
      if (item.agentPath && !fact.agentPath) fact.agentPath = item.agentPath;
      if (item.kind === "completed") fact.activityStatus = "success";
      else if (item.kind === "interrupted") fact.activityStatus = "cancelled";
    }
  }
  return [...pending.values()].map(({ activityStatus, statesStatus, ...fact }) => ({
    ...fact,
    status: activityStatus ?? statesStatus ?? "running",
  }));
}

/** 行锚点索引：projection-rows 在锚点 item 行之后紧跟插入 subagent 行。 */
export function subagentRowAnchors(facts: readonly SubagentFact[]): Map<string, SubagentFact[]> {
  const anchors = new Map<string, SubagentFact[]>();
  for (const fact of facts) {
    const key = `${fact.turnId}\u0000${fact.anchorItemId}`;
    const bucket = anchors.get(key);
    if (bucket) bucket.push(fact);
    else anchors.set(key, [fact]);
  }
  return anchors;
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
