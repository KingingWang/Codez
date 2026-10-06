import type { ICodezTaskService } from "@codez/services";
import type { WorkspaceTabState } from "@/store/tabStore.js";
import { logger } from "@/logger.js";

export function releaseWorkspaceRuntimeAfterProjectRemoval({
  tab,
  codezTaskService,
}: {
  tab: Pick<WorkspaceTabState, "workspacePath" | "workspaceIdentity">;
  codezTaskService: Pick<ICodezTaskService, "releaseWorkspacePreparation">;
}): void {
  const workspaceIdentity = tab.workspaceIdentity?.trim() || undefined;
  void codezTaskService
    .releaseWorkspacePreparation({
      workspacePath: tab.workspacePath,
      ...(workspaceIdentity ? { workspaceIdentity } : {}),
    })
    .catch((error: unknown) => {
      // Windows 会把 Agent/终端子进程 cwd 视为目录占用；移除项目必须主动释放 runtime。
      // 释放失败不能回滚 UI 移除，只记录 workspace key 方便定位残留进程。
      logger.error("[WorkspaceSidebarItem] 移除 workspace 后释放 runtime 失败", {
        workspaceKey: workspaceIdentity ?? tab.workspacePath,
        error,
      });
    });
}

/**
 * 删除编排的释放语义（specs/git-worktree-removal.md W5）：runtime 释放必须先于
 * 物理删除完成，释放失败要中止删除（Windows 会把 Agent/终端子进程 cwd 视为目录
 * 占用，带占用删目录会留下半截状态）。与项目移除的 fire-and-forget 不同，
 * 这里返回 Promise 并把失败抛给调用方裁决。
 */
export async function releaseWorkspaceRuntimeBeforeRemoval({
  tab,
  codezTaskService,
}: {
  tab: Pick<WorkspaceTabState, "workspacePath" | "workspaceIdentity">;
  codezTaskService: Pick<ICodezTaskService, "releaseWorkspacePreparation">;
}): Promise<void> {
  const workspaceIdentity = tab.workspaceIdentity?.trim() || undefined;
  await codezTaskService.releaseWorkspacePreparation({
    workspacePath: tab.workspacePath,
    ...(workspaceIdentity ? { workspaceIdentity } : {}),
  });
}

interface WorkspaceRemovalTab {
  tabId: string;
  workspacePath: string;
  workspaceIdentity: string | null;
}

/** 删除链路的完整关闭编排；服务解析与释放使用关闭前的同一份 tab 快照。 */
export async function closeWorkspaceTabsBeforeRemoval({
  tabs,
  resolveTaskService,
  closeTab,
  unavailableMessage,
}: {
  tabs: readonly WorkspaceRemovalTab[];
  resolveTaskService: (
    tab: WorkspaceRemovalTab,
  ) => Pick<ICodezTaskService, "releaseWorkspacePreparation"> | null;
  closeTab: (tabId: string) => void;
  unavailableMessage: string;
}): Promise<void> {
  const prepared = tabs.map((tab) => {
    const codezTaskService = resolveTaskService(tab);
    if (!codezTaskService) throw new Error(unavailableMessage);
    return { tab, codezTaskService };
  });
  // 释放失败时必须保留全部 tab；否则重试看不到旧 runtime，会绕过释放直接删除。
  for (const { tab, codezTaskService } of prepared) {
    await releaseWorkspaceRuntimeBeforeRemoval({
      tab: {
        workspacePath: tab.workspacePath,
        workspaceIdentity: tab.workspaceIdentity ?? undefined,
      },
      codezTaskService,
    });
  }
  for (const { tab } of prepared) closeTab(tab.tabId);
}
