import type {
  GitBranchDeleteIssue,
  GitBranchDeleteIssueCode,
  GitBranchDeletePreview,
  GitWorktreeRemovalPreview,
  GitWorktreeRemoveIssue,
  GitWorktreeRemoveIssueCode,
} from "@codez/shared";

// RPC 只透传 code/data 等固定字段；最新预览必须放进 data，不能挂在 Error 的任意属性上。
export function worktreeRemovalError(
  code: GitWorktreeRemoveIssueCode,
  message: string,
  latestPreview?: GitWorktreeRemovalPreview,
): Error & { code: GitWorktreeRemoveIssueCode; data: GitWorktreeRemoveIssue } {
  return Object.assign(new Error(message), { code, data: { code, message, latestPreview } });
}

export function branchDeletionError(
  code: GitBranchDeleteIssueCode,
  message: string,
  latestPreview?: GitBranchDeletePreview,
): Error & { code: GitBranchDeleteIssueCode; data: GitBranchDeleteIssue } {
  return Object.assign(new Error(message), { code, data: { code, message, latestPreview } });
}
