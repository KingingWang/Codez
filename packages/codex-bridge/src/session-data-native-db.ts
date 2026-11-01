// Codex 原生 SQLite 事实的严格只读读取（specs/codex-session-data-purge.md）。
//
// 为什么单独一个文件：统计面板用的 readThreadsFromStateDb 把任何读失败吞成 rows: []，
// resolveLatestSqliteFile 把 readdir 失败吞成 null（codex-app-usage-store.ts:183-201,509-521）。
// 对只读展示那是合理降级，对破坏性删除预检就是 fail-open——「读不到」会被当成「不存在」，
// 于是漏掉后代、漏掉排队输入，甚至对没删掉的会话报成功。这里只保留 fail-closed 语义。
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { querySqliteRows } from "./codex-app-usage-store.js";

/** 预检失败：带稳定 code，purge 按会话映射进 failed[]，measure 直接让整条请求失败。 */
export class SessionDataFault extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "SessionDataFault";
  }
}

/**
 * 严格只读查询：worker 与主线程两条路径的任何失败都原样抛出，绝不退化成空行集。
 *
 * 原因：统计侧的 readThreadsFromStateDb / readTurnsFromHistoryDb 把读失败吞成 rows: []
 * （fail-open 对只读展示无害），但破坏性删除的预检一旦拿到假空集，就会把「读不到」当成
 * 「不存在」，从而漏掉后代、漏掉排队输入，甚至对没删掉的会话报成功。
 *
 * 只接受只读语句：SQL 由本模块以常量拼装（不接受外部字符串），这里再挡一次写语句，
 * 避免把「只读事实源」误用成第二条写路径。
 */
export async function querySqliteRowsStrict(
  dbPath: string,
  sql: string,
  params: Array<string | number>,
): Promise<Array<Record<string, unknown>>> {
  if (!/^\s*(SELECT|WITH)\b/i.test(sql))
    throw new SessionDataFault("state-db-unavailable", "session data requires a read-only query");
  const result = await querySqliteRows(dbPath, sql, params);
  return result.rows;
}

/** 单条 SQL 的绑定参数上限（SQLite 默认 999），留足余量分批。 */
const SQL_PARAM_CHUNK = 400;
const SQLITE_FILE_NAME = /^[A-Za-z0-9_.-]+\.sqlite$/;

function chunks<T>(values: readonly T[], size: number): T[][] {
  const result: T[][] = [];
  for (let start = 0; start < values.length; start += size)
    result.push(values.slice(start, start + size));
  return result;
}

function placeholders(count: number): string {
  return Array.from({ length: count }, () => "?").join(", ");
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values.filter((value) => value.length > 0))];
}

/**
 * 解析 `<dir>/<prefix><version>.sqlite` 里版本号最大的库文件。
 * 与统计侧的宽松版本不同：readdir 失败（权限、IO）抛出，只有目录真不存在才返回 null，
 * 因为「解析不到库」在删除预检里等价于「无法证明事实」。
 */
export async function resolveCodexSqliteFileStrict(
  dir: string,
  prefix: string,
): Promise<string | null> {
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new SessionDataFault("state-db-unavailable", `cannot list codex home for ${prefix} db`);
  }
  let best: string | null = null;
  let bestVersion = -1;
  for (const name of entries) {
    if (!name.startsWith(prefix) || !name.endsWith(".sqlite") || !SQLITE_FILE_NAME.test(name))
      continue;
    const version = Number.parseInt(name.slice(prefix.length, -".sqlite".length), 10);
    if (!Number.isFinite(version) || version <= bestVersion) continue;
    bestVersion = version;
    best = join(dir, name);
  }
  return best;
}

/**
 * state db 是整树预检的前提：原生 thread/delete 的后代级联来自 thread_spawn_edges
 * （codex-rs/core/src/thread_manager.rs:1056-1091），读不到它就无法证明整树，
 * 因此不降级成「只删根」，直接 fail-closed。
 */
export async function requireCodexStateDb(codexHome: string): Promise<string> {
  const path = await resolveCodexSqliteFileStrict(codexHome, "state_");
  if (!path) throw new SessionDataFault("state-db-unavailable", "codex state db is missing");
  return path;
}

