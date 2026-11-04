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

export { PreviewScrollRestoreContext };
