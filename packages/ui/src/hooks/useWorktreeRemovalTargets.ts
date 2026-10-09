import { useCallback } from "react";
import type { ICodezTaskService } from "@codez/services";
import { buildRemoteWorkspaceIdentity } from "@/lib/remoteWorkspaceHistory.js";
import {
  normalizeWorkspacePathForComparison,
  type WorktreeDiscoveryEntry,
} from "@/lib/projectGrouping.js";
import type { WorkspaceRemovalHoldTarget } from "@/lib/workspaceRuntimeRelease.js";
import {
  getRegisteredBaseWorkspaceServices,
  useRemoteWorkspaceSessionStore,
} from "@/store/remoteWorkspaceSessionStore.js";
import { useTabStoreApi } from "@/store/TabStoreProvider.js";
import { isWorkspaceTab, type WorkspaceTabState } from "@/store/tabStore.js";
import type { WorktreeRemovalUiFacts } from "./worktreeRemovalModel.js";

/**
 * 删除目标的运行时解析（specs/git-worktree-removal.md W5/W5a）：tab 所属 Host 的
 * taskService 解析 + 隔离/释放目标收集。独立成模块以保持删除流程主 hook 只读。
 */
export function useWorktreeRemovalTargets(params: {
  workspacePath: string;
  workspaceIdentity?: string | null;
  remoteSessionId?: string | null;
  /** 执行 Host 的 codezTaskService（目标树根的释放/隔离通道）。 */
  codezTaskService: ICodezTaskService;
}) {
  const tabStoreApi = useTabStoreApi();

  const resolveTabTaskService = useCallback(
    (tab: { workspacePath: string; workspaceIdentity: string | null; tabId: string }) => {
      const tabs = tabStoreApi.getState().tabs;
      const source = tabs.find((item) => isWorkspaceTab(item) && item.id === tab.tabId) as
        | WorkspaceTabState
        | undefined;
      const remoteSessionId = source?.remoteSessionId?.trim();
      if (remoteSessionId) {
        return (
          useRemoteWorkspaceSessionStore.getState().sessionsById[remoteSessionId]?.services
            .codezTaskService ?? null
        );
      }
      return getRegisteredBaseWorkspaceServices()?.codezTaskService ?? null;
    },
    [tabStoreApi],
  );

  /**
   * 收集隔离/释放目标：目标树根（执行 Host 的 codezTaskService）+ 每个打开 tab
   *（各自 Host 的服务）。服务必须在 closeTab 之前解析（tab 关闭后 remoteSessionId
   * 取不到）。远程 runtime 以 identity 为 key：树根 identity 由会话 target 经既有
   * 构造器生成；target 缺失且 anchor 与目标同路径时复用 anchor identity，否则按
   * path 释放（未命中属可恢复降级，不阻断删除）。
   */
  const collectRemovalHoldTargets = useCallback(
    (
      entry: WorktreeDiscoveryEntry,
      openTabs: WorktreeRemovalUiFacts["openTabs"],
    ): {
      rootTarget: WorkspaceRemovalHoldTarget;
      holdTargets: WorkspaceRemovalHoldTarget[];
    } => {
      let rootIdentity: string | undefined;
      const remoteSessionId = params.remoteSessionId?.trim();
      if (remoteSessionId) {
        const session = useRemoteWorkspaceSessionStore.getState().sessionsById[remoteSessionId];
        if (session?.target) {
          rootIdentity = buildRemoteWorkspaceIdentity(entry.path, session.target);
        } else if (
          params.workspaceIdentity?.trim() &&
          normalizeWorkspacePathForComparison(params.workspacePath) ===
            normalizeWorkspacePathForComparison(entry.path)
        ) {
          rootIdentity = params.workspaceIdentity.trim();
        }
      }
      const rootTarget: WorkspaceRemovalHoldTarget = {
        workspacePath: entry.path,
        workspaceIdentity: rootIdentity ?? null,
        codezTaskService: params.codezTaskService ?? null,
      };
      const holdTargets: WorkspaceRemovalHoldTarget[] = [rootTarget];
      const seen = new Set([`${rootTarget.workspaceIdentity ?? ""}|${rootTarget.workspacePath}`]);
      for (const tab of openTabs) {
        const key = `${tab.workspaceIdentity ?? ""}|${tab.workspacePath}`;
        if (seen.has(key)) continue;
        seen.add(key);
        holdTargets.push({
          workspacePath: tab.workspacePath,
          workspaceIdentity: tab.workspaceIdentity,
          codezTaskService: resolveTabTaskService(tab),
        });
      }
      return { rootTarget, holdTargets };
    },
    [
      params.remoteSessionId,
      params.workspaceIdentity,
      params.workspacePath,
      params.codezTaskService,
      resolveTabTaskService,
    ],
  );

  return { resolveTabTaskService, collectRemovalHoldTargets };
}
