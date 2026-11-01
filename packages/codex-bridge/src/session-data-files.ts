// 会话数据删除的磁盘事实：rollout 计量/复查与失败重试索引（specs/codex-session-data-purge.md）。
//
// 边界：CODEX_HOME 里的 rollout 只有原生 Codex 是写者，本模块只 lstat 计量、只在原生删除成功后
// 复查它们是否真的消失，绝不自己 unlink；bridge 自有的附件对象与 pending 索引才由本模块写。
// 所有遍历都是有界枚举 + 文件名语法证明归属，不存在递归 rm。
import { lstat, mkdir, open, readdir, rename, unlink, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { SessionDataFault } from "./session-data-native-db.js";

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
/**
 * 原生 rollout 文件名语法：`rollout-<ts>-<threadId>[_<rolloutId>].jsonl[.zst]`
 * （codex-rs/rollout/src/rollout_file_name.rs:39-74）。回退（revert）会为同一线程产生带
 * `_<rolloutId>` 后缀的多个文件，因此按 threadId 前段匹配，一个线程可以对应多个 rollout。
 */
const ROLLOUT_FILE_NAME = new RegExp(
  `^rollout-\\d{4}-\\d{2}-\\d{2}T\\d{2}-\\d{2}-\\d{2}-(${UUID})(?:_${UUID})?\\.jsonl(?:\\.zst)?$`,
  "i",
);
const THREAD_ID = new RegExp(`^${UUID}$`, "i");
/** 原生目录布局：sessions/YYYY/MM/DD 与 archived_sessions/…（rollout/src/list.rs:426）。 */
const ROLLOUT_SUBDIRS = ["sessions", "archived_sessions"] as const;
const DEFAULT_MAX_DEPTH = 4;
const DEFAULT_MAX_ENTRIES = 200_000;
const PENDING_MAX_BYTES = 256 * 1024;
const PENDING_MAX_THREADS = 4096;

export function isThreadId(value: string): boolean {
  return THREAD_ID.test(value);
}

export function rolloutThreadIdOf(fileName: string): string | undefined {
  const match = ROLLOUT_FILE_NAME.exec(fileName);
  return match ? match[1]!.toLowerCase() : undefined;
}

/**
 * 把 state db 记录的 `rollout_path` 收敛到 CODEX_HOME 的两个 rollout 目录内。
 * 原生删除同样只接受这两个目录下的路径（thread-store/src/local/delete_thread.rs:283-300），
 * 库外路径原生不会删，因此既不计量也不复查；返回 undefined 表示不可用。
 */
export function scopedRolloutPath(codexHome: string, path: string): string | undefined {
  if (typeof path !== "string" || path.trim().length === 0 || !isAbsolute(path)) return undefined;
  const target = resolve(path);
  for (const subdir of ROLLOUT_SUBDIRS) {
    const within = relative(resolve(codexHome, subdir), target);
    if (within !== "" && !within.startsWith("..") && !isAbsolute(within)) return target;
  }
  return undefined;
}

/**
 * 有界遍历 CODEX_HOME 的 rollout 目录，返回 threadId → 文件绝对路径。
 * 不跟随符号链接；超过深度或条目上限直接 fail-closed，绝不做无界遍历。
 */
export async function scanRolloutFiles(
  codexHome: string,
  threadIds: ReadonlySet<string>,
  limits: { maxDepth?: number; maxEntries?: number } = {},
): Promise<Map<string, string[]>> {
  const wanted = new Set([...threadIds].map((id) => id.toLowerCase()));
  const found = new Map<string, string[]>();
  if (wanted.size === 0) return found;
  const maxDepth = limits.maxDepth ?? DEFAULT_MAX_DEPTH;
  const maxEntries = limits.maxEntries ?? DEFAULT_MAX_ENTRIES;
  let visited = 0;
  const queue: Array<{ dir: string; depth: number }> = ROLLOUT_SUBDIRS.map((name) => ({
    dir: join(codexHome, name),
    depth: 0,
  }));
  while (queue.length > 0) {
    const { dir, depth } = queue.shift()!;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch (error) {
      // 目录还没建（全新安装）= 可证明的空集；其他 IO/权限错误不能当成空。
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw new SessionDataFault("rollout-scan-failed", `cannot list ${dir}`);
    }
    for (const entry of entries) {
      if (++visited > maxEntries)
        throw new SessionDataFault("rollout-scan-too-large", "codex rollout scan exceeded budget");
      // 符号链接一律跳过：既不当文件计量，也不作为目录下降，避免被工作区可控的链接重定向。
      if (entry.isSymbolicLink()) continue;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        // 超过深度预算不再静默跳过：跳过等于「没看见的文件不算数」，
        // 会让计量漏掉原生实际删除的 rollout。按 spec 直接 fail-closed。
        if (depth + 1 > maxDepth)
          throw new SessionDataFault(
            "rollout-scan-too-large",
            `codex rollout tree is deeper than ${maxDepth}`,
          );
        queue.push({ dir: path, depth: depth + 1 });
        continue;
      }
      if (!entry.isFile()) continue;
      const threadId = rolloutThreadIdOf(entry.name);
      if (!threadId || !wanted.has(threadId)) continue;
      found.set(threadId, [...(found.get(threadId) ?? []), path]);
    }
  }
  return found;
}

