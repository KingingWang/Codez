import { useCallback, useEffect, useMemo, useState } from "react";
import type { GitWorktreeEntry } from "@codez/shared";
import type { IGitService } from "@codez/services";
import {
  deriveProjectGroups,
  deriveWorktreeDiscoveryEntries,
  resolveWorkspaceSourceScope,
  type ProjectGroup,
  type WorktreeDiscoveryEntry,
} from "@/lib/projectGrouping.js";
import { logger } from "@/logger.js";
import { isWorkspaceTab, type WorkspaceTabState } from "@/store/tabStore.js";
import {
  getRegisteredBaseWorkspaceServices,
  useRemoteWorkspaceSessionStore,
} from "@/store/remoteWorkspaceSessionStore.js";
import { useTabStore, useTabStoreApi } from "@/store/TabStoreProvider.js";

/**
 * 项目分组 + worktree 发现（specs/git-worktree-projects.md 阶段一）。
 * R5 纪律：只查询"已打开且已连接"的工作区服务——本地 tab 用 base host，远程 tab
 * 用既有 remoteSessionId 对应的已注册连接；remote-waiting 或身份不足的 tab 跳过。
 * 本 hook 永远不注册活跃工作区、不挂载运行时、不建立新连接。
 */

export interface ProjectWorktreeDiscovery {
  groups: ProjectGroup<WorkspaceTabState>[];
  entriesByProjectKey: Record<string, WorktreeDiscoveryEntry[]>;
  /** 指定 workspace 的项目分组 key；不合组（非 Git/身份不足/旧服务）时为 null。 */
  projectKeyForWorkspace: (workspaceKey: string) => string | null;
  /** 最近一次读取中 listWorktrees 瞬时失败的项目（展示"状态未知/重试"用）。 */
  failedListProjectKeys: ReadonlySet<string>;
  /** 重新读取 git 台账（发现列表随菜单展开等显式时机刷新）。 */
  refresh: () => void;
}

export interface ProjectWorktreeFacts {
  /** workspaceKey → 宿主端规范化的 common dir（null = 不合组）。 */
  factsByWorkspaceKey: Record<string, string | null>;
  /** projectKey → git 台账里的工作树列表（空 = 无发现或远端不支持）。 */
  treesByProjectKey: Record<string, GitWorktreeEntry[]>;
  /**
   * listWorktrees 瞬时失败的项目。不可达 ≠ 已删除（R14）：调用方保留这些项目的
   * 上次已知列表并允许显式重试；-32601（旧远端不支持）不算失败，按无发现静默降级。
   */
  failedListProjectKeys: string[];
}

/** 与 codezAgentService 同判据：-32601 是旧远端的正常降级，不是瞬时故障。 */
function isUnsupportedRemoteMethod(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === -32601
  );
}

function isLocalWorkspaceTab(tab: WorkspaceTabState): boolean {
  return !tab.remoteSessionId?.trim() && !tab.remoteTarget && !tab.workspaceIdentity?.trim();
}

function resolveTabGitService(
  tab: WorkspaceTabState,
  sessionsById: ReturnType<typeof useRemoteWorkspaceSessionStore.getState>["sessionsById"],
): IGitService | null {
  if (isLocalWorkspaceTab(tab)) {
    return getRegisteredBaseWorkspaceServices()?.gitService ?? null;
  }
  const sessionId = tab.remoteSessionId?.trim();
  if (!sessionId) {
    return null;
  }
  return sessionsById[sessionId]?.services.gitService ?? null;
}

function workspaceKeyOf(
  tab: Pick<WorkspaceTabState, "workspaceIdentity" | "workspacePath">,
): string {
  return tab.workspaceIdentity?.trim() || tab.workspacePath;
}

/**
 * 台账读取核心（与 React 解耦以便测试）。只调用 resolveGitService 返回的已连接服务
 * 的只读方法；resolver 返回 null 的 tab 直接跳过（身份不足/remote-waiting）。
 * 任何单点失败降级为"该条为空"，不向上抛错（非 Git/旧远端不得报错的产品规则）。
 */
export async function fetchProjectWorktreeFacts(params: {
  tabs: WorkspaceTabState[];
  resolveGitService: (tab: WorkspaceTabState) => IGitService | null;
  onDowngrade?: (kind: "repo-info" | "worktree-list", key: string, error: unknown) => void;
  isCancelled?: () => boolean;
}): Promise<ProjectWorktreeFacts> {
  const { tabs, resolveGitService, onDowngrade, isCancelled } = params;
  const facts: Record<string, string | null> = {};

  await Promise.all(
    tabs.map(async (tab) => {
      const key = workspaceKeyOf(tab);
      const gitService = resolveGitService(tab);
      if (!gitService) {
        facts[key] = null;
        return;
      }
      try {
        const info = await gitService.getWorkspaceRepositoryInfo({
          workspacePath: tab.workspacePath,
        });
        facts[key] = info.gitCommonDir ?? null;
      } catch (error) {
        onDowngrade?.("repo-info", key, error);
        facts[key] = null;
      }
    }),
  );
  if (isCancelled?.()) {
    return { factsByWorkspaceKey: facts, treesByProjectKey: {}, failedListProjectKeys: [] };
  }

  const groups = deriveProjectGroups(
    tabs.map((tab) => ({ source: tab, gitCommonDir: facts[workspaceKeyOf(tab)] })),
  );

  const trees: Record<string, GitWorktreeEntry[]> = {};
  const failedListProjectKeys: string[] = [];
  await Promise.all(
    groups.map(async (group) => {
      const anchor = group.members[0];
      if (!anchor) {
        return;
      }
      const gitService = resolveGitService(anchor);
      if (!gitService) {
        return;
      }
      try {
        const result = await gitService.listWorktrees({
          workspacePath: anchor.workspacePath,
        });
        if (result.isRepository) {
          trees[group.projectKey] = result.worktrees;
        }
      } catch (error) {
        onDowngrade?.("worktree-list", group.projectKey, error);
        if (!isUnsupportedRemoteMethod(error)) {
          failedListProjectKeys.push(group.projectKey);
        }
      }
    }),
  );

  return { factsByWorkspaceKey: facts, treesByProjectKey: trees, failedListProjectKeys };
}

