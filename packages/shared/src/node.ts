/**
 * Node-only shared utilities.
 *
 * This subpath must not be imported by renderer/browser bundles.
 */
export { acquireFileLock } from "./node/atomicFileLock.js";
export { createNodeNetworkCapture, withoutNetworkCapture } from "./node/networkCapture.js";
export {
  GEN_UI_OUTPUT_ROOT_ENV,
  GEN_UI_OUTPUT_DIRECTORY,
  getGenUiOutputDirectory,
} from "./node/genUiPaths.js";
export { scanOfficialPluginCacheRoots } from "./node/officialPluginCache.js";
export {
  migrateUserSubagentMarkdown,
  migrateSubagentStateFile,
} from "./node/subagentMarkdownMigration.js";
export {
  atomicWritePrivateTextFile,
  backupCorruptFile,
  withFileLock,
  type SharedFileLockOptions,
} from "./node/privateFilePersistence.js";
export {
  createNodeSelfResourceSampler,
  NODE_SELF_RESOURCE_SAMPLE_INTERVAL_MS,
  type NodeSelfResourceSampler,
  type NodeSelfResourceSamplerOptions,
} from "./node/nodeSelfResourceTelemetry.js";
import { realpath, realpathSync } from "node:fs";
import { isAbsolute } from "node:path";
import { promisify } from "node:util";

// promises 版没有 native 变体；libuv 的 realpath 才会解析 Windows 8.3 短名与真实大小写。
const realpathNative = promisify(realpath.native);

/**
 * 同一物理目录在原生记录与 Host 传入路径中可能有多种拼写：
 * macOS 的 `/var/folders` 实为 `/private/var/folders` 符号链接，远端 `/home/user` 常指向独立数据盘，
 * Windows 临时目录常见 `C:\Users\RUNNER~1` 8.3 短名，Rust `canonicalize` 还可能带 `\\?\` verbatim 前缀。
 * 这些拼写差异不是不同工作区；用字符串相等判断会丢失或误拒会话。
 */
export function normalizeExecutionSpelling(path: string): string {
  if (!path.startsWith("\\\\?\\")) return path;
  return path.startsWith("\\\\?\\UNC\\") ? `\\\\${path.slice(8)}` : path.slice(4);
}

const resolvedCache = new Map<string, Promise<string | undefined>>();
const syncResolvedCache = new Map<string, string>();
const CACHE_LIMIT = 512;

/**
 * 解析真实物理路径。当目标不存在或无权限时返回 undefined（不缓存失败结果），
 * 供持久化层落库为 NULL 并在读取侧回退字面路径比较。
 */
export function resolvePhysicalPath(path: string): Promise<string | undefined> {
  if (typeof path !== "string" || !isAbsolute(path)) return Promise.resolve(undefined);
  const key = normalizeExecutionSpelling(path);
  const cached = resolvedCache.get(key);
  if (cached) return cached;
  const pending = realpathNative(key).then(
    (resolved) => {
      const normalized = normalizeExecutionSpelling(resolved);
      if (syncResolvedCache.size >= CACHE_LIMIT) syncResolvedCache.clear();
      syncResolvedCache.set(key, normalized);
      return normalized;
    },
    () => {
      resolvedCache.delete(key);
      return undefined;
    },
  );
  if (resolvedCache.size >= CACHE_LIMIT) resolvedCache.clear();
  resolvedCache.set(key, pending);
  return pending;
}

/**
 * 同步解析真实物理路径（供 SQLite 同步事务写入路径使用）。
 * 解析失败时返回 undefined，不缓存失败结果。
 */
export function resolvePhysicalPathSync(path: string): string | undefined {
  if (typeof path !== "string" || !isAbsolute(path)) return undefined;
  const key = normalizeExecutionSpelling(path);
  const cached = syncResolvedCache.get(key);
  if (cached !== undefined) return cached;
  try {
    const normalized = normalizeExecutionSpelling(realpathSync.native(key));
    if (syncResolvedCache.size >= CACHE_LIMIT) syncResolvedCache.clear();
    syncResolvedCache.set(key, normalized);
    return normalized;
  } catch {
    return undefined;
  }
}

/**
 * 物理执行路径。解析失败（目录已删除、无权限）时退回调用方拼写，
 * 不缓存失败结果，避免目录随后出现时继续使用过期答案。
 */
export async function canonicalExecutionPath(path: string): Promise<string> {
  const key = normalizeExecutionSpelling(path);
  return (await resolvePhysicalPath(key)) ?? key;
}

/** Compare physical execution paths only; never coalesce distinct directories or relative input. */
export async function sameExecutionPath(value: unknown, cwd: string): Promise<boolean> {
  if (value === cwd) return true;
  if (typeof value !== "string" || !isAbsolute(value)) return false;
  const requested = normalizeExecutionSpelling(value);
  const current = normalizeExecutionSpelling(cwd);
  if (requested === current) return true;
  const [left, right] = await Promise.all([
    canonicalExecutionPath(requested),
    canonicalExecutionPath(current),
  ]);
  return left === right;
}

/**
 * 同步比较两个路径是否指向同一物理目录（支持传入已知的物理路径，缺失时尝试同步解析并回退字面相等）。
 */
export function samePhysicalOrExactPath(
  leftPath: string,
  rightPath: string,
  leftPhysical?: string | null,
  rightPhysical?: string | null,
): boolean {
  const leftNorm = normalizeExecutionSpelling(leftPath);
  const rightNorm = normalizeExecutionSpelling(rightPath);
  if (leftNorm === rightNorm) return true;
  const resolvedLeft = leftPhysical ?? resolvePhysicalPathSync(leftNorm);
  const resolvedRight = rightPhysical ?? resolvePhysicalPathSync(rightNorm);
  if (resolvedLeft && resolvedRight) {
    return normalizeExecutionSpelling(resolvedLeft) === normalizeExecutionSpelling(resolvedRight);
  }
  return false;
}
