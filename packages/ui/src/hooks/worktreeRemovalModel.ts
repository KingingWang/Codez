import type { GitWorktreeRemovalPreview, GitWorktreeRemoveIssueCode } from "@codez/shared";

/**
 * 删除工作树弹层的纯状态模型（specs/git-worktree-removal.md W2/W9）。
 * 所有判定集中在这里，UI 入口（行尾图标）保持零状态。
 */

/** UI 侧事实：服务端感知不到运行态，所有者为 shell 层 hook（W8）。 */
export interface WorktreeRemovalUiFacts {
  /** 目标是当前 shell 正在渲染的工作区（含其树下子目录视角）。 */
  isCurrent: boolean;
  /** 目标在本窗口已打开的 tab（含树下子目录 tab）。 */
  openTabs: { tabId: string; workspacePath: string; workspaceIdentity: string | null }[];
  /** 任一已打开 tab 有运行中任务。 */
  hasRunning: boolean;
}

export type WorktreeRemovalPhase =
  | "previewing"
  | "confirm"
  | "removing"
  | "result-unknown"
  | "error";

export interface WorktreeRemovalState {
  phase: WorktreeRemovalPhase;
  preview: GitWorktreeRemovalPreview | null;
  uiFacts: WorktreeRemovalUiFacts;
  confirmDiscardChanges: boolean;
  confirmDiscardDetachedHead: boolean;
  errorMessage: string | null;
  /** status-changed 后以最新预览回到 confirm，并展示一次性提示。 */
  notice: "status-changed" | null;
}

export type WorktreeRemovalBlock =
  | "current"
  | "running"
  | "locked"
  | "unreachable"
  | "risk-unknown";

export type WorktreeRemovalRisk = "clean" | "dirty" | "detached" | "dirty+detached";

export function createInitialWorktreeRemovalState(): WorktreeRemovalState {
  return {
    phase: "previewing",
    preview: null,
    uiFacts: { isCurrent: false, openTabs: [], hasRunning: false },
    confirmDiscardChanges: false,
    confirmDiscardDetachedHead: false,
    errorMessage: null,
    notice: null,
  };
}

/** 阻塞优先级：UI 事实（当前/运行中）先于台账事实，避免用户先处理 git 态再撞 UI 态。 */
export function resolveWorktreeRemovalBlock(
  preview: GitWorktreeRemovalPreview,
  uiFacts: WorktreeRemovalUiFacts,
): WorktreeRemovalBlock | null {
  if (uiFacts.isCurrent) return "current";
  if (uiFacts.hasRunning) return "running";
  if (preview.isLocked) return "locked";
  if (!preview.isReachable) return "unreachable";
  if (!preview.scanComplete) return "risk-unknown";
  return null;
}

/** detached HEAD 且提交不被任何 ref 包含时，删除会让提交失去引用（审查 ⑤）。 */
export function resolveWorktreeRemovalRisk(
  preview: GitWorktreeRemovalPreview,
): WorktreeRemovalRisk {
  const detachedRisk = preview.isDetached && preview.headReachableFromRef === false;
  const dirty = preview.totalChangeCount > 0 || preview.attentionTotalCount > 0;
  if (dirty && detachedRisk) return "dirty+detached";
  if (detachedRisk) return "detached";
  if (dirty) return "dirty";
  return "clean";
}

export function canConfirmWorktreeRemoval(state: WorktreeRemovalState): boolean {
  if (state.phase !== "confirm" || !state.preview) return false;
  if (resolveWorktreeRemovalBlock(state.preview, state.uiFacts)) return false;
  const risk = resolveWorktreeRemovalRisk(state.preview);
  if ((risk === "dirty" || risk === "dirty+detached") && !state.confirmDiscardChanges) {
    return false;
  }
  if ((risk === "detached" || risk === "dirty+detached") && !state.confirmDiscardDetachedHead) {
    return false;
  }
  return true;
}

export interface WorktreeRemovalIssuePayload {
  code: GitWorktreeRemoveIssueCode;
  message: string;
  latestPreview?: GitWorktreeRemovalPreview;
}

/** RPC 只透传 code/data 固定字段；issue 载荷必须从 error.data 读取。 */
export function extractWorktreeRemovalIssue(error: unknown): WorktreeRemovalIssuePayload | null {
  if (typeof error !== "object" || error === null || !("data" in error)) return null;
  const data = (error as { data?: unknown }).data;
  if (typeof data !== "object" || data === null || !("code" in data)) return null;
  const record = data as { code?: unknown; message?: unknown; latestPreview?: unknown };
  if (typeof record.code !== "string" || typeof record.message !== "string") return null;
  return {
    code: record.code as GitWorktreeRemoveIssueCode,
    message: record.message,
    latestPreview: record.latestPreview as GitWorktreeRemovalPreview | undefined,
  };
}
