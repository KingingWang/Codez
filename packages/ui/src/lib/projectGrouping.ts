import {
  buildRemoteWorkspaceScope,
  LOCAL_WORKSPACE_SCOPE,
  parseRemoteWorkspaceScope,
  type GitWorktreeEntry,
  type RemoteTarget,
} from "@codez/shared";

/**
 * 项目分组与 worktree 发现的纯派生层（specs/git-worktree-projects.md「身份与分组」）。
 * 这里不持有任何状态：输入是 tab 元数据 + Git 事实，输出是分组与发现条目投影。
 * 三条纪律：
 * - 分组 key = 来源作用域 + common dir；身份不足（缺 target/identity、解析失败、
 *   common dir 缺失）一律不合组，不产生"空 common dir 项目"。
 * - 发现条目只读，isOpen 只按"已打开 tab 的路径 === 树根"判定；子目录 tab 不算打开树根。
 * - 归属身份（workspaceIdentity || workspacePath）在这里不被改写，只读引用。
 */

export interface ProjectGroupingSource {
  workspacePath: string;
  workspaceIdentity?: string | null;
  remoteTarget?: RemoteTarget | null;
  remoteSessionId?: string | null;
}

/**
 * 解析来源作用域。优先 RemoteTarget（连接期事实），退到 workspaceIdentity 的统一解析
 * （覆盖只持久化了 identity 的存量 tab）；两者皆无且没有远程会话痕迹时按本地处理。
 * 有 remoteSessionId 却拿不到 target/identity 属于身份不足，返回 null 不合组。
 */
export function resolveWorkspaceSourceScope(source: ProjectGroupingSource): string | null {
  if (source.remoteTarget) {
    return buildRemoteWorkspaceScope(source.remoteTarget);
  }
  const identity = source.workspaceIdentity?.trim();
  if (identity) {
    return parseRemoteWorkspaceScope(identity);
  }
  if (!source.remoteSessionId?.trim()) {
    return LOCAL_WORKSPACE_SCOPE;
  }
  return null;
}

/** 路径比较归一：统一分隔符、去收尾斜杠。仅用于相等性判断，不回写任何持久数据。 */
export function normalizeWorkspacePathForComparison(path: string): string {
  const trimmed = path.trim().replace(/\\/g, "/");
  if (trimmed === "/" || /^[A-Za-z]:\/?$/.test(trimmed)) {
    return trimmed;
  }
  return trimmed.replace(/\/+$/, "");
}

export function buildProjectGroupKey(scope: string, gitCommonDir: string): string {
  return `${scope} ${normalizeWorkspacePathForComparison(gitCommonDir)}`;
}

export interface ProjectGroup<TSource extends ProjectGroupingSource = ProjectGroupingSource> {
  projectKey: string;
  scope: string;
  gitCommonDir: string;
  members: TSource[];
}

export function deriveProjectGroups<TSource extends ProjectGroupingSource>(
  sources: readonly { source: TSource; gitCommonDir?: string | null }[],
): ProjectGroup<TSource>[] {
  const groups = new Map<string, ProjectGroup<TSource>>();
  for (const { source, gitCommonDir } of sources) {
    const scope = resolveWorkspaceSourceScope(source);
    const normalizedCommonDir = gitCommonDir?.trim()
      ? normalizeWorkspacePathForComparison(gitCommonDir)
      : null;
    if (!scope || !normalizedCommonDir) {
      continue;
    }
    const projectKey = buildProjectGroupKey(scope, normalizedCommonDir);
    const existing = groups.get(projectKey);
    if (existing) {
      existing.members.push(source);
    } else {
      groups.set(projectKey, {
        projectKey,
        scope,
        gitCommonDir: normalizedCommonDir,
        members: [source],
      });
    }
  }
  return [...groups.values()];
}

export interface WorktreeDiscoveryEntry {
  /** 宿主端规范化后的树根路径（比较归一形态）。 */
  path: string;
  branchName: string | null;
  headCommitHash: string | null;
  isMain: boolean;
  isDetached: boolean;
  isLocked: boolean;
  lockReason: string | null;
  isPrunable: boolean;
  prunableReason: string | null;
  /** 同作用域下存在路径恰好等于树根的已打开 tab。子目录 tab 不算。 */
  isOpen: boolean;
}

/**
 * 由 git 台账投影发现条目：按树根去重，标注 isOpen。
 * 列表只描述台账事实；"打开"动作由调用方走既有打开流程。
 */
export function deriveWorktreeDiscoveryEntries(params: {
  worktrees: readonly GitWorktreeEntry[];
  openWorkspacePaths: readonly string[];
}): WorktreeDiscoveryEntry[] {
  const openPaths = new Set(params.openWorkspacePaths.map(normalizeWorkspacePathForComparison));
  const seen = new Set<string>();
  const entries: WorktreeDiscoveryEntry[] = [];
  for (const tree of params.worktrees) {
    const path = normalizeWorkspacePathForComparison(tree.path);
    if (seen.has(path)) {
      continue;
    }
    seen.add(path);
    entries.push({
      path,
      branchName: tree.branchName,
      headCommitHash: tree.headCommitHash,
      isMain: tree.isMain,
      isDetached: tree.isDetached,
      isLocked: tree.isLocked,
      lockReason: tree.lockReason,
      isPrunable: tree.isPrunable,
      prunableReason: tree.prunableReason,
      isOpen: openPaths.has(path),
    });
  }
  return entries;
}
