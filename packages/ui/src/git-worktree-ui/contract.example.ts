import type { GitWorktreeCreatePreviewRequest, GitWorktreeUiPort } from "./contract.js";

/** 例子仅描述显式预检；调用者保留 operationId 和确认草稿。 */
export function worktreePreviewExample(
  port: GitWorktreeUiPort,
  request: GitWorktreeCreatePreviewRequest,
) {
  return port.previewWorktreeCreation(request);
}
