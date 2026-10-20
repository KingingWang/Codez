import { create } from "zustand";

/**
 * 工作树"删除中"守卫（specs/git-worktree-removal.md W8）。
 * 删除执行期间由 useWorktreeRemoval 注册目标；工作区打开编排（root 单一打开
 * admission）读取本集合拦截目标激活。运行态事实服务端感知不到，本集合与
 * tabStore 复检是执行窗口保护的全部所有者。窗口内 UI 状态，不持久化。
 */

interface WorktreeRemovalGuardState {
  /** guardKey → true；key 由 buildWorktreeRemovalGuardKey 构造。 */
  targets: Record<string, true>;
  markDeleting: (key: string) => void;
  unmarkDeleting: (key: string) => void;
}

export function buildWorktreeRemovalGuardKey(scope: string, normalizedTargetPath: string): string {
  return `${scope}|${normalizedTargetPath}`;
}

export const useWorktreeRemovalGuardStore = create<WorktreeRemovalGuardState>()((set) => ({
  targets: {},
  markDeleting: (key) => set((state) => ({ targets: { ...state.targets, [key]: true } })),
  unmarkDeleting: (key) =>
    set((state) => {
      if (!(key in state.targets)) {
        return state;
      }
      const next = { ...state.targets };
      delete next[key];
      return { targets: next };
    }),
}));

/**
 * 目标树根或其下任意子目录都视为删除中：打开子目录同样会把运行时调度进
 * 正在删除的目录树（审查 ④）。scope 精确匹配，路径按目录前缀匹配。
 */
export function isWorktreeRemovalInFlight(scope: string, normalizedPath: string): boolean {
  const scopePrefix = `${scope}|`;
  for (const key of Object.keys(useWorktreeRemovalGuardStore.getState().targets)) {
    if (!key.startsWith(scopePrefix)) continue;
    const targetPath = key.slice(scopePrefix.length);
    if (normalizedPath === targetPath || normalizedPath.startsWith(`${targetPath}/`)) return true;
  }
  return false;
}
