// 助手 artifact 图片的模块级预览缓存。
//
// Bug 背景（手机远控线上日志实测）：bridge 降级恢复会整体重挂 React 树，
// MarkdownImage 挂载即通过 attachmentReadV4 按 512KiB chunk 重新下载每张图；
// 恢复循环期间同一批图片被反复全量拉取，是持续高带宽的主要来源之一。
// artifact ref（codez-artifact://）是内容寄存引用，同 (sessionId, ref) 的字节
// 在会话内不变，因此可以安全地跨重挂复用。
//
// 缓存持有 Blob objectURL，所有权归缓存：命中方不得 revoke，逐出时统一回收。

interface ArtifactImageCacheEntry {
  objectUrl: string;
  mediaType: string;
  byteLength: number;
  lastAccessedAt: number;
}

/** 手机上单次会话可见图片有限；超出即按 LRU 逐出。 */
const MAX_ENTRIES = 24;
const MAX_TOTAL_BYTES = 48 * 1024 * 1024;

const cache = new Map<string, ArtifactImageCacheEntry>();
let totalBytes = 0;

function cacheKey(sessionId: string, ref: string): string {
  return `${sessionId}${ref}`;
}

function evictEntry(key: string, entry: ArtifactImageCacheEntry): void {
  cache.delete(key);
  totalBytes -= entry.byteLength;
  URL.revokeObjectURL(entry.objectUrl);
}

export function getCachedArtifactImage(
  sessionId: string,
  ref: string,
): { objectUrl: string; mediaType: string } | null {
  const key = cacheKey(sessionId, ref);
  const entry = cache.get(key);
  if (!entry) return null;
  entry.lastAccessedAt = Date.now();
  return { objectUrl: entry.objectUrl, mediaType: entry.mediaType };
}

export function cacheArtifactImage(
  sessionId: string,
  ref: string,
  entry: { objectUrl: string; mediaType: string; byteLength: number },
): void {
  const key = cacheKey(sessionId, ref);
  const existing = cache.get(key);
  if (existing) evictEntry(key, existing);
  cache.set(key, { ...entry, lastAccessedAt: Date.now() });
  totalBytes += entry.byteLength;
  while (cache.size > MAX_ENTRIES || totalBytes > MAX_TOTAL_BYTES) {
    let oldestKey: string | null = null;
    let oldestAccess = Number.POSITIVE_INFINITY;
    for (const [candidateKey, candidate] of cache) {
      if (candidate.lastAccessedAt < oldestAccess) {
        oldestAccess = candidate.lastAccessedAt;
        oldestKey = candidateKey;
      }
    }
    if (oldestKey === null) return;
    evictEntry(oldestKey, cache.get(oldestKey)!);
  }
}

/** 测试用：清空缓存并回收所有 objectURL。 */
export function clearArtifactImageCache(): void {
  for (const [key, entry] of cache) {
    evictEntry(key, entry);
  }
  cache.clear();
  totalBytes = 0;
}
