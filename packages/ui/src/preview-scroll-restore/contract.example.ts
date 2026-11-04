import type { PreviewScrollRestoreApi, PreviewScrollRestoreSnapshot } from "./contract.js";

/** 演示恢复缓存只存读位，不接管 Markdown DOM 或 PDF runtime。 */
export function examplePreviewScrollRestore(
  api: PreviewScrollRestoreApi,
  snapshot: PreviewScrollRestoreSnapshot,
) {
  api.saveSnapshot(snapshot);
  return api.getSnapshot();
}
