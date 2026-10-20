import type { ReactNode } from "react";
import type { IGitService } from "@codez/services";
import type {
  GitLocalBranch,
  GitWorktreeCreatePreview,
  GitWorktreeCreatePreviewRequest,
  GitWorktreeCreateResult,
} from "@codez/shared";
import { createUuid } from "@codez/shared";
import { getErrorMessage } from "@/lib/errorMessage.js";
import { isRemoteWorkspaceDisconnectedError } from "@/lib/remoteWorkspaceServiceError.js";

export type WorktreeCreationPreview = GitWorktreeCreatePreview;
export type WorktreeCreationResult = GitWorktreeCreateResult;
export type WorktreeCreationAvailability =
  | "ready"
  | "disconnected"
  | "unsupported"
  | "not-git"
  | "git-unavailable"
  | "failed";
export type WorktreeCreationMode = WorktreeCreationPreview["mode"];

export interface WorktreeCreationFormState {
  mode: WorktreeCreationMode;
  branchName: string;
  startPoint: string;
  targetPath: string;
  targetPathTouched: boolean;
  branches: readonly GitLocalBranch[];
  currentBranchName: null | string;
  isSourceDirty: boolean;
  preview: null | WorktreeCreationPreview;
  previewPending: boolean;
  previewSequence: number;
  previewFingerprint: null | string;
  occupiedPath: null | string;
  phase: "editing" | "creating" | "create-unknown" | "created" | "opened";
  pending: boolean;
  operationId: null | string;
  error: null | string;
  openError: null | string;
  result: null | WorktreeCreationResult;
}

export interface WorktreeCreationSession {
  sourceWorkspaceKey: string;
  workspacePath: string;
  workspaceIdentity: null | string;
  remoteSessionId: null | string;
  service: IGitService;
  allowOpenWorkspace: boolean;
  onCreated: (result: WorktreeCreationResult) => void | Promise<void>;
  onOpenOccupied?: (path: string) => void;
  operationId: string;
}

export interface UseWorktreeCreationParams {
  workspacePath: string;
  workspaceIdentity?: null | string;
  remoteSessionId?: null | string;
  allowOpenWorkspace: boolean;
  onCreated: (result: WorktreeCreationResult) => void | Promise<void>;
  onOpenOccupied?: (path: string) => void;
  nextOperationId?: () => string;
}

export interface UseWorktreeCreationResult {
  openDialog: () => void;
  refreshAvailability: () => void;
  dialog: ReactNode;
  disabledReason: null | string;
}

type WorktreeAvailability = WorktreeCreationAvailability | "waiting";

export function resolveWorktreeCreationGate(params: {
  allowOpenWorkspace: boolean;
  rpcReady: boolean;
  availability: WorktreeAvailability;
}): WorktreeAvailability {
  if (!params.allowOpenWorkspace) return "unsupported";
  if (!params.rpcReady) return "disconnected";
  return params.availability;
}

export function createInitialWorktreeCreationFormState(): WorktreeCreationFormState {
  return {
    mode: "new-branch",
    branchName: "",
    startPoint: "",
    targetPath: "",
    targetPathTouched: false,
    branches: [],
    currentBranchName: null,
    isSourceDirty: false,
    preview: null,
    previewPending: false,
    previewSequence: 0,
    previewFingerprint: null,
    occupiedPath: null,
    phase: "editing",
    pending: false,
    operationId: null,
    error: null,
    openError: null,
    result: null,
  };
}

export function createWorktreeCreationSession(params: {
  workspacePath: string;
  workspaceIdentity?: null | string;
  remoteSessionId?: null | string;
  service: IGitService;
  allowOpenWorkspace: boolean;
  onCreated: (result: WorktreeCreationResult) => void | Promise<void>;
  onOpenOccupied?: (path: string) => void;
  nextOperationId?: () => string;
}): WorktreeCreationSession {
  return {
    sourceWorkspaceKey: params.workspaceIdentity?.trim() || params.workspacePath,
    workspacePath: params.workspacePath,
    workspaceIdentity: params.workspaceIdentity?.trim() || null,
    remoteSessionId: params.remoteSessionId?.trim() || null,
    service: params.service,
    allowOpenWorkspace: params.allowOpenWorkspace,
    onCreated: params.onCreated,
    onOpenOccupied: params.onOpenOccupied,
    operationId: params.nextOperationId?.() ?? createUuid(),
  };
}

