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
  message = "Reconnecting... 1/5",
) {
  return {
    method: "error",
    params: {
      threadId,
      turnId,
      willRetry: true,
      error: {
        message,
        additionalDetails: '{"error":{"code":"rate_limit_reached"}}',
        codexErrorInfo: { responseStreamDisconnected: { httpStatusCode } },
      },
    },
  };
}

test("native retry notification is turn-scoped, published and schema-valid with bounded provider details", async () => {
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
  assert.deepEqual(snapshot.control.apiRetry, {
    source: "codex",
    httpStatusCode: 503,
    attempt: 1,
    maxRetries: 5,
    errorDetail: '{"error":{"code":"rate_limit_reached"}}',
  });
  assert.deepEqual(conversationSnapshotSchema.parse(snapshot), snapshot);
  assert.equal(JSON.stringify(snapshot).includes("rate_limit_reached"), true);
  await store.apply(retryNotification());
  assert.equal(store.get("thread-1")!.seq, afterFirstSeq, "duplicate state is not re-published");
  await store.apply(retryNotification("thread-1", "turn-1", 503, "Reconnecting... 2/5"));
  assert.equal(store.get("thread-1")!.seq, afterFirstSeq + 1, "next attempt is published");
  assert.deepEqual(store.get("thread-1")!.apiRetry?.status, {
    source: "codex",
    httpStatusCode: 503,
    attempt: 2,
    maxRetries: 5,
    errorDetail: '{"error":{"code":"rate_limit_reached"}}',
  });
});

test("unknown status stays unknown; terminal failures and first model progress clear retry", async () => {
  const store = runningStore();
  await store.apply({
    method: "error",
    params: {
      threadId: "thread-1",
      turnId: "turn-1",
      willRetry: true,
      error: { message: "Retrying" },
    },
  });
  assert.deepEqual(store.get("thread-1")!.apiRetry?.status, {
    source: "codex",
    httpStatusCode: null,
    attempt: null,
    maxRetries: null,
  });
  await store.apply(retryNotification("thread-1", "turn-1", null));
  assert.deepEqual(store.get("thread-1")!.apiRetry?.status, {
    source: "codex",
    httpStatusCode: null,
    attempt: 1,
    maxRetries: 5,
    errorDetail: '{"error":{"code":"rate_limit_reached"}}',
  });
  await store.apply(retryNotification("thread-1", "turn-1", 403, "Retrying 5/1"));
  assert.deepEqual(store.get("thread-1")!.apiRetry?.status, {
    source: "codex",
    httpStatusCode: 403,
    attempt: null,
    maxRetries: null,
    errorDetail: '{"error":{"code":"rate_limit_reached"}}',
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

/**
 * 回归：`thread.turns` 为空或整个字段缺失时，重试通知不得抛错。
 *
 * 原因：旧实现 `object(array(thread.turns).at(-1))` 假定「最后一轮一定存在」。空历史上
 * `array()` 防御性返回 []，`.at(-1)` 得到 undefined，`object(undefined)` 抛
 * "Expected a JSON object"；该异常发生在串行 event tail 上会被升级成 fatal，
 * bridge 进程退出，整个窗口的会话一起断。
 * 依据：`thread/started` 走的是未经 schema 校验的原始 put（thread-state.ts:344-352），
 * 新起线程在首个 turn/started 之前本来就没有轮次；「没有活动轮」在本模块语义里等于
 * 「过期/已结束轮的通知既不能创建也不能复活状态」，应返回 unchanged。
 */
test("a thread without native turn history cannot crash the retry notification path", async () => {
  const rpc = {
    async request<T>() {
      return {} as T;
    },
    async respond() {},
    async respondError() {},
  };
  // 情形一：turns 字段整个缺失（原生 thread/started 的原始形状）
  const missingTurns = new ThreadStateStore(rpc, "/workspace");
  missingTurns.put({
    id: "thread-missing",
    cwd: "/workspace",
    createdAt: 100,
    updatedAt: 100,
    status: { type: "idle" },
  });
  await missingTurns.apply(retryNotification("thread-missing", "turn-1"));
  assert.equal(
    missingTurns.get("thread-missing")!.apiRetry,
    null,
    "无轮次即无活动轮，不得创建观测",
  );

  // 情形二：turns 是空数组
  const emptyTurns = new ThreadStateStore(rpc, "/workspace");
  emptyTurns.put({
    id: "thread-empty",
    cwd: "/workspace",
    createdAt: 100,
    updatedAt: 100,
    status: { type: "idle" },
    turns: [],
  });
  await emptyTurns.apply(retryNotification("thread-empty", "turn-1"));
  assert.equal(emptyTurns.get("thread-empty")!.apiRetry, null);

  // 对照：终态通知（willRetry 非 true）在空历史上同样不得抛错
  await emptyTurns.apply({
    method: "error",
    params: { threadId: "thread-empty", turnId: "turn-1", willRetry: false },
  });
  assert.equal(emptyTurns.get("thread-empty")!.apiRetry, null);
});

/**
 * 回归：`reloadAfterHistoryChange` 必须同时清除轮次作用域的 apiRetry。
 *
 * 原因：它清了 turns 与 autoApprovalReviews 却漏了 apiRetry，于是从清空到 ensure() 完成之间
 * 存在「turns 为空 + apiRetry 仍在」的窗口（一次 thread/read + resume 往返，几十到几百毫秒），
 * 期间任何并发快照构建都会在 bridge-snapshots.ts 抛错并 fatal。更糟的是它会闩住：
 * ensure() 失败时该状态不会被覆盖，之后每次快照构建都抛错。
 * 依据：apiRetry 只归属某个 native turn，历史被整体替换后旧观测必然失效，
 * 与 autoApprovalReviews 同一口径清除。触发方是用户可见的中断/重试/继续流程。
 */
test("reloadAfterHistoryChange clears the turn-scoped retry observation and cannot latch a broken state", async () => {
  const store = runningStore();
  await store.apply(retryNotification());
  const live = store.get("thread-1")!;
  assert.ok(live.apiRetry, "前置条件：重试观测必须已经建立");
  assert.equal(live.apiRetry?.turnId, "turn-1");

  // stub rpc 不支持 thread/read，ensure() 必然失败——正好复现最坏情况：
  // 重载失败后状态不会被新的历史覆盖，旧实现会把「空 turns + 活 apiRetry」永久闩住。
  await assert.rejects(() => store.reloadAfterHistoryChange("thread-1"));

  const after = store.get("thread-1")!;
  assert.deepEqual(after.thread.turns, []);
  assert.equal(after.apiRetry, null, "重载后必须清除轮次作用域的重试观测");

  // 闩住的状态不得再让后续通知抛错
  await store.apply(retryNotification());
  assert.equal(store.get("thread-1")!.apiRetry, null);
});
