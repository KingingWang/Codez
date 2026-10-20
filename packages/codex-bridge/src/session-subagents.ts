import * as shared from "@codez/shared";
import type { CodexRpcPort } from "./contract.js";
import { codexThreadSchema, type CodexThread } from "./codex-types.js";
import { listChildThreads } from "./child-thread-list.js";
import { sameExecutionPath } from "./execution-path.js";
import { object, string, type JsonObject } from "./json.js";
import {
  collectSubagentFacts,
  SUBAGENT_TYPE_FALLBACK,
  subagentSummaryText,
  subagentTitle,
  type SubagentFact,
} from "./subagent-projection.js";
import type { ThreadStateStore } from "./thread-state.js";

/**
 * 子代理目录（`session/subagents`）：与原生 flavor 同一载荷合同，事实源换成 Codex。
 * 子线程身份来自原生 `thread/list` 的 relation filter（按父线程列子线程），生命周期
 * 终态来自父线程 collab item；两边都没有的事实一律不猜（specs/codex-desktop-subagent-drilldown.md）。
 */

const DEFAULT_ENDED_LIMIT = 20;
const MAX_ENDED_LIMIT = 100;
const CURSOR_PREFIX = "codex-subagents:";

type EndedStatus = "success" | "failed" | "cancelled" | "lost";

function nonEmpty(value: string | null | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : undefined;
}

function firstNonEmpty(values: readonly (string | null | undefined)[]): string | undefined {
  for (const value of values) {
    const trimmed = nonEmpty(value);
    if (trimmed) return trimmed;
  }
  return undefined;
}

/** 父线程没有终态事实时不猜成败：原生目录用 lost 表示「无法解析结果的子会话」。 */
function endedStatusOf(fact: SubagentFact | undefined): EndedStatus {
  return fact && fact.status !== "running" ? fact.status : "lost";
}

function decodeCursor(cursor: unknown): number {
  if (cursor === undefined || cursor === null) return 0;
  const raw = string(cursor, "endedCursor");
  if (!raw.startsWith(CURSOR_PREFIX)) throw new Error("Invalid endedCursor");
  const offset = Number.parseInt(raw.slice(CURSOR_PREFIX.length), 10);
  if (!Number.isSafeInteger(offset) || offset < 0) throw new Error("Invalid endedCursor");
  return offset;
}

function endedLimitOf(value: unknown): number {
  const requested =
    typeof value === "number" && Number.isFinite(value) ? value : DEFAULT_ENDED_LIMIT;
  return Math.min(MAX_ENDED_LIMIT, Math.max(1, Math.trunc(requested)));
}

/** 父线程历史 → 子代理事实；不可解析（例如只回摘要）时返回空表，目录仍按原生状态分类。 */
function parentFacts(
  thread: unknown,
  hiddenTurnIds?: ReadonlySet<string>,
): Map<string, SubagentFact> {
  try {
    const parsed: CodexThread = codexThreadSchema.parse(thread);
    return new Map(
      collectSubagentFacts(parsed, hiddenTurnIds).map((fact) => [fact.childThreadId, fact]),
    );
  } catch {
    return new Map();
  }
}

export async function listSessionSubagents(
  params: JsonObject,
  rpc: CodexRpcPort,
  store: ThreadStateStore,
): Promise<unknown> {
  const sessionId = string(params.sessionId, "sessionId");
  const endedLimit = endedLimitOf(params.endedLimit);
  const offset = decodeCursor(params.endedCursor);
  // 归属校验：子线程只按父线程关系列出，但请求来自 renderer，必须先证明父线程属于本工作区。
  // 已加载则复用其事实（不额外请求，也不触发 resume）；未加载只做一次 lock-free thread/read。
  const parentState = store.get(sessionId);
  const parentThread = parentState
    ? parentState.thread
    : object(object(await rpc.request("thread/read", { threadId: sessionId })).thread);
  if (!(await sameExecutionPath(parentThread.cwd, store.cwd)))
    throw new Error("Workspace mismatch");
  const facts = parentFacts(parentThread, parentState?.sideChat?.inheritedTurnIds);
  const children = await listChildThreads(rpc, sessionId);

  const childSessionIds: string[] = [];
  const running: shared.CodezSessionRunningSubagent[] = [];
  const ended: shared.CodezSessionEndedSubagent[] = [];
  for (const child of children) {
    childSessionIds.push(child.id);
    const fact = facts.get(child.id);
    const summary = fact ? subagentSummaryText(fact) : "";
    const base = {
      childSessionId: child.id,
      ...(fact?.parentToolCallId ? { toolCallId: fact.parentToolCallId } : {}),
      // 原生 thread metadata 的 agentRole/agentNickname 才是子代理真实身份；父侧只有 agentPath。
      subagentType: nonEmpty(child.agentRole) ?? SUBAGENT_TYPE_FALLBACK,
      title:
        firstNonEmpty([
          child.name,
          child.agentNickname,
          child.agentRole,
          fact ? subagentTitle(fact) : undefined,
          child.preview,
        ]) ?? child.id,
      ...(summary ? { summary } : {}),
      startedAt: Math.round(child.createdAt * 1000),
    };
    if (child.status.type === "active") running.push({ ...base, status: "running" });
    else
      ended.push({
        ...base,
        status: endedStatusOf(fact),
        endedAt: Math.round(child.updatedAt * 1000),
      });
  }
  // 原生目录把新完成项插在顶部；按 endedAt 倒序后 bridge 侧分页，total 是精确已结束数。
  ended.sort((left, right) => (right.endedAt ?? 0) - (left.endedAt ?? 0));
  const items = ended.slice(offset, offset + endedLimit);
  const nextOffset = offset + endedLimit;
  return shared.codezSessionSubagentsResultSchema.parse({
    revision: parentState?.revision ?? 0,
    childSessionIds,
    running,
    ended: {
      total: ended.length,
      items,
      ...(nextOffset < ended.length ? { nextCursor: `${CURSOR_PREFIX}${nextOffset}` } : {}),
    },
  });
}
