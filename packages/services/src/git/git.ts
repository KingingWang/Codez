import type {
  GitBranchMutationResult,
  GitBranchComparison,
  GitCommitGraphRequest,
  GitCommitGraphResult,
  GitCreateBranchRequest,
  GitChangesRequest,
  GitCommitRequest,
  GitCancelGenerateCommitMessageRequest,
  GitCancelGenerateCommitMessageResult,
  GitCommitResult,
  GitDiffQuery,
  GitDiffResult,
  GitDiscardPathsRequest,
  GitGenerateCommitMessageRequest,
  GitGenerateCommitMessageResult,
  GitIdentity,
  GitIgnoredPathsRequest,
  GitLocalBranchListResult,
  GitPathMutationRequest,
  GitPushRequest,
  GitPushResult,
  GitRefreshRequest,
  GitRefreshResult,
  GitRepositoryRequest,
  GitRepositorySummary,
  GitWorkspaceRepositoryInfo,
  GitFileChange,
  GitSwitchBranchRequest,
  GitWorktreeListResult,
  GitWorktreeCreatePreview,
  GitWorktreeCreatePreviewRequest,
  GitWorktreeCreateRequest,
  GitWorktreeCreateResult,
  GitWorktreeRemovePreviewRequest,
  GitWorktreeRemovalPreview,
  GitWorktreeRemoveRequest,
  GitWorktreeRemoveResult,
  GitBranchDeletePreviewRequest,
  GitBranchDeletePreview,
  GitDeleteBranchRequest,
  GitBranchDeleteResult,
} from "@codez/shared";
import { ServiceChannels } from "@codez/shared";
import { createServiceDescriptor } from "../descriptors.js";

export interface IGitService {
  getRepositorySummary(params: GitRepositoryRequest): Promise<GitRepositorySummary>;
  getWorkspaceRepositoryInfo(params: GitRepositoryRequest): Promise<GitWorkspaceRepositoryInfo>;
  getLocalBranches(params: GitRepositoryRequest): Promise<GitLocalBranchListResult>;
  listWorktrees(params: GitRepositoryRequest): Promise<GitWorktreeListResult>;
  previewWorktreeCreation(
    params: GitWorktreeCreatePreviewRequest,
  ): Promise<GitWorktreeCreatePreview>;
  createWorktree(params: GitWorktreeCreateRequest): Promise<GitWorktreeCreateResult>;
  previewWorktreeRemoval(
    params: GitWorktreeRemovePreviewRequest,
  ): Promise<GitWorktreeRemovalPreview>;
  removeWorktree(params: GitWorktreeRemoveRequest): Promise<GitWorktreeRemoveResult>;
  previewBranchDeletion(params: GitBranchDeletePreviewRequest): Promise<GitBranchDeletePreview>;
  deleteBranch(params: GitDeleteBranchRequest): Promise<GitBranchDeleteResult>;
  getCommitGraph(params: GitCommitGraphRequest): Promise<GitCommitGraphResult>;
  switchBranch(params: GitSwitchBranchRequest): Promise<GitBranchMutationResult>;
  createBranchAndSwitch(params: GitCreateBranchRequest): Promise<GitBranchMutationResult>;
  getChanges(params: GitChangesRequest): Promise<GitFileChange[]>;
  getIgnoredPaths(params: GitIgnoredPathsRequest): Promise<string[]>;
  getDiff(params: GitDiffQuery): Promise<GitDiffResult>;
  getBranchComparison(params: GitRepositoryRequest): Promise<GitBranchComparison>;
  stagePaths(params: GitPathMutationRequest): Promise<void>;
  unstagePaths(params: GitPathMutationRequest): Promise<void>;
  discardPaths(params: GitDiscardPathsRequest): Promise<void>;
  generateCommitMessage(
    params: GitGenerateCommitMessageRequest,
  ): Promise<GitGenerateCommitMessageResult>;
  cancelGenerateCommitMessage(
    params: GitCancelGenerateCommitMessageRequest,
  ): Promise<GitCancelGenerateCommitMessageResult>;
  commit(params: GitCommitRequest): Promise<GitCommitResult>;
  push(params: GitPushRequest): Promise<GitPushResult>;
  getIdentity(params: GitRepositoryRequest): Promise<GitIdentity>;
  refresh(params: GitRefreshRequest): Promise<GitRefreshResult>;
}

export const IGitService = createServiceDescriptor<IGitService>(ServiceChannels.Git);
