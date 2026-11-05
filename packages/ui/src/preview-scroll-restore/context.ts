import { createContext, useContext } from "react";
import type { PreviewScrollRestoreApi } from "./contract.js";

const PreviewScrollRestoreContext = createContext<PreviewScrollRestoreApi | null>(null);

export function usePreviewScrollRestore(): PreviewScrollRestoreApi {
  const api = useContext(PreviewScrollRestoreContext);
  if (!api) {
    throw new Error("Preview scroll restore requires PreviewScrollRestoreBoundary");
  }
  return api;
}

/** 接线点在 boundary 之外时退化为透传，不让预览组件因为缺少缓存而崩溃。 */
export function usePreviewScrollRestoreOrNull(): PreviewScrollRestoreApi | null {
  return useContext(PreviewScrollRestoreContext);
}

export { PreviewScrollRestoreContext };
