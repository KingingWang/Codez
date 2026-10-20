import assert from "node:assert/strict";
import test from "node:test";
import type { PendingInteraction } from "@codez/shared/codez-protocol-v4";
import { projectThread } from "../src/projection.js";
import { BridgeSnapshots } from "../src/bridge-snapshots.js";
import { threadFixture } from "./projection-fixtures.test.js";
import { setup } from "./fixtures/commands-fixture.js";

const message = "stream disconnected before completion: E2E_CODEX_STREAM_FAILURE";
const options = { workspacePath: "/workspace" };
function failedThread() {
  const thread = threadFixture();
  thread.turns[0]!.status = "failed";
  thread.turns[0]!.error = { message };
  return thread;
}

for (const type of ["idle", "systemError", "notLoaded"] as const) {
  test(`latest failed turn under ${type} keeps the error but admits explicit follow-up`, () => {
    const thread = failedThread();
    thread.status = { type };
    const before = structuredClone(thread);
    const snapshot = projectThread(thread, options);
    assert.equal(snapshot.control.phase, "error");
    assert.equal(snapshot.control.lastError?.message, message);
    assert.equal(snapshot.control.canStop, false);
    assert.deepEqual(snapshot.inputRouting, { mode: "startNow" });
    assert.deepEqual(thread, before, "projection must not clear native error/history");
  });
}

test("a system error without the latest failed terminal fact still rejects input", () => {
  for (const status of ["completed", "inProgress"] as const) {
    const thread = threadFixture();
    thread.status = { type: "systemError" };
    thread.turns[0]!.status = status;
    assert.equal(projectThread(thread, options).inputRouting.mode, "reject");
  }
  const thread = threadFixture();
  thread.status = { type: "systemError" };
  thread.turns = [];
  assert.equal(projectThread(thread, options).inputRouting.mode, "reject");
});

test("failed history does not bypass active-unloaded or approval/question gates", () => {
  for (const activeFlags of [[], ["waitingOnApproval"], ["waitingOnUserInput"]] as const) {
    const thread = failedThread();
    thread.status = { type: "active", activeFlags: [...activeFlags] };
    assert.equal(projectThread(thread, options).inputRouting.mode, "reject");
  }
  const interaction: PendingInteraction = {
    interactionId: "pending-approval",
    kind: "permission",
    anchorRowId: null,
    createdAt: 121000,
    payload: {
      kind: "permission",
      toolCallId: "tool-1",
      toolName: "Bash",
      summary: "Approval still pending",
      detail: {},
      options: [{ optionId: "allow", label: "Allow", kind: "allowOnce" }],
    },
  };
  assert.equal(
    projectThread(failedThread(), { ...options, interactions: [interaction] }).inputRouting.mode,
    "reject",
  );
});

test("explicit follow-up uses existing admission once, preserving failed history and queue", async (t) => {
  const h = await setup(t);
  h.authority.thread = failedThread();
  h.authority.thread.status = { type: "systemError" };
  h.store.put(structuredClone(h.authority.thread));
  h.state.queue = structuredClone(h.authority.queue);
  const snapshots = new BridgeSnapshots(
    { rpc: h.rpc, cwd: "/workspace" },
    h.store,
    h.broker,
    "remote-workspace-identity",
  );
  const before = await snapshots.conversation("thread-1");
  assert.equal(before.inputRouting.mode, "startNow");
  assert.equal(before.queue.items.length, 2);
  assert.equal(h.rpc.calls.length, 0, "publishing the error cannot retry a model request");
  const command = h.command("sendText", {
    text: "E2E_CODEX_EXPLICIT_FOLLOWUP",
  });
  assert.equal((await h.execute(command)).status, "accepted");
  assert.equal((await h.execute(command)).status, "accepted");
  assert.equal(h.rpc.params("turn/start").length, 1, "command correlation prevents duplicates");
  assert.equal(h.rpc.params("thread/revert").length, 0);
  assert.equal(h.rpc.params("thread/queue/add").length, 0);
  assert.deepEqual(h.authority.thread.turns[0], failedThread().turns[0]);
  await h.store.apply({
    method: "thread/status/changed",
    params: { threadId: "thread-1", status: { type: "active", activeFlags: [] } },
  });
  const after = await snapshots.conversation("thread-1");
  assert.equal(after.inputRouting.mode, "enqueue");
  assert.equal(after.control.phase, "running");
  assert.equal(after.control.lastError, null);
  assert.deepEqual(after.queue, before.queue);
});

test("failed-turn recovery cannot remove writer-conflict read-only facts or command guards", async (t) => {
  const h = await setup(t);
  h.store.put(failedThread());
  h.state.readOnly = "writer-conflict";
  const snapshots = new BridgeSnapshots(
    { rpc: h.rpc, cwd: "/workspace" },
    h.store,
    h.broker,
    "remote-workspace-identity",
  );
  const snapshot = await snapshots.conversation("thread-1");
  assert.equal(snapshot.writerConflict?.readOnly, true);
  const ack = await h.execute(h.command("sendText", { text: "must not run" }));
  assert.equal(ack.status, "rejected");
  assert.equal(ack.reasonCode, "guard.codex.writerConflict");
  assert.equal(h.rpc.params("turn/start").length, 0);
});
