import {
  normalizeWorkspacePathForComparison,
  resolveWorkspaceSourceScope,
} from "@/lib/projectGrouping.js";
import { isWorktreeRemovalInFlight } from "@/store/worktreeRemovalGuardStore.js";

export type RootWorkspaceSelectionAdmissionResult =
  | { status: "rejected"; message: string }
  | { status: "activated" }
  | { status: "committed" };

export function getRootWorkspaceSelectionRejection(
  path: string,
  removalMessage: string,
): string | null {
  const scope = resolveWorkspaceSourceScope({ workspacePath: path });
  return scope && isWorktreeRemovalInFlight(scope, normalizeWorkspacePathForComparison(path))
    ? removalMessage
    : null;
}

/**
 * root 单一项目打开 admission（specs/git-worktree-removal.md W8/验收 32）。
 * 删除窗口可能在平台 IPC 等待期间开始，因此入口和 IPC 返回后的本地 UI commit
 * 前各复检一次；activated=true 只代表其他窗口已接管，本窗口绝不建 tab/草稿。
 */
export async function admitRootWorkspaceSelection({
  path,
  removalMessage,
  activateOrSetWorkspace,
  commit,
}: {
  path: string;
  removalMessage: string;
  activateOrSetWorkspace: (path: string) => Promise<{ activated: boolean }>;
  commit: (path: string) => void;
}): Promise<RootWorkspaceSelectionAdmissionResult> {
  const entryRejection = getRootWorkspaceSelectionRejection(path, removalMessage);
  if (entryRejection !== null) {
    return { status: "rejected", message: entryRejection };
  }

  const result = await activateOrSetWorkspace(path);
  const lateRejection = getRootWorkspaceSelectionRejection(path, removalMessage);
  if (lateRejection !== null) {
    return { status: "rejected", message: lateRejection };
  }
  if (result.activated) {
    return { status: "activated" };
  }

  commit(path);
  return { status: "committed" };
}
