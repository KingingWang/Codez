import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { IGitService } from "@codez/services";
import { CreateWorktreeDialog } from "@/CreateWorktreeDialog.js";
import { useWorkspaceServicesResolution } from "@/hooks/useWorkspaceServices.js";
import { useCodezIntl } from "@/i18n/IntlProvider.js";
import { getErrorMessage } from "@/lib/errorMessage.js";
import { logger } from "@/logger.js";
import {
  createInitialWorktreeCreationFormState,
  createWorktreeCreationSession,
  createWorktreeDialogSessionStore,
  createWorktreePreviewRequestFromForm,
  createWorktreeRequestFingerprint,
  resolveWorktreeCreationAvailability,
  resolveWorktreeCreationDisabledReasonId,
  runWorktreeCreation,
  invalidateWorktreePreview,
  isWorktreeCreationInputMutable,
  resolveWorktreeCreationGate,
  buildWorktreePreviewRequest,
  reduceWorktreePreview,
  openCreatedWorktree,
  type UseWorktreeCreationParams,
  type UseWorktreeCreationResult,
  type WorktreeCreationAvailability,
  type WorktreeCreationFormState,
  type WorktreeCreationSession,
} from "./worktreeCreationModel.js";

export {
  applyWorktreeCreateResult,
  buildWorktreePreviewRequest,
  canSubmitWorktreeCreation,
  createInitialWorktreeCreationFormState,
  createWorktreeCreationSession,
  createWorktreeDialogSessionStore,
  createWorktreeRequestFingerprint,
  reduceWorktreePreview,
  resolveWorktreeCreationAvailability,
  resolveWorktreeCreationDisabledReasonId,
  isWorktreeCreationInputMutable,
  runWorktreeCreation,
} from "./worktreeCreationModel.js";
export type {
  WorktreeCreationAvailability,
  WorktreeCreationFormState,
  WorktreeCreationMode,
  WorktreeCreationPreview,
  WorktreeCreationResult,
  WorktreeCreationSession,
  UseWorktreeCreationParams,
  UseWorktreeCreationResult,
} from "./worktreeCreationModel.js";

async function loadWorktreeFormFacts(params: {
  service: IGitService;
  workspacePath: string;
  form: WorktreeCreationFormState;
  onState: (state: WorktreeCreationFormState) => void;
  isCancelled: () => boolean;
}): Promise<void> {
  try {
    const [summary, branches] = await Promise.all([
      params.service.getRepositorySummary({ workspacePath: params.workspacePath }),
      params.service.getLocalBranches({ workspacePath: params.workspacePath }),
    ]);
    if (params.isCancelled()) return;
    params.onState({
      ...params.form,
      branches: branches.branches,
      currentBranchName: branches.currentBranchName,
      isSourceDirty: summary.isDirty,
      startPoint: params.form.startPoint || branches.currentBranchName || "HEAD",
    });
  } catch (error) {
    if (params.isCancelled()) return;
    logger.warn("[WorktreeCreation] 读取表单 Git 状态失败", {
      workspacePath: params.workspacePath,
      error: getErrorMessage(error),
    });
    params.onState({ ...params.form, previewPending: false, error: getErrorMessage(error) });
  }
}

function isUnsupportedRemoteMethod(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === -32601
  );
}

async function createWorktreePreviewForm(params: {
  service: IGitService;
  session: WorktreeCreationSession;
  form: WorktreeCreationFormState;
  onState: (state: WorktreeCreationFormState) => void;
  isCancelled: () => boolean;
}): Promise<void> {
  const request = buildWorktreePreviewRequest({
    workspacePath: params.session.workspacePath,
    sourceWorkspaceKey: params.session.sourceWorkspaceKey,
    operationId: params.session.operationId,
    form: params.form,
  });
  try {
    const preview = await params.service.previewWorktreeCreation(request);
    if (params.isCancelled()) return;
    params.onState(
      reduceWorktreePreview(params.form, {
        preview,
        fingerprint: createWorktreeRequestFingerprint(request, params.session.sourceWorkspaceKey),
      }),
    );
  } catch (error) {
    if (params.isCancelled()) return;
    params.onState({
      ...params.form,
      preview: null,
      previewPending: false,
      previewFingerprint: null,
      occupiedPath: null,
      error: isUnsupportedRemoteMethod(error)
        ? "worktree.create.error.unsupported"
        : getErrorMessage(error),
    });
  }
}

