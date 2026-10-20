import type { GitFileChange } from "./git.js";

export type GitWorktreeRemoveIssueCode =
  | "not-found"
  | "is-main"
  | "locked"
  | "unreachable"
  | "status-changed"
  | "operation-conflict"
  | "scan-incomplete"
  | "discard-changes-required"
  | "discard-detached-head-required"
  | "unknown";

export interface GitWorktreeRemovePreviewRequest {
  workspacePath: string;
  targetPath: string;
  operationId: string;
}

export interface GitWorktreeRemovalPreview {
  targetPath: string;
  branchName: string | null;
  isDetached: boolean;
  headCommitHash: string | null;
  headReachableFromRef: boolean | null;
  isMain: boolean;
  isLocked: boolean;
  lockReason: string | null;
  isReachable: boolean;
  changes: GitFileChange[];
  totalChangeCount: number;
  attentionPaths: string[];
  attentionTotalCount: number;
  scanComplete: boolean;
  statusFingerprint: string;
}

export interface GitWorktreeRemoveRequest extends GitWorktreeRemovePreviewRequest {
  expectedFingerprint: string;
  allowDiscardChanges: boolean;
  allowDiscardDetachedHead: boolean;
}

export interface GitWorktreeRemoveResult {
  removed: true;
}

export interface GitWorktreeRemoveIssue {
  code: GitWorktreeRemoveIssueCode;
  message: string;
  latestPreview?: GitWorktreeRemovalPreview;
}

export type GitBranchDeleteIssueCode =
  | "branch-is-current"
  | "branch-checked-out"
  | "branch-not-merged"
  | "branch-not-found"
  | "invalid-branch-name"
  | "branch-moved"
  | "unknown";

export interface GitBranchDeletePreviewRequest {
  workspacePath: string;
  branchName: string;
}

export interface GitBranchDeletePreview {
  branchName: string;
  isCurrent: boolean;
  checkedOutPath: string | null;
  isMerged: boolean | null;
  commitHash: string | null;
  commitSubject: string | null;
  upstreamName: string | null;
}

export interface GitDeleteBranchRequest extends GitBranchDeletePreviewRequest {
  force: boolean;
  expectedCommitHash: string | null;
}

export interface GitBranchDeleteResult {
  deleted: true;
  configCleanupSucceeded: boolean;
}

export interface GitBranchDeleteIssue {
  code: GitBranchDeleteIssueCode;
  message: string;
  latestPreview?: GitBranchDeletePreview;
}
