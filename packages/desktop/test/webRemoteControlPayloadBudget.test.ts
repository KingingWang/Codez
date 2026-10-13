import { describe, expect, it } from "vitest";
import {
  WEB_REMOTE_CONTROL_APP_PAYLOAD_PLAINTEXT_BUDGET_BYTES,
  WEB_REMOTE_CONTROL_TASK_TITLE_MAX_CHARS,
  boundWebRemoteControlPayloadTasks,
  measureWebRemoteControlAppPayloadBytes,
} from "../src/main/webRemoteControlPayloadBudget.js";
import type { WebRemoteControlTaskTarget } from "@codez/shared";

function createTask(
  overrides: Partial<WebRemoteControlTaskTarget> = {},
): WebRemoteControlTaskTarget {
  return {
    taskId: "task-1",
    title: "Task one",
    workspacePath: "/workspace/demo",
    workspaceLabel: "demo",
    workspaceKind: "local",
    createdAt: 1,
    updatedAt: 2,
    ...overrides,
  };
}

function measureList(tasks: WebRemoteControlTaskTarget[]): number {
  return measureWebRemoteControlAppPayloadBytes({
    codez_type: "workspace-list-response",
    requestId: "",
    success: true,
    result: { workspaces: [], tasks },
  });
}

describe("boundWebRemoteControlPayloadTasks", () => {
  it("keeps a small list untouched", () => {
    const tasks = [
      createTask(),
      createTask({ taskId: "task-2", title: "second" }),
    ];
    const result = boundWebRemoteControlPayloadTasks({
      tasks,
      measureBytes: measureList,
    });
    expect(result.tasks).toHaveLength(2);
    expect(result.tasks[0]).toBe(tasks[0]);
    expect(result.stats).toMatchObject({
      truncatedTitleCount: 0,
      droppedTaskCount: 0,
    });
    expect(result.stats.bytesAfter).toBeLessThanOrEqual(
      WEB_REMOTE_CONTROL_APP_PAYLOAD_PLAINTEXT_BUDGET_BYTES,
    );
  });

  it("truncates overlong titles without dropping tasks", () => {
    const longTitle = "x".repeat(WEB_REMOTE_CONTROL_TASK_TITLE_MAX_CHARS * 10);
    const tasks = [
      createTask({ title: longTitle }),
      createTask({ taskId: "task-2" }),
    ];
    const result = boundWebRemoteControlPayloadTasks({
      tasks,
      measureBytes: measureList,
    });
    expect(result.tasks).toHaveLength(2);
    expect(result.tasks[0]?.title).toHaveLength(
      WEB_REMOTE_CONTROL_TASK_TITLE_MAX_CHARS,
    );
    expect(result.tasks[0]?.title).toBe(
      longTitle.slice(0, WEB_REMOTE_CONTROL_TASK_TITLE_MAX_CHARS),
    );
    expect(result.tasks[1]?.title).toBe("Task one");
    expect(result.stats.truncatedTitleCount).toBe(1);
    expect(result.stats.droppedTaskCount).toBe(0);
  });

  it("drops the oldest tasks when even truncated titles exceed the budget", () => {
    // 每个任务截断后仍约 300+ 字节；100 字节级小预算下必须丢尾部（最旧）任务。
    const tasks = Array.from({ length: 20 }, (_, index) =>
      createTask({
        taskId: `task-${index}`,
        title: `t${index}${"x".repeat(50)}`,
        updatedAt: 1000 - index,
      }),
    );
    const fullBytes = measureList(tasks);
    const budgetBytes = Math.floor(fullBytes / 2);
    const result = boundWebRemoteControlPayloadTasks({
      tasks,
      measureBytes: measureList,
      budgetBytes,
    });
    expect(result.tasks.length).toBeGreaterThan(0);
    expect(result.tasks.length).toBeLessThan(tasks.length);
    // 调用方按 updatedAt 倒序传入，保留的必须是前缀（最新的一批）。
    expect(result.tasks.map((task) => task.taskId)).toEqual(
      tasks.slice(0, result.tasks.length).map((task) => task.taskId),
    );
    expect(result.stats.droppedTaskCount).toBe(
      tasks.length - result.tasks.length,
    );
    expect(result.stats.bytesAfter).toBeLessThanOrEqual(budgetBytes);
  });

  it("truncates titles first and only drops when truncation is not enough", () => {
    const tasks = Array.from({ length: 4 }, (_, index) =>
      createTask({ taskId: `task-${index}`, title: "y".repeat(500) }),
    );
    const fullBytes = measureList(tasks);
    const truncatedOnlyBytes = measureList(
      tasks.map((task) => ({
        ...task,
        title: task.title.slice(0, WEB_REMOTE_CONTROL_TASK_TITLE_MAX_CHARS),
      })),
    );
    expect(truncatedOnlyBytes).toBeLessThan(fullBytes);
    const result = boundWebRemoteControlPayloadTasks({
      tasks,
      measureBytes: measureList,
      budgetBytes: truncatedOnlyBytes,
    });
    expect(result.tasks).toHaveLength(4);
    expect(result.stats.truncatedTitleCount).toBe(4);
    expect(result.stats.droppedTaskCount).toBe(0);
  });

  it("never emits a payload above the default budget for hostile input", () => {
    // 复刻 2026-10-13 事故数据形状：900+ 任务、单条 122KB 标题、大量 5KB 级 prompt 标题。
    const tasks = [
      createTask({
        taskId: "huge",
        title: "z".repeat(122_798),
        updatedAt: 10_000,
      }),
      ...Array.from({ length: 950 }, (_, index) =>
        createTask({
          taskId: `task-${index}`,
          title: `prompt-${index}-${"p".repeat(5_000)}`,
          updatedAt: 9_999 - index,
        }),
      ),
    ];
    expect(measureList(tasks)).toBeGreaterThan(1024 * 1024);
    const result = boundWebRemoteControlPayloadTasks({
      tasks,
      measureBytes: measureList,
    });
    expect(result.stats.bytesAfter).toBeLessThanOrEqual(
      WEB_REMOTE_CONTROL_APP_PAYLOAD_PLAINTEXT_BUDGET_BYTES,
    );
    // 明文预算 700KiB 密封后必须低于 1MiB 物理帧硬上限（base64 ×4/3 + nonce/tag/envelope）。
    const sealedEstimate =
      Math.ceil((result.stats.bytesAfter + 40) / 3) * 4 + 256;
    expect(sealedEstimate).toBeLessThanOrEqual(1024 * 1024);
    // 最新的任务（含超大标题那条的截断版）必须保留。
    expect(result.tasks[0]?.taskId).toBe("huge");
    expect(result.tasks[0]?.title).toHaveLength(
      WEB_REMOTE_CONTROL_TASK_TITLE_MAX_CHARS,
    );
  });

  it("handles an empty list", () => {
    const result = boundWebRemoteControlPayloadTasks({
      tasks: [],
      measureBytes: measureList,
    });
    expect(result.tasks).toEqual([]);
    expect(result.stats.droppedTaskCount).toBe(0);
  });
});
