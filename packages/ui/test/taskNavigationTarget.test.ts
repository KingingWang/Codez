import { describe, expect, it } from "vitest";
import type { CodezTaskMeta } from "@codez/shared";
import { buildTaskEntityKey } from "@/lib/taskQueryCache.js";
import { taskNavigationTargetExists } from "@/lib/taskNavigationTarget.js";

function createTask(taskId: string): CodezTaskMeta {
  return {
    taskId,
    traceId: `trace-${taskId}`,
    title: taskId,
    workspacePath: "/workspace",
    createdAt: 1,
    updatedAt: 1,
    mode: "default",
  };
}

describe("taskNavigationTargetExists", () => {
  it("keeps navigation targets that only exist in task query cache", () => {
    const task = createTask("task-from-index");

    expect(
      taskNavigationTargetExists({
        entry: {
          kind: "task",
          workspacePath: task.workspacePath,
          taskId: task.taskId,
        },
        visibleTasks: [],
        taskMetaByEntityKey: {
          [buildTaskEntityKey(task)]: task,
        },
      }),
    ).toBe(true);
  });
});
