import { useMemo, useRef, type ReactNode } from "react";
import type {
  PreviewScrollRestoreApi,
  PreviewScrollRestoreSnapshot,
  PreviewScrollRestoreSource,
} from "./contract.js";
import { PreviewScrollRestoreContext } from "./context.js";
import {
  clearPreviewScrollRestoreSnapshot,
  readPreviewScrollRestoreSnapshot,
  resolvePreviewScrollRestoreEntryKey,
  writePreviewScrollRestoreSnapshot,
} from "./snapshotStore.js";

export function PreviewScrollRestoreBoundary({
  source,
  workspaceKey,
  children,
}: {
  source: PreviewScrollRestoreSource;
  /** 工作区身份 key（workspaceIdentity || workspacePath）；用于隔离不同项目里的同名路径。 */
  workspaceKey?: string;
  children: ReactNode;
}) {
  const entryKey = resolvePreviewScrollRestoreEntryKey(workspaceKey, source);
  const mountedEntryKeyRef = useRef(entryKey);
  // 同一次挂载内换 source 属于显式导航，必须在子树挂载前清掉目标缓存，保持上游
  // 「打开新文件从头开始」。卸载不清缓存：切会话、切项目、关标签再回来都要能恢复。
  if (mountedEntryKeyRef.current !== entryKey) {
    mountedEntryKeyRef.current = entryKey;
    clearPreviewScrollRestoreSnapshot(entryKey);
  }
  const api = useMemo<PreviewScrollRestoreApi>(
    () => ({
      getSnapshot: () => readPreviewScrollRestoreSnapshot(entryKey),
      saveSnapshot: (snapshot: PreviewScrollRestoreSnapshot) => {
        writePreviewScrollRestoreSnapshot(entryKey, snapshot);
      },
      clearSnapshot: () => {
        clearPreviewScrollRestoreSnapshot(entryKey);
      },
    }),
    [entryKey],
  );

  return (
    <PreviewScrollRestoreContext.Provider value={api}>
      {children}
    </PreviewScrollRestoreContext.Provider>
  );
}
