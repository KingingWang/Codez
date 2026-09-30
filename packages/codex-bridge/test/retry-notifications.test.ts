import assert from "node:assert/strict";
import test from "node:test";
import { conversationSnapshotSchema } from "@codez/shared/codez-protocol-v4";
import { ThreadStateStore } from "../src/thread-state.js";
import { projectThread } from "../src/projection.js";
import { threadFixture } from "./projection-fixtures.test.js";

function runningStore() {
  const thread = threadFixture();
  thread.status = { type: "active", activeFlags: [] };
  thread.turns[0]!.status = "inProgress";
  thread.turns[0]!.completedAt = null;
  thread.turns[0]!.items = thread.turns[0]!.items.slice(0, 1);
  const store = new ThreadStateStore(
    {
      async request<T>() {
        return {} as T;
      },
      async respond() {},
      async respondError() {},
    },
    "/workspace",
  );
  store.markStarted(thread);
  return store;
}

function retryNotification(
  threadId = "thread-1",
  turnId = "turn-1",
  httpStatusCode: unknown = 503,
) {
  return {
    method: "error",
    params: {
      threadId,
      turnId,
      willRetry: true,
      error: {
        message: "Reconnecting... 1/5",
        additionalDetails: "raw provider body must not enter UI",
        codexErrorInfo: { responseStreamDisconnected: { httpStatusCode } },
      },
    },
  };
}

test("native retry notification is turn-scoped, published and schema-valid without provider details", async () => {
  const store = runningStore();
  const before = store.get("thread-1")!.seq;
  await store.apply(retryNotification());
  const state = store.get("thread-1")!;
  assert.equal(state.seq, before + 1);
  const afterFirstSeq = state.seq;
  const snapshot = projectThread(state.thread, {
    workspacePath: "/workspace",
    logEpoch: state.epoch,
    seq: state.seq,
    revision: state.revision,
    apiRetry: state.apiRetry?.status ?? null,
  });
  assert.deepEqual(snapshot.control.apiRetry, { source: "codex", httpStatusCode: 503 });
  assert.deepEqual(conversationSnapshotSchema.parse(snapshot), snapshot);
  assert.equal(JSON.stringify(snapshot).includes("raw provider body"), false);
  await store.apply(retryNotification());
  assert.equal(store.get("thread-1")!.seq, afterFirstSeq, "duplicate state is not re-published");
});

test("unknown status stays unknown; terminal failures and first model progress clear retry", async () => {
  const store = runningStore();
  await store.apply({
    method: "error",
    params: { threadId: "thread-1", turnId: "turn-1", willRetry: true, error: { message: "Retrying" } },
  });
  assert.deepEqual(store.get("thread-1")!.apiRetry?.status, {
    source: "codex",
    httpStatusCode: null,
  });
  await store.apply(retryNotification("thread-1", "turn-1", null));
  assert.deepEqual(store.get("thread-1")!.apiRetry?.status, {
    source: "codex",
    httpStatusCode: null,
  });
  await store.apply({
    method: "item/started",
    params: {
      threadId: "thread-1",
      turnId: "turn-1",
      item: { id: "answer", type: "agentMessage", text: "" },
    },
  });
  assert.equal(store.get("thread-1")!.apiRetry, null);
  await store.apply(retryNotification());
  await store.apply({
    method: "error",
    params: { threadId: "thread-1", turnId: "turn-1", willRetry: false, error: {} },
  });
  assert.equal(store.get("thread-1")!.apiRetry, null);
});

test("foreign, stale and terminal turns cannot create or revive a native retry", async () => {
  const store = runningStore();
  const before = store.get("thread-1")!.seq;
  await store.apply(retryNotification("foreign"));
  await store.apply(retryNotification("thread-1", "old-turn"));
  assert.equal(store.get("thread-1")!.seq, before);
  await store.apply(retryNotification());
  await store.apply({
    method: "turn/completed",
    params: {
      threadId: "thread-1",
      turn: { id: "turn-1", status: "completed", items: [] },
    },
  });
  assert.equal(store.get("thread-1")!.apiRetry, null);
  await store.apply(retryNotification());
  assert.equal(store.get("thread-1")!.apiRetry, null);
  await store.apply({
    method: "turn/started",
    params: {
      threadId: "thread-1",
      turn: { id: "turn-2", status: "inProgress", items: [] },
    },
  });
  await store.apply(retryNotification("thread-1", "turn-1"));
  assert.equal(store.get("thread-1")!.apiRetry, null, "a prior turn cannot revive its retry");
});

test("invalid HTTP code is not invented and next turn has no previous retry", async () => {
  const store = runningStore();
  await store.apply(retryNotification("thread-1", "turn-1", 999));
  assert.equal(store.get("thread-1")!.apiRetry?.status.httpStatusCode, null);
  await store.apply({
    method: "turn/started",
    params: {
      threadId: "thread-1",
      turn: { id: "turn-2", status: "inProgress", items: [] },
    },
  });
  assert.equal(store.get("thread-1")!.apiRetry, null);
  await store.apply({
    method: "turn/completed",
    params: { threadId: "thread-1", turn: { id: "turn-2", status: "completed", items: [] } },
  });
  await store.apply(retryNotification());
  assert.equal(
    store.get("thread-1")!.apiRetry,
    null,
    "an old in-progress turn cannot reactivate after a newer completed turn",
  );
});

test("native HTTP codes are displayed only when Codex reports an actual retry", async () => {
  for (const status of [400, 401, 420, 500, 503]) {
    const store = runningStore();
    await store.apply(retryNotification("thread-1", "turn-1", status));
    assert.equal(store.get("thread-1")!.apiRetry?.status.httpStatusCode, status);
  }
  const store = runningStore();
  await store.apply({
    method: "error",
    params: {
      threadId: "thread-1",
      turnId: "turn-1",
      willRetry: false,
      error: { codexErrorInfo: { responseStreamDisconnected: { httpStatusCode: 503 } } },
    },
  });
  assert.equal(store.get("thread-1")!.apiRetry, null);
});
