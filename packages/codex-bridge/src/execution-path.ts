import { realpath } from "node:fs";
import { isAbsolute } from "node:path";
import { promisify } from "node:util";

// promises 版没有 native 变体；libuv 的 realpath 才会解析 Windows 8.3 短名与真实大小写。
const realpathNative = promisify(realpath.native);

/**
 * 同一物理目录在原生记录与 Host 传入路径中可能有多种拼写：
 * macOS 的 `/var/folders` 实为 `/private/var/folders` 符号链接，Windows 临时目录常见
 * `C:\Users\RUNNER~1` 8.3 短名，Rust `canonicalize` 还可能带 `\\?\` verbatim 前缀。
 * 这些拼写差异不是不同工作区；用字符串相等判断会丢失或误拒会话。
 */
export function normalizeExecutionSpelling(path: string): string {
  if (!path.startsWith("\\\\?\\")) return path;
  return path.startsWith("\\\\?\\UNC\\") ? `\\\\${path.slice(8)}` : path.slice(4);
}

const canonicalCache = new Map<string, Promise<string>>();
const CANONICAL_CACHE_LIMIT = 256;

/**
 * 物理执行路径。解析失败（目录已删除、无权限）时退回调用方拼写，
 * 不缓存失败结果，避免目录随后出现时继续使用过期答案。
 */
export function canonicalExecutionPath(path: string): Promise<string> {
  const key = normalizeExecutionSpelling(path);
  const cached = canonicalCache.get(key);
  if (cached) return cached;
  const pending = realpathNative(key).then(normalizeExecutionSpelling, () => {
    canonicalCache.delete(key);
    return key;
  });
  if (canonicalCache.size >= CANONICAL_CACHE_LIMIT) canonicalCache.clear();
  canonicalCache.set(key, pending);
  return pending;
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
