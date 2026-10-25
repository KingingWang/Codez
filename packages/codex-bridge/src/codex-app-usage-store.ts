import { statSync } from "node:fs";
import { open, readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { StringDecoder } from "node:string_decoder";
import { Worker } from "node:worker_threads";

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export interface TokenBreakdown {
  totalTokens: number;
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  requestCount: number;
}

export interface UsageEventSample extends TokenBreakdown {
  timestampMs: number;
  modelId: string | null;
}

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
/** DB 文件指纹：主库 `mtimeMs`/`size` 叠加 `-wal`，任一写入都会让内存缓存立即失效 */
export interface DbFingerprint {
  mtimeMs: number;
  size: number;
}

export interface ThreadRowsReadOptions {
  /** `> 0` 时把时间窗下推到 SQL `WHERE`；`<= 0`（`all`）读全表并写入全表内存缓存 */
  sinceMs?: number;
  /** 窗口内存在 turn 的线程 id；即使 `threads.updated_at` 陈旧也必须保留，避免漏统计 */
  activeThreadIds?: ReadonlySet<string>;
  /** 调用方已算好的指纹；传入后本函数不再重复 stat，保证同一次查询用同一份指纹 */
  fingerprint?: DbFingerprint | null;
}

export interface TurnRowsReadOptions {
  /** `> 0` 时把时间窗下推到 SQL `WHERE`；`<= 0`（`all`）读全表并写入全表内存缓存 */
  sinceMs?: number;
  untilMs?: number;
  fingerprint?: DbFingerprint | null;
}

export interface DbRowsReadResult<T> {
  rows: T[];
  fingerprint: DbFingerprint | null;
}
/** 只读诊断计数：用于验证时间窗 DB 过滤、全表缓存命中与 rollout 解析读盘次数 */
export interface UsageStoreCounters {
  stateDbFullCacheHits: number;
  historyDbFullCacheHits: number;
  sqliteWorkerQueries: number;
  sqliteMainThreadQueries: number;
  rolloutParses: number;
  rolloutCacheHits: number;
}

interface RolloutCacheEntry {
  mtimeMs: number;
  size: number;
  samples: UsageEventSample[];
  turnTimestampsMs: number[];
}

// 修复原因：旧上限 512 在「几千个历史线程顺序扫描 all」时，同一轮查询就会把自己刚写入的条目
// 全部挤出去（顺序访问下 LRU 互相驱逐 / cache thrashing），导致下一次 all 又全量重新解析 rollout。
// 这里提升到有界大容量，覆盖大历史工作集；仍然有界，避免长期运行无上限增长。
const ROLLOUT_PARSE_CACHE_LIMIT = 16_384;
const ROLLOUT_STREAM_THRESHOLD_BYTES = 4 * 1024 * 1024;
const ROLLOUT_STREAM_CHUNK_BYTES = 256 * 1024;
/** 主线程时间片：超过该耗时就让出事件循环，把 usage 查询期间的 event-loop lag 限制在该量级 */
export const EVENT_LOOP_YIELD_SLICE_MS = 5;
/** worker 单次 SQLite 查询超时；超时按 worker 卡死处理：终止并回退主线程同步读取，保证结果正确 */
const SQLITE_READER_QUERY_TIMEOUT_MS = 10_000;
/** SQLite 历史变量上限为 999，这里留余量；活跃 id 过多时分块拼成多个 `OR id IN (...)` */
const SQLITE_MAX_QUERY_PARAMS = 900;
const rolloutParseCache = new Map<string, RolloutCacheEntry>();
const rolloutParseInFlight = new Map<
  string,
  Promise<{ samples: UsageEventSample[]; turnTimestampsMs: number[] } | null>
>();
let stateDbCache: { path: string; mtimeMs: number; size: number; rows: ThreadRow[] } | null = null;
let historyDbCache: { path: string; mtimeMs: number; size: number; rows: TurnRecord[] } | null =
  null;

const usageStoreCounters: UsageStoreCounters = {
  stateDbFullCacheHits: 0,
  historyDbFullCacheHits: 0,
  sqliteWorkerQueries: 0,
  sqliteMainThreadQueries: 0,
  rolloutParses: 0,
  rolloutCacheHits: 0,
};

export function readUsageStoreCounters(): UsageStoreCounters {
  return { ...usageStoreCounters };
}

/** 让出事件循环一个宏任务（`setImmediate`），避免大批量遍历占满微任务队列饿死 stdio 消息 */
export function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

/**
 * 把 `-wal` 折进指纹，但**空 WAL 必须忽略**。
 * 修复原因：SQLite 只读连接会在库旁创建 0 字节 `-wal`，若把空 WAL 的 mtime 算进指纹会导致缓存自失效；
 * 真实写入会使 WAL 非空或更新主库 mtime，因此仅折入 `wal.size > 0`。
 */
function foldWalIntoFingerprint(
  fingerprint: DbFingerprint,
  wal: { mtimeMs: number; size: number } | null,
): DbFingerprint {
  if (!wal || wal.size <= 0) return fingerprint;
  return { mtimeMs: Math.max(fingerprint.mtimeMs, wal.mtimeMs), size: fingerprint.size + wal.size };
}

function dbFileFingerprint(dbPath: string): DbFingerprint | null {
  try {
    const main = statSync(dbPath);
    let wal: { mtimeMs: number; size: number } | null = null;
    try {
      wal = statSync(`${dbPath}-wal`);
    } catch {}
    return foldWalIntoFingerprint({ mtimeMs: main.mtimeMs, size: main.size }, wal);
  } catch {
    return null;
  }
}

/** 异步读取主库 + 非空 WAL 指纹，避免在命中缓存前先阻塞主线程做同步 stat */
export async function readDbFingerprint(dbPath: string): Promise<DbFingerprint | null> {
  try {
    const main = await stat(dbPath);
    let wal: { mtimeMs: number; size: number } | null = null;
    try {
      wal = await stat(`${dbPath}-wal`);
    } catch {}
    return foldWalIntoFingerprint({ mtimeMs: main.mtimeMs, size: main.size }, wal);
  } catch {
    return null;
  }
}

function rememberRolloutParseCache(rolloutPath: string, entry: RolloutCacheEntry): void {
  rolloutParseCache.delete(rolloutPath);
  rolloutParseCache.set(rolloutPath, entry);
  if (rolloutParseCache.size > ROLLOUT_PARSE_CACHE_LIMIT) {
    rolloutParseCache.delete(rolloutParseCache.keys().next().value!);
  }
}

function nonNegInt(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.trunc(value) : 0;
}

function normalizeModelId(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export async function resolveLatestSqliteFile(dir: string, prefix: string): Promise<string | null> {
  try {
    const entries = await readdir(dir);
    let bestFile: string | null = null;
    let bestVersion = -1;
    for (const name of entries) {
      if (!name.startsWith(prefix) || !name.endsWith(".sqlite")) continue;
      const versionPart = name.slice(prefix.length, -".sqlite".length);
      const version = Number.parseInt(versionPart, 10);
      if (Number.isFinite(version) && version > bestVersion) {
        bestVersion = version;
        bestFile = join(dir, name);
      }
    }
    return bestFile;
  } catch {
    return null;
  }
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

interface SqlQueryPlan {
  sql: string;
  params: Array<string | number>;
}

function buildThreadRowsQuery(
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

function buildTurnRowsQuery(sinceMs: number, untilMs: number): SqlQueryPlan {
  if (sinceMs <= 0) return { sql: TURN_ROWS_SELECT_SQL, params: [] };
  const conditions = ["started_at > 0", `${TURN_STARTED_MS_SQL} >= ?`];
  const params: Array<string | number> = [sinceMs];
  if (untilMs > 0) {
    conditions.push(`${TURN_STARTED_MS_SQL} <= ?`);
    params.push(untilMs);
  }
  return { sql: `${TURN_ROWS_SELECT_SQL} WHERE ${conditions.join(" AND ")}`, params };
}

function mapThreadRow(row: Record<string, unknown>): ThreadRow {
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

function mapTurnRow(row: Record<string, unknown>): TurnRecord {
  const startedAtRaw = nonNegInt(row.started_at);
  return {
    threadId: String(row.thread_id ?? ""),
    startedAtMs: startedAtRaw > 10_000_000_000 ? startedAtRaw : startedAtRaw * 1000,
    durationMs: nonNegInt(row.duration_ms),
  };
}

function filterCachedThreadRows(
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

function filterCachedTurnRows(rows: TurnRecord[], sinceMs: number, untilMs: number): TurnRecord[] {
  if (sinceMs <= 0) return rows;
  return rows.filter(
    (row) => row.startedAtMs >= sinceMs && (untilMs <= 0 || row.startedAtMs <= untilMs),
  );
}

interface SqliteRowsResult {
  rows: Array<Record<string, unknown>>;
  fingerprint: DbFingerprint | null;
}
interface SqliteReaderPending {
  resolve: (result: SqliteRowsResult) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

// bridge 打包为单文件 CJS，worker 以内联源码 + { eval: true } 启动，将同步 DatabaseSync 移出主线程。
const SQLITE_READER_WORKER_SOURCE = `
(async () => {
  const [wt, fs, sqlite] = await Promise.all([import("node:worker_threads"), import("node:fs"), import("node:sqlite")]);
  const port = wt.parentPort;
  if (!port) return;
  const fingerprintOf = (dbPath) => {
    try {
      const main = fs.statSync(dbPath);
      try {
        const wal = fs.statSync(dbPath + "-wal");
        if (wal.size > 0) return { mtimeMs: Math.max(main.mtimeMs, wal.mtimeMs), size: main.size + wal.size };
      } catch {}
      return { mtimeMs: main.mtimeMs, size: main.size };
    } catch { return null; }
  };
  port.on("message", (msg) => {
    try {
      const fingerprint = fingerprintOf(msg.dbPath);
      const db = new sqlite.DatabaseSync(msg.dbPath, { open: true, readOnly: true });
      try { port.postMessage({ id: msg.id, rows: db.prepare(msg.sql).all(...msg.params), fingerprint }); }
      finally { db.close(); }
    } catch (queryFailed) {
      port.postMessage({ id: msg.id, error: String((queryFailed && queryFailed.message) || queryFailed) });
    }
  });
})().catch(async (startupFailed) => {
  try {
    const wt = await import("node:worker_threads");
    if (wt.parentPort) wt.parentPort.postMessage({ fatal: String((startupFailed && startupFailed.message) || startupFailed) });
  } catch {}
});
`;

let sqliteReaderWorker: Worker | null = null;
let sqliteReaderDisabled = false;
let sqliteReaderSeq = 0;
const sqliteReaderPending = new Map<number, SqliteReaderPending>();

function failSqliteReaderPending(error: Error): void {
  const pending = [...sqliteReaderPending.values()];
  sqliteReaderPending.clear();
  for (const entry of pending) {
    clearTimeout(entry.timer);
    entry.reject(error);
  }
}

function dropSqliteReaderWorker(worker: Worker): void {
  if (sqliteReaderWorker === worker) sqliteReaderWorker = null;
  void worker.terminate();
}

function ensureSqliteReaderWorker(): Worker | null {
  if (sqliteReaderDisabled) return null;
  if (sqliteReaderWorker) return sqliteReaderWorker;
  let worker: Worker;
  try {
    worker = new Worker(SQLITE_READER_WORKER_SOURCE, {
      eval: true,
      name: "codex-usage-sqlite-reader",
    });
  } catch {
    // 环境不允许 worker_threads（受限沙箱等）：长期走主线程同步 fallback，功能不受影响
    sqliteReaderDisabled = true;
    return null;
  }
  // 空闲（无 in-flight 查询）时 unref，避免常驻 worker 线程阻止进程退出；
  // 有查询在飞时再 ref，保证短生命周期进程不会在读完之前退出。
  worker.unref();
  worker.on("message", (message: unknown) => {
    const payload = asRecord(message);
    if (typeof payload.fatal === "string") {
      // 脚本级失败（例如内置模块缺失）重试无意义，直接长期回退主线程
      sqliteReaderDisabled = true;
      failSqliteReaderPending(new Error(payload.fatal));
      dropSqliteReaderWorker(worker);
      return;
    }
    const id = typeof payload.id === "number" ? payload.id : -1;
    const pending = sqliteReaderPending.get(id);
    if (!pending) return;
    sqliteReaderPending.delete(id);
    clearTimeout(pending.timer);
    if (sqliteReaderPending.size === 0) worker.unref();
    if (typeof payload.error === "string") {
      pending.reject(new Error(payload.error));
      return;
    }
    const fingerprint = asRecord(payload.fingerprint);
    pending.resolve({
      rows: Array.isArray(payload.rows) ? (payload.rows as Array<Record<string, unknown>>) : [],
      fingerprint:
        typeof fingerprint.mtimeMs === "number" && typeof fingerprint.size === "number"
          ? { mtimeMs: fingerprint.mtimeMs, size: fingerprint.size }
          : null,
    });
  });
  worker.on("error", () => {
    sqliteReaderDisabled = true;
    failSqliteReaderPending(new Error("codex usage sqlite reader worker failed"));
    dropSqliteReaderWorker(worker);
  });
  worker.on("exit", () => {
    failSqliteReaderPending(new Error("codex usage sqlite reader worker exited"));
    if (sqliteReaderWorker === worker) sqliteReaderWorker = null;
  });
  sqliteReaderWorker = worker;
  return worker;
}

function querySqliteInWorker(
  dbPath: string,
  sql: string,
  params: Array<string | number>,
): Promise<SqliteRowsResult> {
  return new Promise<SqliteRowsResult>((_resolve, reject) => {
    const worker = ensureSqliteReaderWorker();
    if (!worker) {
      reject(new Error("codex usage sqlite reader worker unavailable"));
      return;
    }
    const id = ++sqliteReaderSeq;
    const timer = setTimeout(() => {
      failSqliteReaderPending(new Error("codex usage sqlite worker query timeout"));
      dropSqliteReaderWorker(worker);
    }, SQLITE_READER_QUERY_TIMEOUT_MS);
    timer.unref();
    sqliteReaderPending.set(id, { resolve: _resolve, reject, timer });
    worker.ref();
    worker.postMessage({ id, dbPath, sql, params });
  });
}

function querySqliteOnMainThread(
  dbPath: string,
  sql: string,
  params: Array<string | number>,
): SqliteRowsResult {
  const fingerprint = dbFileFingerprint(dbPath);
  const db = new DatabaseSync(dbPath, { open: true, readOnly: true });
  try {
    return {
      rows: db.prepare(sql).all(...params) as Array<Record<string, unknown>>,
      fingerprint,
    };
  } finally {
    db.close();
  }
}

async function querySqliteRows(
  dbPath: string,
  sql: string,
  params: Array<string | number>,
): Promise<SqliteRowsResult> {
  try {
    const result = await querySqliteInWorker(dbPath, sql, params);
    usageStoreCounters.sqliteWorkerQueries += 1;
    return result;
  } catch {
    // 降级路径：worker 不可用 / 超时 / 查询失败时仍要返回正确数据，
    // 代价是这一次读取会阻塞 bridge 事件循环。
    usageStoreCounters.sqliteMainThreadQueries += 1;
    return querySqliteOnMainThread(dbPath, sql, params);
  }
}

function isSameFingerprint(
  cache: { path: string; mtimeMs: number; size: number } | null,
  path: string,
  fingerprint: DbFingerprint | null,
): boolean {
  return Boolean(
    fingerprint &&
    cache &&
    cache.path === path &&
    cache.mtimeMs === fingerprint.mtimeMs &&
    cache.size === fingerprint.size,
  );
}

/** 读取 `state_*.sqlite` 的 `threads`：全表缓存命中内存过滤 → 时间窗 SQL WHERE 下推 → 全表读取并缓存 */
export async function readThreadsFromStateDb(
  stateDbPath: string,
  options: ThreadRowsReadOptions = {},
): Promise<DbRowsReadResult<ThreadRow>> {
  const sinceMs = nonNegInt(options.sinceMs);
  const fingerprint =
    options.fingerprint === undefined ? await readDbFingerprint(stateDbPath) : options.fingerprint;
  if (isSameFingerprint(stateDbCache, stateDbPath, fingerprint)) {
    usageStoreCounters.stateDbFullCacheHits += 1;
    return {
      rows: filterCachedThreadRows(stateDbCache!.rows, sinceMs, options.activeThreadIds),
      fingerprint,
    };
  }
  try {
    const plan = buildThreadRowsQuery(sinceMs, options.activeThreadIds);
    const raw = await querySqliteRows(stateDbPath, plan.sql, plan.params);
    const rows = raw.rows.map(mapThreadRow);
    const effective = raw.fingerprint ?? fingerprint;
    // 只有全表读取才能写全表缓存：过滤后的行集不是全表事实，否则后续 all 查询会漏数据
    if (sinceMs <= 0 && effective) {
      stateDbCache = { path: stateDbPath, mtimeMs: effective.mtimeMs, size: effective.size, rows };
    }
    return { rows, fingerprint: effective };
  } catch {
    return { rows: [], fingerprint };
  }
}

/** 读取 `thread_history_*.sqlite` 的 `thread_turns`；缓存与下推规则同 `readThreadsFromStateDb` */
export async function readTurnsFromHistoryDb(
  historyDbPath: string,
  options: TurnRowsReadOptions = {},
): Promise<DbRowsReadResult<TurnRecord>> {
  const sinceMs = nonNegInt(options.sinceMs);
  const untilMs = nonNegInt(options.untilMs);
  const fingerprint =
    options.fingerprint === undefined
      ? await readDbFingerprint(historyDbPath)
      : options.fingerprint;
  if (isSameFingerprint(historyDbCache, historyDbPath, fingerprint)) {
    usageStoreCounters.historyDbFullCacheHits += 1;
    return { rows: filterCachedTurnRows(historyDbCache!.rows, sinceMs, untilMs), fingerprint };
  }
  try {
    const plan = buildTurnRowsQuery(sinceMs, untilMs);
    const raw = await querySqliteRows(historyDbPath, plan.sql, plan.params);
    const rows = raw.rows.map(mapTurnRow);
    const effective = raw.fingerprint ?? fingerprint;
    if (sinceMs <= 0 && effective) {
      historyDbCache = {
        path: historyDbPath,
        mtimeMs: effective.mtimeMs,
        size: effective.size,
        rows,
      };
    }
    return { rows, fingerprint: effective };
  } catch {
    return { rows: [], fingerprint };
  }
}

export async function parseRolloutUsage(
  rolloutPath: string,
  fallbackModel: string | null,
  fallbackTimestampMs: number,
): Promise<{ samples: UsageEventSample[]; turnTimestampsMs: number[] } | null> {
  if (!rolloutPath) return null;
  const inFlight = rolloutParseInFlight.get(rolloutPath);
  if (inFlight) return inFlight;
  const pending = parseRolloutUsageUncoalesced(
    rolloutPath,
    fallbackModel,
    fallbackTimestampMs,
  ).finally(() => {
    if (rolloutParseInFlight.get(rolloutPath) === pending) {
      rolloutParseInFlight.delete(rolloutPath);
    }
  });
  rolloutParseInFlight.set(rolloutPath, pending);
  return pending;
}

async function parseRolloutUsageUncoalesced(
  rolloutPath: string,
  fallbackModel: string | null,
  fallbackTimestampMs: number,
): Promise<{ samples: UsageEventSample[]; turnTimestampsMs: number[] } | null> {
  let fileStat: Awaited<ReturnType<typeof stat>>;
  try {
    fileStat = await stat(rolloutPath);
    if (!fileStat.isFile()) return null;
  } catch {
    return null;
  }
  const cached = rolloutParseCache.get(rolloutPath);
  if (cached && cached.mtimeMs === fileStat.mtimeMs && cached.size === fileStat.size) {
    usageStoreCounters.rolloutCacheHits += 1;
    rememberRolloutParseCache(rolloutPath, cached);
    return { samples: cached.samples, turnTimestampsMs: cached.turnTimestampsMs };
  }

  const samples: UsageEventSample[] = [];
  const turnTimestampsMs: number[] = [];
  let currentModel = fallbackModel;
  let prevTotal: {
    total: number;
    input: number;
    output: number;
    reasoning: number;
    cacheCreation: number;
    cacheRead: number;
  } | null = null;
  const pushSample = (
    timestampMs: number,
    delta: {
      total: number;
      input: number;
      output: number;
      reasoning: number;
      cacheCreation: number;
      cacheRead: number;
    },
  ): void => {
    if (delta.total <= 0) return;
    samples.push({
      timestampMs,
      modelId: currentModel ?? fallbackModel,
      totalTokens: delta.total,
      inputTokens: delta.input,
      outputTokens: delta.output,
      reasoningTokens: delta.reasoning,
      cacheCreationTokens: delta.cacheCreation,
      cacheReadTokens: delta.cacheRead,
      requestCount: 1,
    });
  };

  const consumeLine = (line: string): void => {
    if (!line.includes('"token_count"') && !line.includes('"turn_context"')) {
      return;
    }
    try {
      const parsed = JSON.parse(line) as Record<string, unknown>;
      const parsedTs =
        typeof parsed.timestamp === "string" ? Date.parse(parsed.timestamp) : Number.NaN;
      const timestampMs =
        Number.isFinite(parsedTs) && parsedTs > 0 ? parsedTs : fallbackTimestampMs;
      if (parsed.type === "turn_context") {
        const payload = asRecord(parsed.payload);
        const collabSettings = asRecord(asRecord(payload.collaboration_mode).settings);
        const turnModel = normalizeModelId(payload.model) ?? normalizeModelId(collabSettings.model);
        if (turnModel) currentModel = turnModel;
        turnTimestampsMs.push(timestampMs);
        return;
      }
      if (parsed.type === "event_msg") {
        const payload = asRecord(parsed.payload);
        if (payload.type !== "token_count") return;
        const info = asRecord(payload.info);
        const totalObj = asRecord(info.total_token_usage);
        const lastObj = asRecord(info.last_token_usage);
        const totalVal = nonNegInt(totalObj.total_tokens);
        const inputVal = nonNegInt(totalObj.input_tokens);
        const outputVal = nonNegInt(totalObj.output_tokens);
        const reasoningVal = nonNegInt(totalObj.reasoning_output_tokens);
        const cacheCreationVal = nonNegInt(totalObj.cache_write_input_tokens);
        const cacheReadVal = nonNegInt(totalObj.cached_input_tokens);

        if (totalVal > 0) {
          if (!prevTotal) {
            const lastTotal = nonNegInt(lastObj.total_tokens);
            const useLast = lastTotal > 0 && lastTotal <= totalVal;
            prevTotal = {
              total: totalVal,
              input: inputVal,
              output: outputVal,
              reasoning: reasoningVal,
              cacheCreation: cacheCreationVal,
              cacheRead: cacheReadVal,
            };
            pushSample(timestampMs, {
              total: useLast ? lastTotal : totalVal,
              input: useLast ? nonNegInt(lastObj.input_tokens) : inputVal,
              output: useLast ? nonNegInt(lastObj.output_tokens) : outputVal,
              reasoning: useLast ? nonNegInt(lastObj.reasoning_output_tokens) : reasoningVal,
              cacheCreation: useLast
                ? nonNegInt(lastObj.cache_write_input_tokens)
                : cacheCreationVal,
              cacheRead: useLast ? nonNegInt(lastObj.cached_input_tokens) : cacheReadVal,
            });
          } else if (totalVal > prevTotal.total) {
            const delta = {
              total: totalVal - prevTotal.total,
              input: Math.max(0, inputVal - prevTotal.input),
              output: Math.max(0, outputVal - prevTotal.output),
              reasoning: Math.max(0, reasoningVal - prevTotal.reasoning),
              cacheCreation: Math.max(0, cacheCreationVal - prevTotal.cacheCreation),
              cacheRead: Math.max(0, cacheReadVal - prevTotal.cacheRead),
            };
            prevTotal = {
              total: totalVal,
              input: inputVal,
              output: outputVal,
              reasoning: reasoningVal,
              cacheCreation: cacheCreationVal,
              cacheRead: cacheReadVal,
            };
            pushSample(timestampMs, delta);
          }
        } else {
          pushSample(timestampMs, {
            total: nonNegInt(lastObj.total_tokens),
            input: nonNegInt(lastObj.input_tokens),
            output: nonNegInt(lastObj.output_tokens),
            reasoning: nonNegInt(lastObj.reasoning_output_tokens),
            cacheCreation: nonNegInt(lastObj.cache_write_input_tokens),
            cacheRead: nonNegInt(lastObj.cached_input_tokens),
          });
        }
      }
    } catch {
      // 忽略截断或非 JSON 行
    }
  };

  // 时间片让出：rollout 行解析是纯同步 CPU 工作，整读路径（≤4MB）一次性解析会把事件循环整段占住。
  // 每超过 EVENT_LOOP_YIELD_SLICE_MS 就让出一个宏任务，使 usage 查询期间的 event-loop lag 有明确上限。
  let sliceStartedAt = Date.now();
  const maybeYieldToEventLoop = async (): Promise<void> => {
    if (Date.now() - sliceStartedAt <= EVENT_LOOP_YIELD_SLICE_MS) return;
    await yieldToEventLoop();
    sliceStartedAt = Date.now();
  };

  const consumeChunkText = async (chunk: string): Promise<void> => {
    let pos = 0;
    let lineCount = 0;
    while (pos < chunk.length) {
      let next = chunk.indexOf("\n", pos);
      if (next === -1) next = chunk.length;
      consumeLine(chunk.slice(pos, next));
      pos = next + 1;
      // 每 64 行才查一次时钟，避免逐行取时间的开销盖过解析本身
      lineCount += 1;
      if (lineCount % 64 === 0) await maybeYieldToEventLoop();
    }
  };

  if (fileStat.size <= ROLLOUT_STREAM_THRESHOLD_BYTES) {
    let content: string;
    try {
      content = await readFile(rolloutPath, "utf8");
    } catch {
      return null;
    }
    await consumeChunkText(content);
  } else {
    let handle: Awaited<ReturnType<typeof open>>;
    try {
      handle = await open(rolloutPath, "r");
    } catch {
      return null;
    }
    try {
      const buffer = Buffer.allocUnsafe(ROLLOUT_STREAM_CHUNK_BYTES);
      const decoder = new StringDecoder("utf8");
      let remainder = "";
      let offset = 0;
      while (offset < fileStat.size) {
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, offset);
        if (bytesRead <= 0) break;
        offset += bytesRead;
        const text = remainder + decoder.write(buffer.subarray(0, bytesRead));
        const lastNewline = text.lastIndexOf("\n");
        if (lastNewline === -1) {
          remainder = text;
          continue;
        }
        await consumeChunkText(text.slice(0, lastNewline));
        remainder = text.slice(lastNewline + 1);
      }
      const tail = remainder + decoder.end();
      if (tail) await consumeChunkText(tail);
    } catch {
      return null;
    } finally {
      await handle.close();
    }
  }

  usageStoreCounters.rolloutParses += 1;
  rememberRolloutParseCache(rolloutPath, {
    mtimeMs: fileStat.mtimeMs,
    size: fileStat.size,
    samples,
    turnTimestampsMs,
  });
  return { samples, turnTimestampsMs };
}