/** 逐个 lstat 计量：缺失跳过（本来就没有可删的文件），非常规文件与符号链接不计也不删。 */
export async function measureExistingFiles(paths: readonly string[]): Promise<Map<string, number>> {
  const sizes = new Map<string, number>();
  for (const path of paths) {
    let stats;
    try {
      stats = await lstat(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw new SessionDataFault("rollout-stat-failed", `cannot stat rollout ${path}`);
    }
    if (stats.isFile() && !stats.isSymbolicLink()) sizes.set(path, stats.size);
  }
  return sizes;
}

/** 原生删除成功后复查：返回仍然存在的文件（应当为空）。只读，不做任何补救删除。 */
export async function listExistingPaths(paths: readonly string[]): Promise<string[]> {
  const remaining: string[] = [];
  for (const path of paths) {
    try {
      await lstat(path);
      remaining.push(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT")
        throw new SessionDataFault("rollout-stat-failed", `cannot stat rollout ${path}`);
    }
  }
  return remaining;
}

export interface PendingSessionTree {
  rootId: string;
  threadIds: string[];
  updatedAt: number;
}

function pendingPath(pendingRoot: string, rootId: string): string {
  // 文件名来自 Host 传入的会话 id，必须先证明是 UUID：否则 `../` 之类会写出索引目录。
  if (!isThreadId(rootId)) throw new SessionDataFault("invalid-session-id", "invalid thread id");
  return join(pendingRoot, `${rootId.toLowerCase()}.json`);
}

/**
 * 失败重试索引：原生删除已经发生、但附件或复查失败时，整树 id 集必须活过本次调用，
 * 否则重试只能看到「原生说 thread not found」的根，后代会话的附件永远清不掉（静默泄漏）。
 * 原子写：先写临时文件再 rename，避免半截 JSON 被下一次读取当成事实。
 */
export async function writePendingTree(
  pendingRoot: string,
  tree: PendingSessionTree,
): Promise<void> {
  const path = pendingPath(pendingRoot, tree.rootId);
  try {
    await mkdir(pendingRoot, { recursive: true, mode: 0o700 });
    const temporary = `${path}.tmp-${process.pid}-${Date.now()}`;
    await writeFile(
      temporary,
      JSON.stringify({
        version: 1,
        rootId: tree.rootId.toLowerCase(),
        threadIds: tree.threadIds,
        updatedAt: tree.updatedAt,
      }),
      "utf8",
    );
    await rename(temporary, path);
  } catch (error) {
    throw new SessionDataFault(
      "pending-index-unwritable",
      `cannot persist retry index: ${(error as Error).message}`,
    );
  }
}

/**
 * 读取本根的重试索引：只有「文件不存在」返回 undefined，任何损坏或形状不符都抛出。
 * 原因：返回 undefined 等于把「索引读不懂」当成「没有待清理的后代」，上一次失败留下的
 * 后代附件就永远清不掉（静默泄漏），因此这里必须 fail-closed。
 */
export async function readPendingTree(
  pendingRoot: string,
  rootId: string,
): Promise<PendingSessionTree | undefined> {
  const path = pendingPath(pendingRoot, rootId);
  // 有界读取：先 stat 再按上限读，绝不把任意大文件整个读进内存之后才检查长度。
  try {
    const before = await lstat(path);
    if (!before.isFile() || before.isSymbolicLink())
      throw new SessionDataFault(
        "pending-index-unreadable",
        `retry index is not a file: ${rootId}`,
      );
    if (before.size > PENDING_MAX_BYTES)
      throw new SessionDataFault("pending-index-unreadable", `retry index too large for ${rootId}`);
    const file = await open(path, "r");
    let raw: string;
    try {
      raw = (await file.readFile()).toString("utf8");
    } finally {
      await file.close();
    }
    const parsed = JSON.parse(raw) as {
      version?: unknown;
      rootId?: unknown;
      threadIds?: unknown;
    };
    if (parsed.version !== 1 || !Array.isArray(parsed.threadIds))
      throw new SessionDataFault(
        "pending-index-unreadable",
        `retry index shape is invalid for ${rootId}`,
      );
    if (typeof parsed.rootId !== "string" || parsed.rootId.toLowerCase() !== rootId.toLowerCase())
      throw new SessionDataFault(
        "pending-index-unreadable",
        `retry index root mismatch for ${rootId}`,
      );
    const listed = parsed.threadIds.filter((id): id is string => typeof id === "string");
    if (listed.length === 0 || listed.length > PENDING_MAX_THREADS)
      throw new SessionDataFault(
        "pending-index-unreadable",
        `retry index size is invalid for ${rootId}`,
      );
    for (const id of listed)
      if (!isThreadId(id))
        throw new SessionDataFault(
          "pending-index-unreadable",
          `retry index holds an invalid thread id for ${rootId}`,
        );
    const threadIds = [...new Set(listed.map((id) => id.toLowerCase()))];
    if (!threadIds.includes(rootId.toLowerCase()))
      throw new SessionDataFault(
        "pending-index-unreadable",
        `retry index does not contain its own root ${rootId}`,
      );
    return { rootId: rootId.toLowerCase(), threadIds, updatedAt: Date.now() };
  } catch (error) {
    if (error instanceof SessionDataFault) throw error;
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    // 半截 JSON 与 IO 失败同样属于「无法证明」：抛出，让调用方按失败保留索引。
    throw new SessionDataFault("pending-index-unreadable", `retry index is corrupt for ${rootId}`);
  }
}

export async function clearPendingTree(pendingRoot: string, rootId: string): Promise<void> {
  try {
    await unlink(pendingPath(pendingRoot, rootId));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT")
      throw new SessionDataFault(
        "pending-index-unwritable",
        `cannot clear retry index for ${rootId}`,
      );
  }
}
