import { useCallback, useRef, useState } from "react";
import { createUuid, type GitWorktreeRemoveRequest } from "@codez/shared";
import { toast } from "@/components/ui/toast.js";
import { RemoveWorktreeDialog } from "@/RemoveWorktreeDialog.js";
import { useCodezIntl } from "@/i18n/IntlProvider.js";
import { getErrorMessage } from "@/lib/errorMessage.js";
import { normalizeWorkspacePathForComparison } from "@/lib/projectGrouping.js";
import { isRemoteWorkspaceDisconnectedError } from "@/lib/remoteWorkspaceServiceError.js";
import {
  closeWorkspaceTabsBeforeRemoval,
  quarantineWorkspaceRemovalTargets,
  releaseWorkspaceRemovalHolds,
  releaseWorkspaceRuntimeBeforeRemoval,
} from "@/lib/workspaceRuntimeRelease.js";
import { hasRunningWorkspaceChat } from "@/lib/workspaceRemovalSafety.js";
import { logger } from "@/logger.js";
import { useCodezSessionStore } from "@/store/codezSessionStore.js";
import { useTabStoreApi } from "@/store/TabStoreProvider.js";
import { isWorkspaceTab } from "@/store/tabStore.js";
import { invalidateTaskQueryCacheByScopes } from "@/store/taskQueryCacheStore.js";
import {
  buildWorktreeRemovalGuardKey,
  useWorktreeRemovalGuardStore,
} from "@/store/worktreeRemovalGuardStore.js";
import type { WorktreeDiscoveryEntry } from "@/lib/projectGrouping.js";
import { useWorkspaceServicesResolution } from "@/hooks/useWorkspaceServices.js";
import {
  canConfirmWorktreeRemoval,
  createInitialWorktreeRemovalState,
  extractWorktreeRemovalIssue,
  type WorktreeRemovalState,
  type WorktreeRemovalUiFacts,
} from "./worktreeRemovalModel.js";
import { useWorktreeRemovalTargets } from "./useWorktreeRemovalTargets.js";

/**
 * 删除工作树流程的唯一所有者（specs/git-worktree-removal.md）。
 * 事件顺序：预检（只读）→ 确认弹层 → W8 复检当前/运行中 → 注册"删除中"守卫
 * → W5 完整关闭编排（先释放后删除）→ removeWorktree（服务端复检台账+指纹）。
 * 结果未知态按原 operationId 重放；明确失败的重试走重新预检。
 */

export interface UseWorktreeRemovalParams {
  /** 当前 shell 工作区（preview/remove 的 anchor，决定执行 Host）。 */
  workspacePath: string;
  workspaceIdentity?: string | null;
  remoteSessionId?: string | null;
  /** 项目分组 scope（本地常量或远端 authority）；未知时容错跳过守卫注册。 */
  projectScope: string | null;
  /** 项目全部已打开成员的 workspaceKey（identity || path），用于同作用域匹配。 */
  projectMemberKeys: readonly string[];
  onRemoved: () => void;
  /** 阻塞态"跳转到该工作区"复用 root 打开编排。 */
  onOpenWorktreePath: (path: string) => void;
}

interface WorktreeRemovalSession {
  entry: WorktreeDiscoveryEntry;
  operationId: string;
  /** 最后一次 remove 请求原文，结果未知重放必须逐字节一致（W7）。 */
  lastRequest: GitWorktreeRemoveRequest | null;
}

function isUnsupportedRemoteMethod(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === -32601
  );
}