/**
 * `threads` 表里仍有行的 id → 其 `rollout_path`。两个用途都必须是严格只读：
 *
 * 1. 区分「已彻底删除」与「rollout 丢了但行还在」——原生 `no rollout found` 在删任何行之前
 *    返回，行还在就说明整棵树都还活着（thread_delete.rs:88-125）；
 * 2. 补全计量集合——原生按 rollout **payload** 里的 session_meta.id 归属文件，回退产生的
 *    replacement 文件名带的是另一个 UUID（delete_thread.rs 测试
 *    delete_thread_rejects_reference_to_reverted_rollout：文件名 321、payload id 320）。
 *    只按文件名前段匹配会漏计这类文件，因此把库里记录的当前 rollout_path 一并纳入候选。
 */
export async function readThreadRolloutPaths(
  codexHome: string,
  threadIds: readonly string[],
): Promise<Map<string, string | null>> {
  const ids = unique(threadIds);
  const existing = new Map<string, string | null>();
  if (ids.length === 0) return existing;
  const dbPath = await requireCodexStateDb(codexHome);
  for (const chunk of chunks(ids, SQL_PARAM_CHUNK)) {
    const rows = await querySqliteRowsStrict(
      dbPath,
      `SELECT id, rollout_path FROM threads WHERE id IN (${placeholders(chunk.length)})`,
      chunk,
    );
    for (const row of rows) {
      const id = text(row.id);
      if (id) existing.set(id, text(row.rollout_path));
    }
  }
  return existing;
}

/**
 * `thread_spawn_edges` 的递归闭包（按根分组，不含根本身）。
 * 与原生 list_thread_spawn_descendants 同一张边表、同样不按 status 过滤；
 * UNION 去重同时阻断环，避免异常边造成无限递归。
 */
export async function readSpawnDescendants(
  codexHome: string,
  rootIds: readonly string[],
): Promise<Map<string, Set<string>>> {
  const ids = unique(rootIds);
  const descendants = new Map<string, Set<string>>(ids.map((id) => [id, new Set<string>()]));
  if (ids.length === 0) return descendants;
  const dbPath = await requireCodexStateDb(codexHome);
  for (const chunk of chunks(ids, SQL_PARAM_CHUNK)) {
    const rows = await querySqliteRowsStrict(
      dbPath,
      `WITH RECURSIVE subtree(root_id, child_thread_id) AS (
         SELECT parent_thread_id, child_thread_id
           FROM thread_spawn_edges
          WHERE parent_thread_id IN (${placeholders(chunk.length)})
         UNION
         SELECT s.root_id, e.child_thread_id
           FROM thread_spawn_edges e
           JOIN subtree s ON e.parent_thread_id = s.child_thread_id
       )
       SELECT root_id, child_thread_id FROM subtree`,
      // 种子只在 WHERE parent_thread_id IN (...) 出现一次；递归段用 join 展开，不再绑参数。
      chunk,
    );
    for (const row of rows) {
      const root = text(row.root_id);
      const child = text(row.child_thread_id);
      if (!root || !child || child === root) continue;
      const set = descendants.get(root) ?? new Set<string>();
      set.add(child);
      descendants.set(root, set);
    }
  }
  return descendants;
}

/**
 * 持久化队列里仍有输入的线程：等价 legacy CLI residency 的 hasQueuedCommands → busy。
 * 固定 ref 下队列库名是 queue_1.sqlite（codex-rs/state/src/sqlite.rs:37），app-server 启动即建；
 * 文件不存在 = 没有任何持久化队列行，是可证明的空集，不是读失败。
 */
export async function readQueuedThreadIds(
  codexHome: string,
  threadIds: readonly string[],
): Promise<Set<string>> {
  const ids = unique(threadIds);
  const queued = new Set<string>();
  if (ids.length === 0) return queued;
  const dbPath = await resolveCodexSqliteFileStrict(codexHome, "queue_");
  if (!dbPath) return queued;
  for (const chunk of chunks(ids, SQL_PARAM_CHUNK)) {
    const rows = await querySqliteRowsStrict(
      dbPath,
      `SELECT DISTINCT thread_id FROM queued_items WHERE thread_id IN (${placeholders(chunk.length)})`,
      chunk,
    );
    for (const row of rows) {
      const id = text(row.thread_id);
      if (id) queued.add(id);
    }
  }
  return queued;
}
