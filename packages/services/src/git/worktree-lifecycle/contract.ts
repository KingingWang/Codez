import type { createGitBranchDeletionHelper } from "../repo/gitBranchDeletion.js";
import type {
  createGitWorktreeCreationHelper,
  GitWorktreeCreationHelper,
} from "../repo/gitWorktreeCreation.js";
import type { createGitWorktreeRemovalHelper } from "../repo/gitWorktreeRemoval.js";

export type CreateGitWorktreeCreationHelper = typeof createGitWorktreeCreationHelper;
export type CreateGitWorktreeRemovalHelper = typeof createGitWorktreeRemovalHelper;
export type CreateGitBranchDeletionHelper = typeof createGitBranchDeletionHelper;
export type GitWorktreeRemovalPort = ReturnType<CreateGitWorktreeRemovalHelper>;
export type GitBranchDeletionPort = ReturnType<CreateGitBranchDeletionHelper>;
export type { GitWorktreeCreationHelper };

/** 原 GitCliRepo 组装的三个端口；不拥有额外锁、operation 记录或 UI 确认状态。 */
export interface GitWorktreeLifecycleContract {
  readonly creation: GitWorktreeCreationHelper;
  readonly removal: GitWorktreeRemovalPort;
  readonly branches: GitBranchDeletionPort;
}
