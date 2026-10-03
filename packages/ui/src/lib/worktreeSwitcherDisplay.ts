import {
  normalizeWorkspacePathForComparison,
  type WorktreeDiscoveryEntry,
} from "@/lib/projectGrouping.js";

/**
 * 独立工作区切换器的纯展示逻辑（specs/git-worktree-projects.md R2/R5/R14）。
 * 不接触 React 与 i18n，只从发现条目推导每行的动作与显示原料。
 */

export type WorktreeSwitcherAction = "activate" | "open" | "open-root" | "disabled";

/** 取规范化路径的最后一段作为树的显示名（"/" 与 "C:/" 等根路径原样返回）。 */
export function resolveWorktreeDirName(normalizedPath: string): string {
  const segments = normalizedPath.split("/").filter(Boolean);
  const first = segments[0];
  const last = segments[segments.length - 1];
  if (!first || !last) {
    return normalizedPath;
  }
  if (segments.length === 1 && /^[A-Za-z]:$/.test(first)) {
    return first;
  }
  return last;
}

/** 工作区路径是否位于某棵树内（含树根本身；纯字符串前缀判断，仅用于显示）。 */
export function isWorkspaceInsideTree(workspacePath: string, treeRoot: string): boolean {
  const workspace = normalizeWorkspacePathForComparison(workspacePath);
  const root = normalizeWorkspacePathForComparison(treeRoot);
  return workspace === root || workspace.startsWith(root === "/" ? "/" : `${root}/`);
}

/**
 * 行动作推导：
 * - 已打开 → activate（激活保留现场）；
 * - Web 远控禁用打开 → disabled（附说明，不假装可点）；
 * - 当前工作区是该树的子目录 → open-root（"打开仓库根目录"，验收 10）；
 * - 其余未打开 → open。
 */
export function resolveWorktreeSwitcherAction(params: {
  entry: WorktreeDiscoveryEntry;
  currentWorkspacePath: string;
  allowOpenWorkspace: boolean;
}): WorktreeSwitcherAction {
  const { entry, currentWorkspacePath, allowOpenWorkspace } = params;
  if (entry.isOpen) {
    return "activate";
  }
  if (!allowOpenWorkspace) {
    return "disabled";
  }
  if (
    isWorkspaceInsideTree(currentWorkspacePath, entry.path) &&
    normalizeWorkspacePathForComparison(currentWorkspacePath) !==
      normalizeWorkspacePathForComparison(entry.path)
  ) {
    return "open-root";
  }
  return "open";
}

/** R2：项目内登记的工作树达到两个才显示切换器（含未打开的轻量条目）。 */
export function shouldShowWorktreeSwitcher(entries: readonly WorktreeDiscoveryEntry[]): boolean {
  return entries.length >= 2;
}
