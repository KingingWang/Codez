import { useCallback, useRef, useState } from "react";
import { toast } from "@/components/ui/toast.js";
import { DeleteBranchDialog } from "@/DeleteBranchDialog.js";
import { useCodezIntl } from "@/i18n/IntlProvider.js";
import { getErrorMessage } from "@/lib/errorMessage.js";
import { logger } from "@/logger.js";
import { useWorkspaceServicesResolution } from "@/hooks/useWorkspaceServices.js";
import {
  canConfirmBranchDeletion,
  createInitialBranchDeletionState,
  extractBranchDeletionIssue,
  type BranchDeletionState,
} from "./branchDeletionModel.js";

/**
 * 删除本地分支流程的所有者（specs/git-worktree-removal.md B 系列）。
 * 预览 → 确认 → deleteBranch（服务端占用/合并重查 + update-ref CAS 原子删除）。
 * branch-moved 时以错误载荷中的最新预览刷新弹层，要求重新确认。
 */

export interface UseBranchDeletionParams {
  workspacePath: string;
  workspaceIdentity?: string | null;
  remoteSessionId?: string | null;
  onDeleted: () => void;
  /** 占用阻塞态"跳转到该工作区"复用 root 打开编排。 */
  onOpenWorktreePath: (path: string) => void;
}

interface BranchDeletionSession {
  branchName: string;
}

function isUnsupportedRemoteMethod(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === -32601
  );
}

export function useBranchDeletion(params: UseBranchDeletionParams) {
  const { intl } = useCodezIntl();
  const resolution = useWorkspaceServicesResolution(
    params.workspacePath,
    params.remoteSessionId,
    params.workspaceIdentity,
  );
  const [session, setSession] = useState<BranchDeletionSession | null>(null);
  const [state, setState] = useState<BranchDeletionState>(createInitialBranchDeletionState);
  const sessionRef = useRef(session);
  sessionRef.current = session;

  const runPreview = useCallback(
    async (target: BranchDeletionSession) => {
      setState((current) => ({
        ...current,
        phase: "previewing",
        errorMessage: null,
        notice: null,
      }));
      try {
        const preview = await resolution.services.gitService.previewBranchDeletion({
          workspacePath: params.workspacePath,
          branchName: target.branchName,
        });
        if (sessionRef.current !== target) return;
        setState({
          phase: "confirm",
          preview,
          forceConfirmed: false,
          errorMessage: null,
          notice: null,
        });
      } catch (error) {
        if (sessionRef.current !== target) return;
        if (isUnsupportedRemoteMethod(error)) {
          toast(intl.formatMessage({ id: "worktree.open.unsupported" }));
          setSession(null);
          setState(createInitialBranchDeletionState());
          return;
        }
        logger.warn("[BranchDeletion] 预检失败", {
          branchName: target.branchName,
          error: getErrorMessage(error),
        });
        setState((current) => ({
          ...current,
          phase: "error",
          errorMessage: getErrorMessage(error),
        }));
      }
    },
    [intl, params.workspacePath, resolution.services.gitService],
  );

  const openDeletion = useCallback(
    (branchName: string) => {
      if (sessionRef.current) return;
      if (!resolution.rpcReady) {
        toast(intl.formatMessage({ id: "worktree.open.unsupported" }));
        return;
      }
      const next: BranchDeletionSession = { branchName };
      setSession(next);
      setState(createInitialBranchDeletionState());
      void runPreview(next);
    },
    [intl, resolution.rpcReady, runPreview],
  );

  const closeDialog = useCallback(() => {
    if (state.phase === "deleting") return;
    setSession(null);
    setState(createInitialBranchDeletionState());
  }, [state.phase]);

  const confirmDeletion = useCallback(async () => {
    const currentSession = sessionRef.current;
    if (!currentSession || !canConfirmBranchDeletion(state) || !state.preview) return;
    const preview = state.preview;
    setState({ ...state, phase: "deleting", errorMessage: null });
    try {
      await resolution.services.gitService.deleteBranch({
        workspacePath: params.workspacePath,
        branchName: currentSession.branchName,
        force: preview.isMerged !== true,
        expectedCommitHash: preview.commitHash,
      });
      if (sessionRef.current !== currentSession) return;
      params.onDeleted();
      toast(intl.formatMessage({ id: "git.branchDelete.done" }));
      setSession(null);
      setState(createInitialBranchDeletionState());
    } catch (error) {
      if (sessionRef.current !== currentSession) return;
      const issue = extractBranchDeletionIssue(error);
      if (issue?.code === "branch-moved") {
        // CAS 拒绝：以最新预览刷新并要求重新确认，新 tip 不会被删除。
        setState((previous) => ({
          ...previous,
          phase: "confirm",
          preview: issue.latestPreview ?? previous.preview,
          forceConfirmed: false,
          notice: "branch-moved",
        }));
        return;
      }
      logger.warn("[BranchDeletion] 删除失败", {
        branchName: currentSession.branchName,
        error: getErrorMessage(error),
      });
      setState((previous) => ({
        ...previous,
        phase: "error",
        errorMessage: issue?.message ?? getErrorMessage(error),
        preview: issue?.latestPreview ?? previous.preview,
      }));
    }
  }, [intl, params, resolution.services.gitService, state]);

  const dialog = session ? (
    <DeleteBranchDialog
      open
      state={state}
      onForceConfirmedChange={(checked) =>
        setState((current) => ({ ...current, forceConfirmed: checked }))
      }
      onConfirm={() => void confirmDeletion()}
      onCancel={closeDialog}
      onRetry={() => void runPreview(session)}
      onJumpToWorkspace={(path) => {
        params.onOpenWorktreePath(path);
        closeDialog();
      }}
    />
  ) : null;

  return { openDeletion, dialog };
}