export function createWorktreeDialogSessionStore() {
  const retained = new Map<
    string,
    { session: WorktreeCreationSession; form: WorktreeCreationFormState }
  >();
  return {
    retain(session: WorktreeCreationSession, form: WorktreeCreationFormState) {
      retained.set(session.sourceWorkspaceKey, { session, form });
    },
    restore(sourceWorkspaceKey: string, currentService?: IGitService, rpcReady = false) {
      const item = retained.get(sourceWorkspaceKey);
      if (!item) return null;
      retained.delete(sourceWorkspaceKey);
      // Unknown RPC 之后，远端可能已重连并生成新的 service proxy。只有同一
      // source 且当前连接 ready 才重绑传输；操作身份与回调保持冻结。
      const shouldRebindService =
        item.form.phase === "create-unknown" && rpcReady && currentService;
      return {
        form: item.form,
        session: shouldRebindService ? { ...item.session, service: currentService! } : item.session,
      };
    },
  };
}

export function buildWorktreePreviewRequest(params: {
  workspacePath: string;
  sourceWorkspaceKey: string;
  operationId: string;
  form: Pick<
    WorktreeCreationFormState,
    "mode" | "branchName" | "startPoint" | "targetPath" | "targetPathTouched"
  >;
}): GitWorktreeCreatePreviewRequest {
  const branchName = params.form.branchName.trim();
  return {
    workspacePath: params.workspacePath,
    operationId: params.operationId,
    mode: params.form.mode,
    branchName,
    startPoint:
      params.form.mode === "new-branch" ? params.form.startPoint.trim() || "HEAD" : branchName,
    targetPath: params.form.targetPathTouched ? params.form.targetPath.trim() : undefined,
  };
}

export function createWorktreeRequestFingerprint(
  request: GitWorktreeCreatePreviewRequest,
  sourceWorkspaceKey: string,
): string {
  return JSON.stringify([sourceWorkspaceKey, request]);
}

function isUnsupportedRemoteMethod(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === -32601
  );
}

export function resolveWorktreeCreationDisabledReasonId(
  availability: WorktreeAvailability,
): string {
  switch (availability) {
    case "ready":
      return "";
    case "disconnected":
      return "worktree.create.disabled.disconnected";
    case "unsupported":
      return "worktree.create.disabled.unsupported";
    case "not-git":
      return "worktree.create.disabled.notGit";
    case "git-unavailable":
      return "worktree.create.disabled.gitUnavailable";
    case "failed":
      return "worktree.create.disabled.failed";
    default:
      return "worktree.create.disabled.waiting";
  }
}

export async function resolveWorktreeCreationAvailability(params: {
  service: IGitService;
  workspacePath: string;
}): Promise<WorktreeCreationAvailability> {
  try {
    const summary = await params.service.getRepositorySummary({
      workspacePath: params.workspacePath,
    });
    if (!summary.isRepository) {
      return summary.isGitAvailable ? "not-git" : "git-unavailable";
    }
    if (!summary.gitCommonDir) return "unsupported";
    await params.service.previewWorktreeCreation({
      workspacePath: params.workspacePath,
      operationId: createUuid(),
      mode: "new-branch",
      branchName: `codez-preview-${createUuid()}`,
      startPoint: "HEAD",
    });
    return "ready";
  } catch (error) {
    if (isRemoteWorkspaceDisconnectedError(error)) return "disconnected";
    if (isUnsupportedRemoteMethod(error)) return "unsupported";
    return "failed";
  }
}

