import assert from "node:assert/strict";
import test from "node:test";
import type { CodezTaskMeta } from "@codez/shared";
import type { CodezGroupedTaskView } from "@codez/services";
import { attachTaskListRowActivity } from "@/v4/taskListRowActivity.js";
import type { TaskListRowActivity } from "@/v4/taskListRowActivity.js";
import { taskKey } from "@/workspace-grouped-tasks/ids.js";
import {
  collectGroupedTaskKeysOutsideWorkspace,
  collectRunningGroupedTasks,
  filterGroupedViewByTaskKeys,
} from "@/workspace-grouped-tasks/view.js";

let fixtureCounter = 0;
function taskFixture(params: {
  workspacePath: string;
  workspaceIdentity?: string;
  activity?: Partial<TaskListRowActivity>;
  status?: CodezTaskMeta["status"];
}): CodezTaskMeta {
  fixtureCounter += 1;
  const task: CodezTaskMeta = {
    taskId: `task-${fixtureCounter}`,
    traceId: `trace-${fixtureCounter}`,
    title: `Task ${fixtureCounter}`,
    workspacePath: params.workspacePath,
    ...(params.workspaceIdentity ? { workspaceIdentity: params.workspaceIdentity } : {}),
    createdAt: 1,
    updatedAt: 1,
    mode: "build",
    ...(params.status ? { status: params.status } : {}),
  };
  if (!params.activity) {
    return task;
  }
  return attachTaskListRowActivity(task, {
    phase: "completedSuccess",
    lastActivityAt: 1,
    hasBackgroundWork: false,
    ...params.activity,
  } as TaskListRowActivity);
}

function viewOf(tasks: CodezTaskMeta[]): CodezGroupedTaskView {
  return { nodes: tasks.map((task) => ({ type: "task" as const, task })) };
}

test("workspace filter collects only tasks outside the target workspace", () => {
  const localA = taskFixture({ workspacePath: "/repo" });
  const localA2 = taskFixture({ workspacePath: "/repo" });
  const linkedTree = taskFixture({ workspacePath: "/repo-wt-1" });
  // 同路径不同远端：identity 参与去重键，不得被本地筛选误留。
  const remoteSamePath = taskFixture({ workspacePath: "/repo", workspaceIdentity: "remote-a" });
  const view = viewOf([localA, localA2, linkedTree, remoteSamePath]);

  const hidden = collectGroupedTaskKeysOutsideWorkspace(view, "/repo");
  assert.deepEqual([...hidden].sort(), [taskKey(linkedTree), taskKey(remoteSamePath)].sort());

  const filtered = filterGroupedViewByTaskKeys(view, hidden);
  assert.deepEqual(
    filtered.nodes.map((node) => (node.type === "task" ? taskKey(node.task) : "")).sort(),
    [taskKey(localA), taskKey(localA2)].sort(),
  );
  // 纯派生：原视图顺序与成员不变，取消筛选即恢复。
  assert.equal(view.nodes.length, 4);
});

test("workspace filter reaches into group nodes", () => {
  const inGroup = taskFixture({ workspacePath: "/repo-wt-1" });
  const keep = taskFixture({ workspacePath: "/repo" });
  const view: CodezGroupedTaskView = {
    nodes: [
      {
        type: "group",
        group: { id: "g1", title: "Group", color: "gray", createdAt: 1, updatedAt: 1 },
        tasks: [inGroup, keep],
      } as CodezGroupedTaskView["nodes"][number],
    ],
  };
  const hidden = collectGroupedTaskKeysOutsideWorkspace(view, "/repo");
  assert.deepEqual([...hidden], [taskKey(inGroup)]);
});

test("running collection surfaces active phases, background work and attention only", () => {
  const running = taskFixture({ workspacePath: "/repo", activity: { phase: "running" } });
  const prewarming = taskFixture({ workspacePath: "/repo", activity: { phase: "prewarming" } });
  const background = taskFixture({
    workspacePath: "/repo",
    activity: { phase: "completedSuccess", hasBackgroundWork: true },
  });
  const attention = taskFixture({
    workspacePath: "/repo",
    activity: {
      phase: "completedSuccess",
      pendingInteractions: { permissionCount: 1, userInputCount: 0 },
    },
  });
  const idle = taskFixture({ workspacePath: "/repo", activity: { phase: "completedSuccess" } });
  // 无 sidecar 的持久化 running 不能浮出：上次落盘未完成 ≠ 当前正在运行。
  const staleRunning = taskFixture({ workspacePath: "/repo", status: "running" });
  const view = viewOf([running, prewarming, background, attention, idle, staleRunning]);

  const surfaced = collectRunningGroupedTasks(view).map((task) => taskKey(task));
  assert.deepEqual(
    surfaced.sort(),
    [running, prewarming, background, attention].map((task) => taskKey(task)).sort(),
  );
});
