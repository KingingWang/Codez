import type { PreviewScrollRestoreSnapshot, PreviewScrollRestoreSource } from "./contract.js";

/**
 * 缓存条目上限。超出后按最早写入淘汰；被淘汰只会退化成「从头开始」，
 * 不会把别的工作区/文件的读位套到当前预览上。
 */
const MAX_SNAPSHOT_ENTRIES = 128;

// Bugfix: 切换项目时侧栏 tab 按 workspaceKey 过滤，整棵 FileManagerPane 子树会被卸载。
// 读位快照如果放在组件 ref 里，卸载即丢失，切回来只能从文件头开始；因此这里是唯一的
// 跨挂载 owner：模块级 Map，仅存在于当前 renderer 内存，不落盘、不进 task/session/Host/relay。
const snapshots = new Map<string, PreviewScrollRestoreSnapshot>();

/** source 身份：优先用稳定路径，无路径的内存 source 退回 type + title。 */
export function resolvePreviewScrollRestoreSourceKey(source: PreviewScrollRestoreSource): string {
  const path = source.path?.trim();
  return path ? `path:${source.type}:${path}` : `title:${source.type}:${source.title}`;
}

/** 条目身份：工作区身份 key + source 身份，避免不同项目里同名路径互相覆盖。 */
export function resolvePreviewScrollRestoreEntryKey(
  workspaceKey: string | undefined,
  source: PreviewScrollRestoreSource,
): string {
  return `${workspaceKey?.trim() || "no-workspace"}::${resolvePreviewScrollRestoreSourceKey(source)}`;
}

export function readPreviewScrollRestoreSnapshot(
  entryKey: string,
): PreviewScrollRestoreSnapshot | null {
  return snapshots.get(entryKey) ?? null;
}

export function writePreviewScrollRestoreSnapshot(
  entryKey: string,
  snapshot: PreviewScrollRestoreSnapshot,
): void {
  // 先删再写，让 Map 的插入序就是「最近写入序」，淘汰时直接取首个 key。
  snapshots.delete(entryKey);
  snapshots.set(entryKey, snapshot);
  while (snapshots.size > MAX_SNAPSHOT_ENTRIES) {
    const oldest = snapshots.keys().next();
    if (oldest.done) {
      break;
    }
    snapshots.delete(oldest.value);
  }
}

export function clearPreviewScrollRestoreSnapshot(entryKey: string): void {
  snapshots.delete(entryKey);
}
