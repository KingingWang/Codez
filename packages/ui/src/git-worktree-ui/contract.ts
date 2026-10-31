import type { ICodezTaskService, IGitService } from "@codez/services";

export type { ICodezTaskService, IGitService } from "@codez/services";
export type {
  GitBranchDeletePreview,
  GitWorktreeCreatePreview,
  GitWorktreeCreatePreviewRequest,
  GitWorktreeCreateResult,
  GitWorktreeRemovalPreview,
} from "@codez/shared";

/** 原 Host Git port 的工作树/分支操作切片，不创建执行或锁 owner。 */
export type GitWorktreeUiPort = Pick<
  IGitService,
  | "getRepositorySummary"
  | "getWorkspaceRepositoryInfo"
  | "getLocalBranches"
  | "listWorktrees"
  | "previewWorktreeCreation"
  | "createWorktree"
  | "previewWorktreeRemoval"
  | "removeWorktree"
  | "previewBranchDeletion"
  | "deleteBranch"
>;

/** 删除前的隔离、释放仍调用已解析的所属 Host。 */
export type GitWorktreeTaskPort = ICodezTaskService;
