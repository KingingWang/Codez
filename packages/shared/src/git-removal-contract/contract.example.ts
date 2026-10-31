import type { GitWorktreeRemovePreviewRequest } from "./contract.js";

export const worktreeRemovalPreviewExample: GitWorktreeRemovePreviewRequest = {
  workspacePath: "/example/repository",
  targetPath: "/example/worktree",
  operationId: "example-preview-operation",
};
