// Codex 原生 SQLite 读取的纯 SQL 计划与行映射（从 codex-app-usage-store.ts 拆出，无副作用）。
//
// 拆出原因：usage-store 同时承载 DB 行缓存、rollout 解析缓存、worker 读取器与聚合，
// 行数已顶到 oxlint max-lines 上限；这里只放纯函数与 SQL 常量，便于会话数据删除预检
// （specs/codex-session-data-purge.md）复用同一套「参数上限 / 时间戳归一」口径而不复制它。

/** 单条 SQL 的绑定参数上限（SQLite 默认 999），留余量分批。 */
export const SQLITE_MAX_QUERY_PARAMS = 900;

export interface ThreadRow {
  id: string;
  model: string | null;
  tokensUsed: number;
  createdAtMs: number;
  updatedAtMs: number;
  rolloutPath: string;
}

export interface TurnRecord {
  threadId: string;
  startedAtMs: number;
  durationMs: number;
}

export interface SqlQueryPlan {
  sql: string;
  params: Array<string | number>;
}

export function nonNegInt(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.trunc(value) : 0;
}

export function normalizeModelId(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

const THREAD_ROWS_SELECT_SQL = `SELECT id, model, tokens_used, created_at, created_at_ms, updated_at, updated_at_ms, rollout_path
           FROM threads`;
const TURN_ROWS_SELECT_SQL = `SELECT thread_id, started_at, completed_at, duration_ms
           FROM thread_turns`;
// 时间戳归一必须与 JS 侧 nonNegInt 语义严格一致（NULL / 负数 / 0 都退到下一档），
// 否则「全表缓存命中后内存过滤」与「SQL WHERE 下推」两条路径会选出不同的线程集合。
const THREAD_CREATED_MS_SQL = `CASE
             WHEN COALESCE(created_at_ms, 0) > 0 THEN created_at_ms
             WHEN COALESCE(created_at, 0) > 0 THEN COALESCE(created_at, 0) * 1000
             ELSE 0
           END`;
const THREAD_UPDATED_MS_SQL = `CASE
             WHEN COALESCE(updated_at_ms, 0) > 0 THEN updated_at_ms
             WHEN COALESCE(updated_at, 0) > 0 THEN COALESCE(updated_at, 0) * 1000
             ELSE ${THREAD_CREATED_MS_SQL}
           END`;
const THREAD_LATEST_MS_SQL = `MAX(${THREAD_CREATED_MS_SQL}, ${THREAD_UPDATED_MS_SQL})`;
// started_at 归一：秒级时间戳折算成毫秒，阈值与 JS 侧 10_000_000_000 一致
const TURN_STARTED_MS_SQL = `CASE WHEN started_at > 10000000000 THEN started_at ELSE started_at * 1000 END`;

export function buildThreadRowsQuery(
  sinceMs: number,
  activeThreadIds?: ReadonlySet<string>,
): SqlQueryPlan {
  if (sinceMs <= 0) return { sql: THREAD_ROWS_SELECT_SQL, params: [] };
  // 判定与聚合侧的候选线程规则一致：时间戳未知（<=0）保守保留；窗口内有 turn 的线程即使
  // threads.updated_at 陈旧也要保留。目的是不把成千上万条明显早于窗口的历史线程行读进内存，
  // 更重要的是不为它们读 rollout 文件。
  const conditions = [`${THREAD_LATEST_MS_SQL} <= 0`, `${THREAD_LATEST_MS_SQL} >= ?`];
  const params: Array<string | number> = [sinceMs];
  const ids = activeThreadIds ? [...activeThreadIds].filter((id) => id.length > 0) : [];
  for (let start = 0; start < ids.length; start += SQLITE_MAX_QUERY_PARAMS) {
    const chunk = ids.slice(start, start + SQLITE_MAX_QUERY_PARAMS);
    conditions.push(`id IN (${chunk.map(() => "?").join(", ")})`);
    params.push(...chunk);
  }
  return { sql: `${THREAD_ROWS_SELECT_SQL} WHERE ${conditions.join(" OR ")}`, params };
}

export function buildTurnRowsQuery(sinceMs: number, untilMs: number): SqlQueryPlan {
  if (sinceMs <= 0) return { sql: TURN_ROWS_SELECT_SQL, params: [] };
  const conditions = ["started_at > 0", `${TURN_STARTED_MS_SQL} >= ?`];
  const params: Array<string | number> = [sinceMs];
  if (untilMs > 0) {
    conditions.push(`${TURN_STARTED_MS_SQL} <= ?`);
    params.push(untilMs);
  }
  return { sql: `${TURN_ROWS_SELECT_SQL} WHERE ${conditions.join(" AND ")}`, params };
}

export function mapThreadRow(row: Record<string, unknown>): ThreadRow {
  const createdAtSec = nonNegInt(row.created_at);
  const updatedAtSec = nonNegInt(row.updated_at);
  const createdAtMs = nonNegInt(row.created_at_ms) || createdAtSec * 1000;
  const updatedAtMs = nonNegInt(row.updated_at_ms) || updatedAtSec * 1000 || createdAtMs;
  return {
    id: String(row.id ?? ""),
    model: normalizeModelId(row.model),
    tokensUsed: nonNegInt(row.tokens_used),
    createdAtMs,
    updatedAtMs,
    rolloutPath: typeof row.rollout_path === "string" ? row.rollout_path.trim() : "",
  };
}

export function mapTurnRow(row: Record<string, unknown>): TurnRecord {
  const startedAtRaw = nonNegInt(row.started_at);
  return {
    threadId: String(row.thread_id ?? ""),
    startedAtMs: startedAtRaw > 10_000_000_000 ? startedAtRaw : startedAtRaw * 1000,
    durationMs: nonNegInt(row.duration_ms),
  };
}

export function filterCachedThreadRows(
  rows: ThreadRow[],
  sinceMs: number,
  activeThreadIds?: ReadonlySet<string>,
): ThreadRow[] {
  if (sinceMs <= 0) return rows;
  return rows.filter((row) => {
    const latestMs = Math.max(row.createdAtMs, row.updatedAtMs);
    if (latestMs <= 0 || latestMs >= sinceMs) return true;
    return activeThreadIds ? activeThreadIds.has(row.id) : false;
  });
}

export function filterCachedTurnRows(
  rows: TurnRecord[],
  sinceMs: number,
  untilMs: number,
): TurnRecord[] {
  if (sinceMs <= 0) return rows;
  return rows.filter(
    (row) => row.startedAtMs >= sinceMs && (untilMs <= 0 || row.startedAtMs <= untilMs),
  );
}