/** 同一 key 的降级只在首次 warn（可诊断），后续 debug 静音（旧远端是预期形态）。 */
function createDowngradeLogger(): (kind: string, key: string, error: unknown) => void {
  const seen = new Set<string>();
  return (kind, key, error) => {
    const dedupeKey = `${kind}:${key}`;
    if (seen.has(dedupeKey)) {
      logger.debug("[ProjectDiscovery] 台账读取降级", { kind, key, error });
      return;
    }
    seen.add(dedupeKey);
    logger.warn("[ProjectDiscovery] 台账读取失败，按不合组/无发现降级", { kind, key, error });
  };
}

export function useProjectWorktreeDiscovery(): ProjectWorktreeDiscovery {
  const tabStore = useTabStoreApi();
  const tabSignature = useTabStore((state) =>
    state.tabs
      .filter(isWorkspaceTab)
      .map((tab) => `${workspaceKeyOf(tab)} ${tab.workspacePath} ${tab.remoteSessionId ?? ""}`)
      .sort()
      .join("\n"),
  );
  const sessionsById = useRemoteWorkspaceSessionStore((state) => state.sessionsById);
  // baseServices 注册晚于 tab 恢复时，本地分组依赖它触发重跑（评审 M5）。
  const baseServices = useRemoteWorkspaceSessionStore((state) => state.baseServices);
  const [refreshIndex, setRefreshIndex] = useState(0);
  const [factsByWorkspaceKey, setFactsByWorkspaceKey] = useState<Record<string, string | null>>({});
  const [treesByProjectKey, setTreesByProjectKey] = useState<Record<string, GitWorktreeEntry[]>>(
    {},
  );
  const [failedListProjectKeys, setFailedListProjectKeys] = useState<ReadonlySet<string>>(
    new Set(),
  );

  const refresh = useCallback(() => setRefreshIndex((index) => index + 1), []);

  // tab 集合 / 远程连接集合 / base 服务注册 / 显式刷新变化时重读 git 台账。全部只读。
  useEffect(() => {
    let cancelled = false;
    const onDowngrade = createDowngradeLogger();
    const tabs = tabStore.getState().tabs.filter(isWorkspaceTab);

    void fetchProjectWorktreeFacts({
      tabs,
      resolveGitService: (tab) => resolveTabGitService(tab, sessionsById),
      onDowngrade,
      isCancelled: () => cancelled,
    }).then((result) => {
      if (cancelled) {
        return;
      }
      setFactsByWorkspaceKey(result.factsByWorkspaceKey);
      setTreesByProjectKey((previous) => {
        const next = { ...result.treesByProjectKey };
        for (const projectKey of result.failedListProjectKeys) {
          // 瞬时失败保留上次已知树列表：失败缺省不等于台账为空，
          // 避免一次远端抖动把切换器里已知的树抹成"没有"。
          if (previous[projectKey]) {
            next[projectKey] = previous[projectKey];
          }
        }
        return next;
      });
      setFailedListProjectKeys(new Set(result.failedListProjectKeys));
    });
    return () => {
      cancelled = true;
    };
  }, [tabStore, tabSignature, sessionsById, baseServices, refreshIndex]);

  return useMemo(() => {
    const tabs = tabStore.getState().tabs.filter(isWorkspaceTab);
    const groups = deriveProjectGroups(
      tabs.map((tab) => ({
        source: tab,
        gitCommonDir: factsByWorkspaceKey[workspaceKeyOf(tab)],
      })),
    );
    const scopeByWorkspaceKey = new Map(
      tabs.map((tab) => [workspaceKeyOf(tab), resolveWorkspaceSourceScope(tab)] as const),
    );
    const entriesByProjectKey: Record<string, WorktreeDiscoveryEntry[]> = {};
    for (const group of groups) {
      // isOpen 判定覆盖同作用域的全部已打开 tab（含不合组的），但只认路径等于树根的。
      const openPaths = tabs
        .filter((tab) => scopeByWorkspaceKey.get(workspaceKeyOf(tab)) === group.scope)
        .map((tab) => tab.workspacePath);
      entriesByProjectKey[group.projectKey] = deriveWorktreeDiscoveryEntries({
        worktrees: treesByProjectKey[group.projectKey] ?? [],
        openWorkspacePaths: openPaths,
      });
    }
    const projectKeyByWorkspaceKey = new Map<string, string>();
    for (const group of groups) {
      for (const member of group.members) {
        projectKeyByWorkspaceKey.set(workspaceKeyOf(member), group.projectKey);
      }
    }
    return {
      groups,
      entriesByProjectKey,
      projectKeyForWorkspace: (workspaceKey: string) =>
        projectKeyByWorkspaceKey.get(workspaceKey) ?? null,
      failedListProjectKeys,
      refresh,
    };
    // tabSignature 代表 tab 集合变化；facts/trees 是台账读取结果。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [factsByWorkspaceKey, treesByProjectKey, failedListProjectKeys, tabSignature, refresh]);
}