export function useWorktreeRemoval(params: UseWorktreeRemovalParams) {
  const { intl } = useCodezIntl();
  const resolution = useWorkspaceServicesResolution(
    params.workspacePath,
    params.remoteSessionId,
    params.workspaceIdentity,
  );
  const tabStoreApi = useTabStoreApi();
  const { resolveTabTaskService, collectRemovalHoldTargets } = useWorktreeRemovalTargets({
    workspacePath: params.workspacePath,
    workspaceIdentity: params.workspaceIdentity,
    remoteSessionId: params.remoteSessionId,
    codezTaskService: resolution.services.codezTaskService,
  });
  const [session, setSession] = useState<WorktreeRemovalSession | null>(null);
  const [state, setState] = useState<WorktreeRemovalState>(createInitialWorktreeRemovalState);
  const sessionRef = useRef(session);
  const stateRef = useRef(state);
  sessionRef.current = session;
  stateRef.current = state;
  // 结果未知关闭弹层后保留会话，下次对同一目标打开时恢复（对齐创建链路的冻结语义）。
  const retainedRef = useRef(
    new Map<string, { session: WorktreeRemovalSession; state: WorktreeRemovalState }>(),
  );

  /** UI 侧事实实时计算（W8）：当前/已打开/运行中，含树下子目录 tab。 */
  const computeUiFacts = useCallback(
    (entry: WorktreeDiscoveryEntry): WorktreeRemovalUiFacts => {
      const normalizedTarget = normalizeWorkspacePathForComparison(entry.path);
      const memberKeys = new Set(params.projectMemberKeys);
      const currentKey = params.workspaceIdentity?.trim() || params.workspacePath;
      const sessionStore = useCodezSessionStore.getState();
      const matched: {
        tabId: string;
        workspacePath: string;
        workspaceIdentity: string | null;
        hasRunning: boolean;
      }[] = [];
      for (const tab of tabStoreApi.getState().tabs) {
        if (!isWorkspaceTab(tab)) continue;
        const key = tab.workspaceIdentity?.trim() || tab.workspacePath;
        if (!memberKeys.has(key)) continue;
        const tabPath = normalizeWorkspacePathForComparison(tab.workspacePath);
        if (tabPath !== normalizedTarget && !tabPath.startsWith(`${normalizedTarget}/`)) continue;
        const workspaceState = sessionStore.getWorkspaceState(
          tab.workspacePath,
          tab.workspaceIdentity?.trim() || undefined,
        );
        matched.push({
          tabId: tab.id,
          workspacePath: tab.workspacePath,
          workspaceIdentity: tab.workspaceIdentity?.trim() || null,
          hasRunning: hasRunningWorkspaceChat({ workspaceState, taskItems: [] }),
        });
      }
      const currentPath = normalizeWorkspacePathForComparison(params.workspacePath);
      const isCurrent =
        memberKeys.has(currentKey) &&
        (currentPath === normalizedTarget || currentPath.startsWith(`${normalizedTarget}/`));
      return {
        isCurrent,
        openTabs: matched.map(({ tabId, workspacePath, workspaceIdentity }) => ({
          tabId,
          workspacePath,
          workspaceIdentity,
        })),
        hasRunning: matched.some((item) => item.hasRunning),
      };
    },
    [params.projectMemberKeys, params.workspaceIdentity, params.workspacePath, tabStoreApi],
  );

  /**
   * W5 完整关闭编排，禁止仅 closeTab。顺序：先解析每个 tab 的 taskService
   *（tab 关闭后 remoteSessionId 取不到，远程会错落本地服务）→ 等待全部 runtime
   * 释放完成 → 关闭 tab。失败保留 tab，避免重试因找不到旧 tab 而跳过释放。
   */
  const closeTabsForRemoval = useCallback(
    async (openTabs: WorktreeRemovalUiFacts["openTabs"]) => {
      await closeWorkspaceTabsBeforeRemoval({
        tabs: openTabs,
        resolveTaskService: resolveTabTaskService,
        closeTab: (tabId) => tabStoreApi.getState().closeTab(tabId),
        unavailableMessage: intl.formatMessage({ id: "worktree.remove.releaseUnavailable" }),
      });
      if (openTabs.length > 0) {
        invalidateTaskQueryCacheByScopes(
          openTabs.map((tab) => ({
            workspacePath: tab.workspacePath,
            ...(tab.workspaceIdentity ? { workspaceIdentity: tab.workspaceIdentity } : {}),
          })),
        );
      }
    },
    [intl, resolveTabTaskService, tabStoreApi],
  );

  const runPreview = useCallback(
    async (target: WorktreeRemovalSession) => {
      setState((current) => ({
        ...current,
        phase: "previewing",
        errorMessage: null,
        notice: null,
        uiFacts: computeUiFacts(target.entry),
      }));
      try {
        const preview = await resolution.services.gitService.previewWorktreeRemoval({
          workspacePath: params.workspacePath,
          targetPath: target.entry.path,
          operationId: target.operationId,
        });
        if (sessionRef.current !== target) return;
        setState((current) => ({
          ...current,
          phase: "confirm",
          preview,
          confirmDiscardChanges: false,
          confirmDiscardDetachedHead: false,
          uiFacts: computeUiFacts(target.entry),
        }));
      } catch (error) {
        if (sessionRef.current !== target) return;
        if (isUnsupportedRemoteMethod(error)) {
          toast(intl.formatMessage({ id: "worktree.open.unsupported" }));
          setSession(null);
          setState(createInitialWorktreeRemovalState());
          return;
        }
        logger.warn("[WorktreeRemoval] 预检失败", {
          targetPath: target.entry.path,
          error: getErrorMessage(error),
        });
        setState((current) => ({
          ...current,
          phase: "error",
          errorMessage: getErrorMessage(error),
        }));
      }
    },
    [computeUiFacts, intl, params.workspacePath, resolution.services.gitService],
  );

  const openRemoval = useCallback(
    (entry: WorktreeDiscoveryEntry) => {
      if (sessionRef.current) return;
      if (!resolution.rpcReady) {
        toast(intl.formatMessage({ id: "worktree.open.unsupported" }));
        return;
      }
      const retained = retainedRef.current.get(entry.path);
      if (retained) {
        retainedRef.current.delete(entry.path);
        setSession(retained.session);
        setState(retained.state);
        return;
      }
      const next: WorktreeRemovalSession = {
        entry,
        operationId: createUuid(),
        lastRequest: null,
      };
      setSession(next);
      setState(createInitialWorktreeRemovalState());
      void runPreview(next);
    },
    [intl, resolution.rpcReady, runPreview],
  );

  const closeDialog = useCallback(() => {
    const current = stateRef.current;
    const currentSession = sessionRef.current;
    if (current.phase === "removing" || !currentSession) return;
    if (current.phase === "result-unknown") {
      retainedRef.current.set(currentSession.entry.path, {
        session: currentSession,
        state: current,
      });
    }
    setSession(null);
    setState(createInitialWorktreeRemovalState());
  }, []);

  /**
   * 删除执行的唯一入口（首次确认与结果未知重放共用）：W8 执行窗口复检 →
   * 注册删除中守卫 → W5 关闭编排（await，失败中止）→ removeWorktree。
   * 结果未知重放同样走完整门控（审查 ③）：目标被重新激活或出现运行中任务时
   * 回落确认态，不发起 RPC。
   */
  const executeRemoval = useCallback(
    async (target: WorktreeRemovalSession, request: GitWorktreeRemoveRequest) => {
      const current = stateRef.current;
      // W8 执行窗口保护：执行前重新判定当前/运行中，变化则回落到阻塞态，不发起 RPC。
      const freshFacts = computeUiFacts(target.entry);
      if (freshFacts.isCurrent || freshFacts.hasRunning) {
        setState({ ...current, uiFacts: freshFacts, phase: "confirm" });
        return;
      }
      setState({ ...current, uiFacts: freshFacts, phase: "removing", errorMessage: null });

      const scope = params.projectScope;
      const guardKey = scope
        ? buildWorktreeRemovalGuardKey(
            scope,
            normalizeWorkspacePathForComparison(target.entry.path),
          )
        : null;
      if (guardKey) useWorktreeRemovalGuardStore.getState().markDeleting(guardKey);
      const { rootTarget, holdTargets } = collectRemovalHoldTargets(
        target.entry,
        freshFacts.openTabs,
      );
      try {
        // 服务缺失 = 无法隔离/释放，Windows 持锁删目录会失败；中止且不关闭任何 tab。
        if (holdTargets.some((holdTarget) => !holdTarget.codezTaskService)) {
          throw new Error(intl.formatMessage({ id: "worktree.remove.releaseUnavailable" }));
        }
        // W5a：先隔离全部目标的 agent spawn 准入，闭合释放→删除之间的 respawn 竞态。
        await quarantineWorkspaceRemovalTargets(holdTargets);
        // W5：目标树根自身 runtime 无论有无 tab 都要先释放（Windows 目录占用）。
        await releaseWorkspaceRuntimeBeforeRemoval({
          tab: {
            workspacePath: rootTarget.workspacePath,
            workspaceIdentity: rootTarget.workspaceIdentity ?? undefined,
          },
          codezTaskService: resolution.services.codezTaskService,
        });
        // W5：tab 关闭编排（释放 + closeTab + 缓存失效）必须完成后才物理删除。
        await closeTabsForRemoval(freshFacts.openTabs);
        await resolution.services.gitService.removeWorktree(request);
        if (sessionRef.current !== target) return;
        params.onRemoved();
        toast(intl.formatMessage({ id: "worktree.remove.done" }));
        setSession(null);
        setState(createInitialWorktreeRemovalState());
      } catch (error) {
        if (sessionRef.current !== target) return;
        const issue = extractWorktreeRemovalIssue(error);
        if (issue?.code === "status-changed") {
          // 错误载荷携带最新预览：刷新清单、清空勾选，要求重新确认。
          setState((previous) => ({
            ...previous,
            phase: "confirm",
            preview: issue.latestPreview ?? previous.preview,
            confirmDiscardChanges: false,
            confirmDiscardDetachedHead: false,
            notice: "status-changed",
            uiFacts: computeUiFacts(target.entry),
          }));
          return;
        }
        if (isRemoteWorkspaceDisconnectedError(error)) {
          // 删除可能已执行但响应丢失：冻结原请求，重试按原 operationId 重放（W7）。
          setState((previous) => ({ ...previous, phase: "result-unknown", errorMessage: null }));
          return;
        }
        logger.warn("[WorktreeRemoval] 删除失败", {
          targetPath: target.entry.path,
          error: getErrorMessage(error),
        });
        setState((previous) => ({
          ...previous,
          phase: "error",
          errorMessage: issue?.message ?? getErrorMessage(error),
          preview: issue?.latestPreview ?? previous.preview,
        }));
      } finally {
        if (guardKey) useWorktreeRemovalGuardStore.getState().unmarkDeleting(guardKey);
        // W5a：隔离必须成对解除；best-effort，不掩盖删除结果。部分隔离成功时
        // 对未隔离目标的解除是无害 no-op。
        await releaseWorkspaceRemovalHolds(holdTargets);
      }
    },
    [
      closeTabsForRemoval,
      collectRemovalHoldTargets,
      computeUiFacts,
      intl,
      params,
      resolution.services.codezTaskService,
      resolution.services.gitService,
    ],
  );

  const confirmRemoval = useCallback(async () => {
    const currentSession = sessionRef.current;
    const current = stateRef.current;
    if (!currentSession || !canConfirmWorktreeRemoval(current) || !current.preview) return;

    const preview = current.preview;
    const request: GitWorktreeRemoveRequest = {
      workspacePath: params.workspacePath,
      targetPath: currentSession.entry.path,
      operationId: currentSession.operationId,
      expectedFingerprint: preview.statusFingerprint,
      allowDiscardChanges: current.confirmDiscardChanges,
      allowDiscardDetachedHead: current.confirmDiscardDetachedHead,
    };
    const nextSession = { ...currentSession, lastRequest: request };
    setSession(nextSession);
    sessionRef.current = nextSession;
    await executeRemoval(nextSession, request);
  }, [executeRemoval, params.workspacePath]);

  /** 结果未知：按冻结的原请求重放，服务端经操作记录幂等裁决（W7）。 */
  const retryUnknownRemoval = useCallback(async () => {
    const currentSession = sessionRef.current;
    const current = stateRef.current;
    if (!currentSession?.lastRequest || current.phase !== "result-unknown") return;
    await executeRemoval(currentSession, currentSession.lastRequest);
  }, [executeRemoval]);

  /**
   * 明确失败后的重试视为新操作（审查 ⑤）：旧 operationId 可能已留下 reserved
   * 记录，文件变化后的新请求指纹会触发 operation-conflict；换新 ID 重新预检。
   */
  const retryAfterFailure = useCallback(
    (entry: WorktreeDiscoveryEntry) => {
      const next: WorktreeRemovalSession = {
        entry,
        operationId: createUuid(),
        lastRequest: null,
      };
      setSession(next);
      sessionRef.current = next;
      void runPreview(next);
    },
    [runPreview],
  );

  const dialog = session ? (
    <RemoveWorktreeDialog
      open
      state={state}
      onConfirmDiscardChanges={(checked) =>
        setState((current) => ({ ...current, confirmDiscardChanges: checked }))
      }
      onConfirmDiscardDetachedHead={(checked) =>
        setState((current) => ({ ...current, confirmDiscardDetachedHead: checked }))
      }
      onConfirm={() => void confirmRemoval()}
      onCancel={closeDialog}
      onRetry={() => retryAfterFailure(session.entry)}
      onRetryUnknown={() => void retryUnknownRemoval()}
      onJumpToWorkspace={(path) => {
        params.onOpenWorktreePath(path);
        closeDialog();
      }}
    />
  ) : null;

  return { openRemoval, dialog };
}
