import type { CodezSessionStoreState } from "@/store/codezSessionStoreTypes.js";
import {
  resolveWorkspaceStateKey,
  selectWorkspaceCodezState,
} from "@/store/codezSessionStoreSelectors.js";

/** Read the renderer selection; the native thread remains the owner of history facts. */
export function selectedCodexHistorySessionId(
  state: CodezSessionStoreState,
  workspacePath: string | null,
  workspaceIdentity?: string,
): string | undefined {
  if (!workspacePath) return undefined;
  const workspaceKey = resolveWorkspaceStateKey(workspacePath, workspaceIdentity);
  // 新远程 identity 尚未建立自己的选择态时，通用 selector 允许读取 path 迁移基线；
  // 历史读取不能借用该基线中的另一个窗口/Host session ID。
  if (workspaceKey !== workspacePath && !state.workspaces[workspaceKey]) return undefined;
  return (
    selectWorkspaceCodezState(state, workspacePath, workspaceIdentity).activeTaskId ?? undefined
  );
}
