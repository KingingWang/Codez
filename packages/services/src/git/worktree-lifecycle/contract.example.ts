import type { GitWorktreeRemovalPort } from "./contract.js";

/** 只读预览与实际删除是不同意图；示例不默认调用 remove。 */
export function worktreeRemovalPreviewExample(
  removal: GitWorktreeRemovalPort,
  request: Parameters<GitWorktreeRemovalPort["preview"]>[0],
) {
  return removal.preview(request);
}
