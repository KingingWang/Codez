import { create } from "zustand";
import { getServiceAuthorityId } from "./serviceAuthorityKey.js";

interface CodexCatalogRestartState {
  pending: Record<string, object>;
  markPending(key: string): void;
  clearPending(key: string, expected: object): void;
}

export function codexCatalogRestartKey(agent: object, workspaceKey: string): string {
  return JSON.stringify([getServiceAuthorityId(agent), workspaceKey]);
}

// 修复原因：目录待刷新提醒曾归面板 useState 所有，切换设置即卸载丢失。
// 窗口内只保存提醒标记；不持久化、不复制目录事实，Host/identity 各自隔离。
export const useCodexCatalogRestartStore = create<CodexCatalogRestartState>()((set) => ({
  pending: {},
  markPending: (key) => set((state) => ({ pending: { ...state.pending, [key]: {} } })),
  clearPending: (key, expected) =>
    set((state) => {
      // 重启期间的新写入和其他目标不属于本次确认；旧完成结果不能清除它们。
      if (state.pending[key] !== expected) return state;
      const pending = { ...state.pending };
      delete pending[key];
      return { pending };
    }),
}));
