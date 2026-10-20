import type { RemoteTarget } from "@codez/shared";
import { buildRemoteWorkspaceIdentity } from "@codez/shared";
import { normalizeWorkspacePathForComparison } from "@/lib/projectGrouping.js";
import type { WorktreeDiscoveryEntry } from "@/lib/projectGrouping.js";
import { isWorkspaceTab, type TabStoreState } from "@/store/tabStore.js";

/**
 * 发现条目的打开意图决策（specs/git-worktree-projects.md R5）。
 * 纯函数，不接触 React / store；由 useWorktreeOpenActions 消费后分发到
 * activateTab（已打开保现场）/ 本地打开 / 远程打开。
 * 三意图分离：已打开→激活保留现场；未打开→能力门控后复用既有打开流程；
 * "新建会话"草稿意图由 root 执行器适配，不为发现条目另造旁路。
 */

export type WorktreeOpenRoute =
  | { kind: "activate"; tabId: string }
  | { kind: "open-local"; workspacePath: string }
  | {
      kind: "open-remote";
      workspacePath: string;
      remoteTarget: RemoteTarget;
      workspaceIdentity: string;
      /** 提供远程锚点的项目成员 key，用于定位其持久化会话条目加载连接凭据。 */
      anchorWorkspaceKey: string;
    }
  | { kind: "unsupported"; reason: "allow-open-disabled" | "remote-identity-missing" };

/** 远程锚点：同项目已打开远程工作区携带的连接目标与其成员 key。 */
export interface WorktreeRemoteAnchor {
  target: RemoteTarget;
  workspaceKey: string;
}

export function resolveWorktreeOpenRoute(params: {
  entry: WorktreeDiscoveryEntry;
  tabs: TabStoreState["tabs"];
  allowOpenWorkspace: boolean;
  /** 项目分组全部成员的 workspaceKey（identity || path）。 */
  projectMemberKeys: readonly string[];
  /** 项目分组的来源作用域是否为远端（分组层事实，UI 不从路径猜测）。 */
  isRemoteScope: boolean;
  /** 发现该树的项目锚点（同项目任一已打开远程工作区），本地项目为 null。 */
  anchor?: WorktreeRemoteAnchor | null;
}): WorktreeOpenRoute {
  const { entry, tabs, allowOpenWorkspace, projectMemberKeys, isRemoteScope, anchor } = params;

  {
    const normalizedRoot = normalizeWorkspacePathForComparison(entry.path);
    // 激活匹配必须限定在同项目成员内：不同来源作用域（本地/不同远端）可能存在
    // 相同路径字符串，按裸路径全窗口匹配会激活到别的远端的 tab。
    const memberKeys = new Set(projectMemberKeys);
    const targetIdentity = anchor
      ? buildRemoteWorkspaceIdentity(entry.path, anchor.target)
      : isRemoteScope
        ? null
        : entry.path;
    const match = tabs.find(
      (tab): tab is Extract<typeof tab, { kind: "workspace" }> =>
        isWorkspaceTab(tab) &&
        (memberKeys.has(tab.workspaceIdentity?.trim() || tab.workspacePath) ||
          (tab.workspaceIdentity?.trim() || tab.workspacePath) === targetIdentity) &&
        normalizeWorkspacePathForComparison(tab.workspacePath) === normalizedRoot,
    );
    if (match) {
      return { kind: "activate", tabId: match.id };
    }
    // 不采信可能滞后的 isOpen 展示投影：按目标身份复检，避免刚创建/打开的树
    // 在发现尚未刷新时再次走草稿路径。本窗口没有匹配则由既有流程按身份去重。
  }

  if (!allowOpenWorkspace) {
    return { kind: "unsupported", reason: "allow-open-disabled" };
  }

  if (anchor) {
    // 远程条目必须解析为自己的目标身份（RemoteTarget + 新路径），不沿用来源树身份。
    return {
      kind: "open-remote",
      workspacePath: entry.path,
      remoteTarget: anchor.target,
      workspaceIdentity: buildRemoteWorkspaceIdentity(entry.path, anchor.target),
      anchorWorkspaceKey: anchor.workspaceKey,
    };
  }
  if (isRemoteScope) {
    // 远程项目但拿不到任何成员锚点（例如成员 tab 身份不足）：
    // 不能把远端路径当本地路径打开，明确拒绝而不是猜。
    return { kind: "unsupported", reason: "remote-identity-missing" };
  }
  return { kind: "open-local", workspacePath: entry.path };
}

/** 找到项目的远程锚点：同项目成员中第一个带 remoteTarget 的已打开工作区 tab。 */
export function resolveAnchorRemoteTarget(params: {
  tabs: TabStoreState["tabs"];
  projectMemberKeys: readonly string[];
}): WorktreeRemoteAnchor | null {
  const keys = new Set(params.projectMemberKeys);
  for (const tab of params.tabs) {
    if (!isWorkspaceTab(tab)) {
      continue;
    }
    const key = tab.workspaceIdentity?.trim() || tab.workspacePath;
    if (keys.has(key) && tab.remoteTarget) {
      return { target: tab.remoteTarget, workspaceKey: key };
    }
  }
  return null;
}
