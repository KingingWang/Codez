import { useMemo, useRef, type ReactNode } from "react";
import type {
  PreviewScrollRestoreApi,
  PreviewScrollRestoreSnapshot,
  PreviewScrollRestoreSource,
} from "./contract.js";
import { PreviewScrollRestoreContext } from "./context.js";

function resolveSourceKey(source: PreviewScrollRestoreSource): string {
  const path = source.path?.trim();
  return path ? `path:${source.type}:${path}` : `title:${source.type}:${source.title}`;
}

function PreviewScrollRestoreCache({ children }: { children: ReactNode }) {
  const snapshotRef = useRef<PreviewScrollRestoreSnapshot | null>(null);
  const api = useMemo<PreviewScrollRestoreApi>(
    () => ({
      getSnapshot: () => snapshotRef.current,
      saveSnapshot: (snapshot) => {
        snapshotRef.current = snapshot;
      },
      clearSnapshot: () => {
        snapshotRef.current = null;
      },
    }),
    [],
  );

  return (
    <PreviewScrollRestoreContext.Provider value={api}>
      {children}
    </PreviewScrollRestoreContext.Provider>
  );
}

export function PreviewScrollRestoreBoundary({
  source,
  children,
}: {
  source: PreviewScrollRestoreSource;
  children: ReactNode;
}) {
  // source key 变化时重建缓存，避免旧文件的页码/滚动位置套到新文件上。
  return (
    <PreviewScrollRestoreCache key={resolveSourceKey(source)}>{children}</PreviewScrollRestoreCache>
  );
}
