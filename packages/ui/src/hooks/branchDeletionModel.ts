import type { GitBranchDeleteIssueCode, GitBranchDeletePreview } from "@codez/shared";

/**
 * 删除分支弹层的纯状态模型（specs/git-worktree-removal.md B 系列）。
 */

export type BranchDeletionPhase = "previewing" | "confirm" | "deleting" | "error";

export interface BranchDeletionState {
  phase: BranchDeletionPhase;
  preview: GitBranchDeletePreview | null;
  /** 未合并（或合并状态未知）时的显式强删确认。 */
  forceConfirmed: boolean;
  errorMessage: string | null;
  /** branch-moved 后以最新预览回到 confirm，并展示一次性提示。 */
  notice: "branch-moved" | null;
}

export type BranchDeletionBlock = "current" | "occupied";

export function createInitialBranchDeletionState(): BranchDeletionState {
  return {
    phase: "previewing",
    preview: null,
    forceConfirmed: false,
    errorMessage: null,
    notice: null,
  };
}

export function resolveBranchDeletionBlock(
  preview: GitBranchDeletePreview,
): BranchDeletionBlock | null {
  if (preview.isCurrent) return "current";
  if (preview.checkedOutPath) return "occupied";
  return null;
}

/**
 * isMerged === null（未知）按未合并保守处理：必须勾选强删确认（B3）。
 */
export function canConfirmBranchDeletion(state: BranchDeletionState): boolean {
  if (state.phase !== "confirm" || !state.preview) return false;
  if (resolveBranchDeletionBlock(state.preview)) return false;
  if (state.preview.isMerged !== true && !state.forceConfirmed) return false;
  return true;
}

export interface BranchDeletionIssuePayload {
  code: GitBranchDeleteIssueCode;
  message: string;
  latestPreview?: GitBranchDeletePreview;
}

export function extractBranchDeletionIssue(error: unknown): BranchDeletionIssuePayload | null {
  if (typeof error !== "object" || error === null || !("data" in error)) return null;
  const data = (error as { data?: unknown }).data;
  if (typeof data !== "object" || data === null || !("code" in data)) return null;
  const record = data as { code?: unknown; message?: unknown; latestPreview?: unknown };
  if (typeof record.code !== "string" || typeof record.message !== "string") return null;
  return {
    code: record.code as GitBranchDeleteIssueCode,
    message: record.message,
    latestPreview: record.latestPreview as GitBranchDeletePreview | undefined,
  };
}
