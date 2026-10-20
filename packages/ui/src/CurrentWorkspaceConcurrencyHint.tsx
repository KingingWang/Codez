import { useMemo } from "react";
import type { CodezTaskMeta } from "@codez/shared";
import { useWorkspaceServicesResolution } from "@/hooks/useWorkspaceServices.js";
import { useCodezIntl } from "@/i18n/IntlProvider.js";
import {
  useWorkspaceSessionsIndexItems,
  type WorkspaceSessionsIndexScope,
} from "@/v4/useWorkspaceSessionsIndexItems.js";
import { getTaskListRowActivity } from "@/v4/taskListRowActivity.js";

/**
 * R3 只采信当前 workspace sessions-index 的实时摘要。
 * tasks-index 的 status 是持久投影，断线或崩溃后可能残留 running；它不能作为并发提示事实。
 */
export function hasCurrentWorkspaceConcurrentWork(items: readonly CodezTaskMeta[]): boolean {
  return items.some((item) => {
    const activity = getTaskListRowActivity(item);
    return (
      activity?.phase === "running" ||
      activity?.phase === "prewarming" ||
      activity?.hasBackgroundWork === true
    );
  });
}

export function CurrentWorkspaceConcurrencyHint({
  workspacePath,
  workspaceIdentity,
  remoteSessionId,
}: {
  workspacePath: string;
  workspaceIdentity?: string;
  remoteSessionId?: string;
}) {
  const { intl } = useCodezIntl();
  const {
    services,
    remoteSessionId: resolvedRemoteSessionId,
    rpcReady,
  } = useWorkspaceServicesResolution(workspacePath, remoteSessionId, workspaceIdentity);

  // 远端 session 未解析时保持无订阅；这里绝不 fallback 到本机 Host，避免远端路径串读本机任务。
  const scopes = useMemo<WorkspaceSessionsIndexScope[]>(() => {
    if (!rpcReady || !services.codezAgentService) {
      return [];
    }
    return [
      {
        workspacePath,
        ...(workspaceIdentity ? { workspaceIdentity } : {}),
        ...(resolvedRemoteSessionId ? { endpointKey: resolvedRemoteSessionId } : {}),
        agentService: services.codezAgentService,
      },
    ];
  }, [
    services.codezAgentService,
    rpcReady,
    workspaceIdentity,
    workspacePath,
    resolvedRemoteSessionId,
  ]);
  const { items } = useWorkspaceSessionsIndexItems(scopes);

  if (!hasCurrentWorkspaceConcurrentWork(items)) {
    return null;
  }

  return (
    <p role="status" className="text-ui-xs text-warning">
      {intl.formatMessage({ id: "worktree.concurrent.warning" })}
    </p>
  );
}
