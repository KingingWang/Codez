import { memo } from "react";
import type { CodezTaskMeta } from "@codez/shared";
import { Cloud, Folder, LoaderIcon } from "lucide-react";
import { cn } from "@/components/lib/utils.js";
import { useCodezIntl } from "@/i18n/IntlProvider.js";
import { buildTaskWorkspaceKey } from "@/lib/taskQueryCache.js";
import { deriveTaskLeadingIndicator } from "@/lib/taskListItemPresentation.js";
import { getTaskListAttention, getTaskListRowActivity } from "@/v4/taskListRowActivity.js";
import { taskKey } from "@/workspace-grouped-tasks/ids.js";

/**
 * 运行中/待确认任务浮出层（git-worktree-projects R4）：任务优先视图顶部常驻，
 * 让跨工作区的活动任务不必沿分组翻找。数据源与列表行共用同一 activity sidecar
 * 派生，只读不触发任何运行时。点击行激活目标任务（复用列表同一 onSelectTask）。
 */
export const RunningTasksStrip = memo(function RunningTasksStrip({
  tasks,
  activeWorkspacePath,
  activeWorkspaceIdentity,
  activeTaskId,
  getTaskWorkspaceLabel,
  onSelectTask,
}: {
  tasks: CodezTaskMeta[];
  activeWorkspacePath: string;
  activeWorkspaceIdentity?: string;
  activeTaskId: string | null;
  getTaskWorkspaceLabel: (task: CodezTaskMeta) => string;
  onSelectTask: (workspacePath: string, taskId: string, workspaceIdentity?: string) => void;
}) {
  const { intl } = useCodezIntl();
  if (tasks.length === 0) {
    return null;
  }
  const attentionCount = tasks.filter((task) => getTaskListAttention(task) !== null).length;
  const activeWorkspaceKey = buildTaskWorkspaceKey(activeWorkspacePath, activeWorkspaceIdentity);
  return (
    <section
      data-testid="running-tasks-strip"
      aria-label={intl.formatMessage({ id: "taskList.runningStripLabel" })}
      className="mb-2 flex flex-col gap-0.5 rounded-md border border-border/60 bg-surface px-2 py-1.5"
    >
      <div className="flex items-center gap-1.5 px-1 text-ui-xs text-foreground-subtle">
        <LoaderIcon className="size-3 animate-spin" aria-hidden="true" />
        <span>
          {attentionCount > 0
            ? intl.formatMessage(
                { id: "taskList.runningStripSummaryWithAttention" },
                {
                  running: String(tasks.length - attentionCount),
                  attention: String(attentionCount),
                },
              )
            : intl.formatMessage(
                { id: "taskList.runningStripSummary" },
                { count: String(tasks.length) },
              )}
        </span>
      </div>
      <ul className="flex flex-col">
        {tasks.map((task) => {
          const key = taskKey(task);
          const activity = getTaskListRowActivity(task);
          // 转圈语义与列表行一致：只认 sessions-index 实时 phase，持久化残留不算。
          const running = deriveTaskLeadingIndicator(task, activity) === "loading";
          const attention = getTaskListAttention(task);
          const isRemote = Boolean(task.workspaceIdentity?.trim());
          const isActive =
            buildTaskWorkspaceKey(task.workspacePath, task.workspaceIdentity) ===
              activeWorkspaceKey && task.taskId === activeTaskId;
          const title =
            task.title ||
            intl.formatMessage({
              id: task.forkedFromTaskId ? "taskList.forkedUntitled" : "taskList.untitled",
            });
          return (
            <li key={key}>
              <button
                type="button"
                data-active={isActive || undefined}
                className={cn(
                  "flex w-full min-w-0 items-center gap-1.5 rounded px-1 py-1 text-left text-ui-sm",
                  "hover:bg-surface-hover focus-visible:outline-2 focus-visible:outline-brand",
                  isActive && "bg-card-selected",
                )}
                onClick={() =>
                  onSelectTask(task.workspacePath, task.taskId, task.workspaceIdentity)
                }
              >
                {running ? (
                  <LoaderIcon
                    className="size-3.5 shrink-0 animate-spin text-foreground-subtle"
                    aria-hidden="true"
                  />
                ) : attention ? (
                  <span aria-hidden="true" className="size-1.5 shrink-0 rounded-full bg-success" />
                ) : (
                  <span
                    aria-hidden="true"
                    className={cn(
                      "size-1.5 shrink-0 rounded-full",
                      activity?.phase === "error" ? "bg-destructive" : "bg-foreground-subtlest",
                    )}
                  />
                )}
                <span className="min-w-0 truncate text-foreground">{title}</span>
                <span className="ml-auto flex shrink-0 items-center gap-1 text-ui-xs text-foreground-subtle">
                  {isRemote ? (
                    <Cloud className="size-3" aria-hidden="true" />
                  ) : (
                    <Folder className="size-3" aria-hidden="true" />
                  )}
                  <span className="max-w-28 truncate">{getTaskWorkspaceLabel(task)}</span>
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
});
