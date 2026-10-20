import { resolveWorkspaceKey, CODEZ_AGENT_PROVIDER } from "@codez/shared";
import type { TaskIndexRepo } from "#src/session/taskIndexRepo.js";
import type { ICodezAgentService, CodezAgentWorkspaceTarget } from "#src/codez-agent/codezAgent.js";

/**
 * 旧版本在原生 thread/list 丢失 threadSource 标记期间，把辅助对话 child 播种进了
 * 主任务列表（session/list 与 sessions-index 的过滤拿不到标记）。标记持久化在原生
 * rollout，thread/read 始终返回；这里只软删权威身份确认的派生索引行，不动 Agent 转录。
 * 候选只取「不在可见 sessions-index」的存量行，逐条 readSession 确认身份后才删除。
 */
export async function repairSelectionSideChatTaskIndex(params: {
  target: CodezAgentWorkspaceTarget;
  visibleSessionIds: ReadonlySet<string>;
  agentService: Pick<ICodezAgentService, "readSession">;
  taskIndexRepo: Pick<TaskIndexRepo, "listTaskMetas" | "updateTaskState">;
  isCurrent: () => boolean;
  onRemoved: () => void;
}): Promise<void> {
  const { target, taskIndexRepo, agentService, isCurrent } = params;
  const rows = await taskIndexRepo.listTaskMetas({ ...target, provider: CODEZ_AGENT_PROVIDER });
  const candidateIds = rows
    .filter((row) => !params.visibleSessionIds.has(row.taskId))
    .map((row) => row.taskId);
  for (const taskId of candidateIds) {
    if (!isCurrent()) return;
    let snapshot;
    try {
      snapshot = await agentService.readSession({
        ...target,
        sessionId: taskId,
        runtimePolicy: "existing-only",
        contentProfile: "index",
      });
    } catch {
      // 线程已删除或暂不可读：身份无法确认，保守保留。
      continue;
    }
    if (!isCurrent()) return;
    // 跨身份结果与缺失记录都不能推断为可删除。
    if (
      snapshot.session.sessionId !== taskId ||
      snapshot.session.sessionKind !== "selection_side_chat" ||
      resolveWorkspaceKey(snapshot.session.workspace) !== resolveWorkspaceKey(target)
    )
      continue;
    await taskIndexRepo.updateTaskState({
      ...target,
      taskId,
      patch: { deleted: true },
    });
    if (isCurrent()) params.onRemoved();
  }
}