const PREVIEW_DEBOUNCE_MS = 250;

export function shouldCloseAfterWorktreeCreation(
  phase: WorktreeCreationFormState["phase"],
): boolean {
  return phase === "opened";
}

export function useWorktreeCreation(params: UseWorktreeCreationParams): UseWorktreeCreationResult {
  const { workspacePath, workspaceIdentity, remoteSessionId } = params;
  const resolution = useWorkspaceServicesResolution(
    workspacePath,
    remoteSessionId,
    workspaceIdentity,
  );
  const { intl } = useCodezIntl();
  const [session, setSession] = useState<WorktreeCreationSession | null>(null);
  const [form, setForm] = useState<WorktreeCreationFormState>(
    createInitialWorktreeCreationFormState,
  );
  const [availability, setAvailability] = useState<WorktreeCreationAvailability | "waiting">(
    "waiting",
  );
  const [availabilityInput, setAvailabilityInput] = useState<null | {
    service: IGitService;
    workspacePath: string;
  }>(null);
  const formRef = useRef(form);
  const sessionRef = useRef(session);
  const retainedRef = useRef(createWorktreeDialogSessionStore());
  const createInFlightRef = useRef(false);
  formRef.current = form;
  sessionRef.current = session;

  const sourceWorkspaceKey = workspaceIdentity?.trim() || workspacePath;
  const effectiveAvailability = resolveWorktreeCreationGate({
    allowOpenWorkspace: params.allowOpenWorkspace,
    rpcReady: resolution.rpcReady,
    availability,
  });
  const refreshAvailability = useCallback(() => {
    if (sessionRef.current || !params.allowOpenWorkspace || !resolution.rpcReady) return;
    // 菜单展开只重读已连接服务，可恢复瞬时探测失败，不挂载其他树或另建连接。
    setAvailabilityInput({ service: resolution.services.gitService, workspacePath });
  }, [
    params.allowOpenWorkspace,
    resolution.rpcReady,
    resolution.services.gitService,
    workspacePath,
  ]);
  useEffect(() => {
    if (session || !params.allowOpenWorkspace || !resolution.rpcReady) return;
    setAvailability("waiting");
    setAvailabilityInput({ service: resolution.services.gitService, workspacePath });
  }, [
    params.allowOpenWorkspace,
    resolution.rpcReady,
    resolution.services.gitService,
    session,
    workspacePath,
  ]);

  useEffect(() => {
    if (!availabilityInput) return;
    let cancelled = false;
    void resolveWorktreeCreationAvailability(availabilityInput)
      .then((result) => {
        if (!cancelled) setAvailability(result);
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        logger.warn("[WorktreeCreation] 能力探测失败", {
          workspacePath: availabilityInput.workspacePath,
          error: getErrorMessage(error),
        });
        setAvailability("failed");
      });
    return () => {
      cancelled = true;
    };
  }, [availabilityInput]);

  const openDialog = useCallback(() => {
    // Git 能力可用不等于平台允许打开；手机远控必须在创建写入之前阻断。
    if (effectiveAvailability !== "ready") return;
    if (sessionRef.current) return;
    const retained = retainedRef.current.restore(
      sourceWorkspaceKey,
      resolution.services.gitService,
      resolution.rpcReady,
    );
    if (retained) {
      setSession(retained.session);
      setForm(retained.form);
      setAvailability("ready");
      return;
    }
    if (availability !== "ready" || !resolution.rpcReady) return;
    const nextSession = createWorktreeCreationSession({
      workspacePath,
      workspaceIdentity,
      remoteSessionId,
      service: resolution.services.gitService,
      allowOpenWorkspace: params.allowOpenWorkspace,
      onCreated: params.onCreated,
      onOpenOccupied: params.onOpenOccupied,
      nextOperationId: params.nextOperationId,
    });
    setSession(nextSession);
    setForm(createInitialWorktreeCreationFormState());
  }, [
    availability,
    effectiveAvailability,
    params,
    resolution.rpcReady,
    resolution.services.gitService,
    remoteSessionId,
    sourceWorkspaceKey,
    workspaceIdentity,
    workspacePath,
  ]);

  useEffect(() => {
    if (!session || !isWorktreeCreationInputMutable(formRef.current)) return;
    let cancelled = false;
    void loadWorktreeFormFacts({
      service: session.service,
      workspacePath: session.workspacePath,
      form: formRef.current,
      onState: setForm,
      isCancelled: () => cancelled || sessionRef.current !== session,
    });
    return () => {
      cancelled = true;
    };
  }, [session]);

  useEffect(() => {
    const canPreview = Boolean(
      session && isWorktreeCreationInputMutable(form) && form.branchName.trim(),
    );
    if (!canPreview) return;
    const sequence = form.previewSequence + 1;
    let cancelled = false;
    setForm((current) => ({ ...current, previewPending: true, previewSequence: sequence }));
    const timer = window.setTimeout(() => {
      if (!session || cancelled) return;
      void createWorktreePreviewForm({
        service: session.service,
        session,
        form: formRef.current,
        onState: setForm,
        isCancelled: () => cancelled || sessionRef.current !== session,
      });
    }, PREVIEW_DEBOUNCE_MS);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [
    form.branchName,
    form.mode,
    form.phase,
    form.startPoint,
    form.targetPath,
    form.targetPathTouched,
    session,
  ]);

  const currentRequest = useMemo(
    () => (session ? createWorktreePreviewRequestFromForm(session, form) : null),
    [form, session],
  );

  const submit = useCallback(() => {
    if (
      effectiveAvailability !== "ready" ||
      !session ||
      !currentRequest ||
      createInFlightRef.current
    )
      return;
    createInFlightRef.current = true;
    setForm((current) => ({ ...current, pending: true, error: null, openError: null }));
    void runWorktreeCreation({
      service: session.service,
      state: { ...formRef.current, pending: true },
      request: currentRequest,
      operationId: session.operationId,
      onCreated: session.onCreated,
    })
      .then((next) => {
        if (sessionRef.current !== session) return;
        if (shouldCloseAfterWorktreeCreation(next.phase)) {
          setSession(null);
          setForm(createInitialWorktreeCreationFormState());
          setAvailability("waiting");
          setAvailabilityInput(null);
          return;
        }
        setForm(next);
      })
      .finally(() => {
        createInFlightRef.current = false;
      });
  }, [currentRequest, effectiveAvailability, session]);

  const retryOpen = useCallback(() => {
    if (!session || !form.result || createInFlightRef.current) return;
    createInFlightRef.current = true;
    setForm((current) => ({ ...current, pending: true, openError: null }));
    void openCreatedWorktree({
      state: { ...formRef.current, pending: true },
      result: form.result,
      onCreated: session.onCreated,
    })
      .then((next) => {
        if (sessionRef.current !== session) return;
        if (shouldCloseAfterWorktreeCreation(next.phase)) {
          setSession(null);
          setForm(createInitialWorktreeCreationFormState());
          setAvailability("waiting");
          setAvailabilityInput(null);
          return;
        }
        setForm(next);
      })
      .finally(() => {
        createInFlightRef.current = false;
      });
  }, [form.result, session]);

  const closeDialog = useCallback(() => {
    const current = formRef.current;
    if (current.pending || !sessionRef.current) return;
    if (current.phase === "create-unknown" || current.phase === "created") {
      retainedRef.current.retain(sessionRef.current, current);
    }
    setSession(null);
    setForm(createInitialWorktreeCreationFormState());
    setAvailability("waiting");
    setAvailabilityInput(null);
  }, []);

  const disabledReason =
    effectiveAvailability === "ready"
      ? null
      : intl.formatMessage({ id: resolveWorktreeCreationDisabledReasonId(effectiveAvailability) });

  const dialog = session ? (
    <CreateWorktreeDialog
      open
      workspacePath={session.workspacePath}
      state={form}
      availability={effectiveAvailability}
      disabledReason={disabledReason}
      onModeChange={(mode) => setForm((current) => invalidateWorktreePreview({ ...current, mode }))}
      onBranchNameChange={(branchName) =>
        setForm((current) => invalidateWorktreePreview({ ...current, branchName }))
      }
      onStartPointChange={(startPoint) =>
        setForm((current) => invalidateWorktreePreview({ ...current, startPoint }))
      }
      onTargetPathChange={(targetPath) =>
        setForm((current) =>
          invalidateWorktreePreview({
            ...current,
            targetPath,
            targetPathTouched: targetPath.trim().length > 0,
          }),
        )
      }
      onSubmit={submit}
      onRetryOpen={retryOpen}
      onCancel={closeDialog}
      onOpenOccupied={(path) => session.onOpenOccupied?.(path)}
    />
  ) : null;

  return { openDialog, dialog, disabledReason, refreshAvailability };
}