export function reduceWorktreePreview(
  state: WorktreeCreationFormState,
  event: { preview: WorktreeCreationPreview; fingerprint: string },
): WorktreeCreationFormState {
  return {
    ...state,
    preview: event.preview,
    previewPending: false,
    previewFingerprint: event.fingerprint,
    occupiedPath: event.preview.occupiedPath,
    targetPath: state.targetPathTouched ? state.targetPath : event.preview.targetPath,
    phase: "editing",
    error: null,
  };
}

export function applyWorktreeCreateResult(
  state: WorktreeCreationFormState,
  result: WorktreeCreationResult,
): WorktreeCreationFormState {
  return { ...state, phase: "created", pending: false, result, openError: null };
}

export function canSubmitWorktreeCreation(params: {
  state: WorktreeCreationFormState;
  request: null | GitWorktreeCreatePreviewRequest;
  sourceWorkspaceKey: string;
}): boolean {
  const { state, request, sourceWorkspaceKey } = params;
  if (
    !request ||
    state.pending ||
    state.occupiedPath ||
    !state.preview ||
    !state.previewFingerprint
  ) {
    return false;
  }
  if (state.phase !== "editing" && state.phase !== "create-unknown") return false;
  return state.previewFingerprint === createWorktreeRequestFingerprint(request, sourceWorkspaceKey);
}

export async function openCreatedWorktree(params: {
  state: WorktreeCreationFormState;
  result: WorktreeCreationResult;
  onCreated: (result: WorktreeCreationResult) => void | Promise<void>;
}): Promise<WorktreeCreationFormState> {
  try {
    await params.onCreated(params.result);
    return { ...params.state, phase: "opened", pending: false, openError: null };
  } catch (error) {
    return {
      ...params.state,
      phase: "created",
      pending: false,
      openError: getErrorMessage(error),
    };
  }
}

export async function runWorktreeCreation(params: {
  service: IGitService;
  state: WorktreeCreationFormState;
  request: GitWorktreeCreatePreviewRequest;
  operationId: string;
  onCreated: (result: WorktreeCreationResult) => void | Promise<void>;
}): Promise<WorktreeCreationFormState> {
  if (
    (params.state.phase === "created" || params.state.phase === "opened") &&
    params.state.result
  ) {
    return await openCreatedWorktree({
      state: params.state,
      result: params.state.result,
      onCreated: params.onCreated,
    });
  }
  const preview = params.state.preview;
  if (!preview) {
    return { ...params.state, error: "worktree.create.error.previewMissing" };
  }
  const pendingState: WorktreeCreationFormState = {
    ...params.state,
    phase: "creating",
    pending: true,
    operationId: params.operationId,
    error: null,
    openError: null,
  };
  try {
    const result = await params.service.createWorktree({
      ...preview,
      operationId: params.operationId,
    });
    return await openCreatedWorktree({
      state: applyWorktreeCreateResult(pendingState, result),
      result,
      onCreated: params.onCreated,
    });
  } catch (error) {
    // RPC 失败后目录可能已创建：operationId 和输入必须原样保留，供同指纹安全重试。
    return {
      ...pendingState,
      phase: "create-unknown",
      pending: false,
      error: getErrorMessage(error),
    };
  }
}

export function createWorktreePreviewRequestFromForm(
  session: WorktreeCreationSession,
  form: WorktreeCreationFormState,
): GitWorktreeCreatePreviewRequest {
  return buildWorktreePreviewRequest({
    workspacePath: session.workspacePath,
    sourceWorkspaceKey: session.sourceWorkspaceKey,
    operationId: session.operationId,
    form,
  });
}

export function isWorktreeCreationInputMutable(
  state: Pick<WorktreeCreationFormState, "phase">,
): boolean {
  return state.phase === "editing";
}

export function invalidateWorktreePreview(
  state: WorktreeCreationFormState,
): WorktreeCreationFormState {
  return { ...state, preview: null, previewFingerprint: null, occupiedPath: null };
}
