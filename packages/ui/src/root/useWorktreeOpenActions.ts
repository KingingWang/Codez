import { useCallback, useRef } from "react";
import { toast } from "@/components/ui/toast.js";
import { getErrorMessage } from "@/lib/errorMessage.js";
import type { WorktreeDiscoveryEntry } from "@/lib/projectGrouping.js";
import { logger } from "@/logger.js";
import { resolveAnchorRemoteTarget, resolveWorktreeOpenRoute } from "@/root/worktreeOpenIntent.js";
import type { TabStore } from "@/store/tabStore.js";

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
}

export function useWorktreeOpenActions({
  intl,
  tabStoreApi,
  allowOpenWorkspace,
  handleSelectProject,
  handleOpenDiscoveredRemoteWorktree,
}: {
  intl: ReturnType<typeof import("@/i18n/IntlProvider.js").useCodezIntl>["intl"];
  tabStoreApi: TabStore;
  allowOpenWorkspace: boolean;
  handleSelectProject: (path: string) => Promise<void>;
  handleOpenDiscoveredRemoteWorktree: (params: {
    anchorWorkspaceKey: string;
    remoteTarget: import("@codez/shared").RemoteTarget;
    workspacePath: string;
  }) => Promise<void>;
}) {
  // 重复打开保护（R5）：同一目标身份的在途打开直接复用在途过程，不重复建连。
  const inflightOpenKeysRef = useRef(new Set<string>());

  const handleOpenWorktreeEntry = useCallback(
    (request: OpenWorktreeEntryRequest) => {
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
      switch (route.kind) {
        case "activate":
          // 已打开 → 只激活既有实例，保留会话、草稿与布局，不进 startDraft。
          tabStoreApi.getState().activateTab(route.tabId);
          return;
        case "open-local":
          void handleSelectProject(route.workspacePath);
          return;
        case "open-remote": {
          if (inflightOpenKeysRef.current.has(route.workspaceIdentity)) {
            return;
          }
          inflightOpenKeysRef.current.add(route.workspaceIdentity);
          void handleOpenDiscoveredRemoteWorktree({
            anchorWorkspaceKey: route.anchorWorkspaceKey,
            remoteTarget: route.remoteTarget,
            workspacePath: route.workspacePath,
          })
            .catch((error: unknown) => {
              logger.warn("[Root] 打开发现的远程 worktree 失败", {
                workspacePath: route.workspacePath,
                error,
              });
              toast(getErrorMessage(error));
            })
            .finally(() => {
              inflightOpenKeysRef.current.delete(route.workspaceIdentity);
            });
          return;
        }
        case "unsupported":
          // R15：能力缺失呈现明确文案，不假装成功也不静默无响应。
          toast(intl.formatMessage({ id: "worktree.open.unsupported" }));
          return;
      }
    },
    [
      allowOpenWorkspace,
      handleOpenDiscoveredRemoteWorktree,
      handleSelectProject,
      intl,
      tabStoreApi,
    ],
  );

  return { handleOpenWorktreeEntry };
}
