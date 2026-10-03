import { useCallback, useRef } from "react";
import { toast } from "@/components/ui/toast.js";
import { getErrorMessage } from "@/lib/errorMessage.js";
import type { WorktreeDiscoveryEntry } from "@/lib/projectGrouping.js";
import { logger } from "@/logger.js";
import { resolveAnchorRemoteTarget, resolveWorktreeOpenRoute } from "@/root/worktreeOpenIntent.js";
import type { TabStore } from "@/store/tabStore.js";
import { isWorkspaceTab } from "@/store/tabStore.js";
import { executeWorktreeOpenRoute } from "@/root/worktreeOpenExecution.js";

/**
 * 发现条目的打开编排（specs/git-worktree-projects.md R5）。
 * 意图适配、能力门控、目标身份解析与重复打开保护集中在这一处：
 * 决策本身在纯函数 worktreeOpenIntent 中，这里只负责分发到既有打开能力
 * （activateTab / handleSelectProject / 远程打开流程），不新增底层打开机制。
 */

export interface OpenWorktreeEntryRequest {
  entry: WorktreeDiscoveryEntry;
  /** 项目分组全部成员的 workspaceKey（identity || path），用于解析远程锚点。 */
  projectMemberKeys: readonly string[];
  /** 项目分组的来源作用域是否为远端（分组层事实）。 */
  isRemoteScope: boolean;
  intent?: "open" | "new-session";
}

export function useWorktreeOpenActions({
  intl,
  tabStoreApi,
  allowOpenWorkspace,
  handleSelectProject,
  handleOpenDiscoveredRemoteWorktree,
  startDraftInWorkspace,
}: {
  intl: ReturnType<typeof import("@/i18n/IntlProvider.js").useCodezIntl>["intl"];
  tabStoreApi: TabStore;
  allowOpenWorkspace: boolean;
  handleSelectProject: (path: string, options?: { throwOnError?: boolean }) => Promise<void>;
  startDraftInWorkspace: (path: string, identity?: string) => void;
  handleOpenDiscoveredRemoteWorktree: (params: {
    anchorWorkspaceKey: string;
    remoteTarget: import("@codez/shared").RemoteTarget;
    workspacePath: string;
  }) => Promise<void>;
}) {
  // 重复打开保护（R5）：同一目标身份的在途打开直接复用在途过程，不重复建连。
  const inflightOpenKeysRef = useRef(new Map<string, Promise<void>>());

  const handleOpenWorktreeEntry = useCallback(
    async (request: OpenWorktreeEntryRequest) => {
      const tabs = tabStoreApi.getState().tabs;
      const route = resolveWorktreeOpenRoute({
        entry: request.entry,
        tabs,
        allowOpenWorkspace,
        projectMemberKeys: request.projectMemberKeys,
        isRemoteScope: request.isRemoteScope,
        anchor: resolveAnchorRemoteTarget({
          tabs,
          projectMemberKeys: request.projectMemberKeys,
        }),
      });
      try {
        await executeWorktreeOpenRoute({
          route,
          intent: request.intent,
          inflight: inflightOpenKeysRef.current,
          actions: {
            activate: (id) => tabStoreApi.getState().activateTab(id),
            startDraft: (id) => {
              const tab = tabStoreApi.getState().tabs.find((item) => item.id === id);
              if (tab && isWorkspaceTab(tab)) {
                startDraftInWorkspace(tab.workspacePath, tab.workspaceIdentity);
              }
            },
            openLocal: (path) => handleSelectProject(path, { throwOnError: true }),
            openRemote: (target) =>
              handleOpenDiscoveredRemoteWorktree({
                anchorWorkspaceKey: target.anchorWorkspaceKey,
                remoteTarget: target.remoteTarget,
                workspacePath: target.workspacePath,
              }),
          },
        });
      } catch (error) {
        logger.warn("[Root] 打开独立工作区失败", { workspacePath: request.entry.path, error });
        toast(
          route.kind === "unsupported"
            ? intl.formatMessage({ id: "worktree.open.unsupported" })
            : getErrorMessage(error),
        );
        throw error;
      }
    },
    [
      allowOpenWorkspace,
      handleOpenDiscoveredRemoteWorktree,
      handleSelectProject,
      intl,
      tabStoreApi,
      startDraftInWorkspace,
    ],
  );

  return { handleOpenWorktreeEntry };
}
