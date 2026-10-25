import * as shared from "@codez/shared";
import type { CodexRpcPort } from "./contract.js";
import type { CodexThread } from "./codex-types.js";
import { listChildThreads } from "./child-thread-list.js";
import { parseCodexThreadIncremental } from "./projection.js";
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
/** 目录缓存的有界 LRU 上限：覆盖同时打开的父会话数，超出即淘汰最久未用的一条。 */
const CATALOG_CACHE_LIMIT = 64;

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
    // 增量校验：settled turn 复用 parseCodexTurnCached 的 turn 级 WeakMap，避免目录每次
    // 查询（含 endedCursor 翻页）都对整棵父线程历史重跑 Zod。
    const parsed: CodexThread = parseCodexThreadIncremental(thread);
    return new Map(
      collectSubagentFacts(parsed, hiddenTurnIds).map((fact) => [fact.childThreadId, fact]),
    );
  } catch {
    return new Map();
  }
}

interface SubagentCatalog {
  childSessionIds: string[];
  running: shared.CodezSessionRunningSubagent[];
  /** 已按 endedAt 倒序排好的完整列表；分页只做 slice，不重复排序。 */
  ended: shared.CodezSessionEndedSubagent[];
}

interface SubagentCatalogEntry extends SubagentCatalog {
  epoch: string;
  revision: number;
  /** 辅助对话裁剪边界按引用核对：load 重建边界后必须重算父事实。 */
  hiddenTurnIds: ReadonlySet<string> | undefined;
  facts: Map<string, SubagentFact>;
  childSignature: string;
}

/**
 * 目录缓存（specs/codex-desktop-subagent-drilldown.md「缓存与退避」）。
 * 原因：`session/subagents` 会被状态面板与子代理目录反复调用（含 endedCursor 逐页），
 * 每次都重解析整棵父线程历史并重跑 collectSubagentFacts + 排序，长会话下成本正比于全史。
 * 键是父线程自己的水位 (sessionId, epoch, revision)——ThreadStateStore 每次原生事件都
 * touch（revision+1），重连/重放历史换 epoch；子线程侧的事实每次都从 thread/list 重新取，
 * 用签名核对，所以缓存绝不会掩盖子线程状态变化，也不会跳过归属校验。
 */
const catalogCache = new Map<string, SubagentCatalogEntry>();

function catalogKey(sessionId: string, epoch: string, revision: number): string {
  return `${sessionId}\u0000${epoch}\u0000${revision}`;
}

function rememberCatalog(key: string, entry: SubagentCatalogEntry): void {
  catalogCache.delete(key);
  catalogCache.set(key, entry);
  while (catalogCache.size > CATALOG_CACHE_LIMIT) {
    const oldest = catalogCache.keys().next();
    if (oldest.done) break;
    catalogCache.delete(oldest.value);
  }
}

/** 子线程状态签名：目录用到的每个原生事实都进签名，任一变化都必须重新分类。 */
function childSignatureOf(children: readonly CodexThread[]): string {
  return children
    .map((child) =>
      [
        child.id,
        child.status.type,
        child.createdAt,
        child.updatedAt,
        child.name ?? "",
        child.agentNickname ?? "",
        child.agentRole ?? "",
        child.preview,
      ].join("\u0001"),
    )
    .join("\u0002");
}

function buildCatalog(
  facts: ReadonlyMap<string, SubagentFact>,
  children: readonly CodexThread[],
): SubagentCatalog {
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
  return { childSessionIds, running, ended };
}

/** 父线程已加载时按水位复用父事实与已聚合目录；未加载没有水位，直接现算不入缓存。 */
function cachedCatalog(input: {
  sessionId: string;
  epoch: string;
  revision: number;
  hiddenTurnIds: ReadonlySet<string> | undefined;
  parentThread: unknown;
  children: CodexThread[];
}): SubagentCatalog {
  const key = catalogKey(input.sessionId, input.epoch, input.revision);
  const childSignature = childSignatureOf(input.children);
  const cached = catalogCache.get(key);
  if (
    cached &&
    // 水位随条目一起核对：键是拼接字符串，条目自带身份才能杜绝任何形式的键碰撞。
    cached.epoch === input.epoch &&
    cached.revision === input.revision &&
    cached.hiddenTurnIds === input.hiddenTurnIds
  ) {
    catalogCache.delete(key);
    catalogCache.set(key, cached);
    if (cached.childSignature === childSignature) return cached;
    // 父线程水位未变、子线程事实变了：父事实仍可复用，只重跑分类与排序。
    const rebuilt: SubagentCatalogEntry = {
      ...cached,
      childSignature,
      ...buildCatalog(cached.facts, input.children),
    };
    rememberCatalog(key, rebuilt);
    return rebuilt;
  }
  const facts = parentFacts(input.parentThread, input.hiddenTurnIds);
  const entry: SubagentCatalogEntry = {
    epoch: input.epoch,
    revision: input.revision,
    hiddenTurnIds: input.hiddenTurnIds,
    facts,
    childSignature,
    ...buildCatalog(facts, input.children),
  };
  rememberCatalog(key, entry);
  return entry;
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
  // 水位与线程引用必须在 await 之前一起取：thread/list 往返期间可能有原生事件落地并
  // touch（revision+1），用旧线程内容配新 revision 会把过期目录记到「未来」水位上，
  // 让后续查询在真正失效前一直读到它。revision 单调递增，所以提前取的水位最坏只是白记一条。
  const watermark = parentState
    ? {
        epoch: parentState.epoch,
        revision: parentState.revision,
        hiddenTurnIds: parentState.sideChat?.inheritedTurnIds,
      }
    : undefined;
  // 归属与权限判定每次调用都跑：缓存只省派生工作，绝不省校验。
  if (!(await sameExecutionPath(parentThread.cwd, store.cwd)))
    throw new Error("Workspace mismatch");
  const children = await listChildThreads(rpc, sessionId);
  const catalog = watermark
    ? cachedCatalog({
        sessionId,
        ...watermark,
        parentThread,
        children,
      })
    : buildCatalog(parentFacts(parentThread, undefined), children);
  const items = catalog.ended.slice(offset, offset + endedLimit);
  const nextOffset = offset + endedLimit;
  return shared.codezSessionSubagentsResultSchema.parse({
    revision: parentState?.revision ?? 0,
    childSessionIds: catalog.childSessionIds,
    running: catalog.running,
    ended: {
      total: catalog.ended.length,
      items,
      ...(nextOffset < catalog.ended.length ? { nextCursor: `${CURSOR_PREFIX}${nextOffset}` } : {}),
    },
  });
}
