import assert from "node:assert/strict";
import { test } from "node:test";
import type { CodezTaskMeta } from "@codez/shared";
import { attachTaskListRowActivity } from "@/v4/taskListRowActivity.js";
import { hasCurrentWorkspaceConcurrentWork } from "./CurrentWorkspaceConcurrencyHint.js";

function task(id: string, overrides: Partial<CodezTaskMeta> = {}): CodezTaskMeta {
  return {
    taskId: id,
    traceId: `trace-${id}` as CodezTaskMeta["traceId"],
    title: id,
    workspacePath: "/repo",
    createdAt: 1,
    updatedAt: 1,
    mode: "build",
    ...overrides,
  };
}

test("running and prewarming sessions-index phases indicate concurrent work", () => {
  const items = [
    attachTaskListRowActivity(task("running"), {
      phase: "running",
      lastActivityAt: 2,
      hasBackgroundWork: false,
    }),
    attachTaskListRowActivity(task("prewarming"), {
      phase: "prewarming",
      lastActivityAt: 3,
      hasBackgroundWork: false,
    }),
  ];
  assert.equal(hasCurrentWorkspaceConcurrentWork(items), true);
});

test("background work indicates concurrency even after the primary phase ends", () => {
  const items = [
    attachTaskListRowActivity(task("background"), {
      phase: "completedSuccess",
      lastActivityAt: 4,
      hasBackgroundWork: true,
    }),
  ];
  assert.equal(hasCurrentWorkspaceConcurrentWork(items), true);
});

test("terminal phases without background work do not indicate concurrency", () => {
  const items = [
    attachTaskListRowActivity(task("completed"), {
      phase: "completedSuccess",
      lastActivityAt: 4,
      hasBackgroundWork: false,
    }),
    attachTaskListRowActivity(task("interrupted"), {
      phase: "completedInterrupted",
      lastActivityAt: 5,
      hasBackgroundWork: false,
    }),
    attachTaskListRowActivity(task("error"), {
      phase: "error",
      lastActivityAt: 6,
      hasBackgroundWork: false,
    }),
  ];
  assert.equal(hasCurrentWorkspaceConcurrentWork(items), false);
});

test("stale persisted running status is not a concurrency signal", () => {
  const stalePersistedRunning = attachTaskListRowActivity(task("stale", { status: "running" }), {
    phase: "completedInterrupted",
    lastActivityAt: 7,
    hasBackgroundWork: false,
  });
  const draft = attachTaskListRowActivity(task("draft", { status: "running" }), {
    phase: "draft",
    lastActivityAt: 8,
    hasBackgroundWork: false,
  });

  assert.equal(hasCurrentWorkspaceConcurrentWork([stalePersistedRunning, draft]), false);
});
