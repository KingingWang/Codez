import assert from "node:assert/strict";
import test from "node:test";
import { ThreadStateStore } from "../src/thread-state.js";
import type { CodexRpcPort } from "../src/contract.js";

const thread = () => ({
  id: "t1",
  cwd: "/work",
  turns: [],
  name: null,
  preview: "Thread",
  modelProvider: "openai",
  model: null,
  reasoningEffort: null,
  createdAt: 100,
  updatedAt: 120,
  status: { type: "idle" },
  forkedFromId: null,
  parentThreadId: null,
});
function port(handler: (method: string, params?: unknown) => unknown): CodexRpcPort {
  return {
    async request<T>(method: string, params?: unknown) {
      return handler(method, params) as T;
    },
    async respond() {},
    async respondError() {},
  };
}
test("history is paged and native queue is the only queue source", async () => {
  const calls: string[] = [];
  const store = new ThreadStateStore(
    port((method, params) => {
      calls.push(method);
      if (method === "thread/read" || method === "thread/resume") return { thread: thread() };
      if (method === "thread/queue/list") return { data: [{ id: "q" }], nextCursor: null };
      const cursor = (params as { cursor?: string }).cursor;
      return { data: [{ id: cursor ? "b" : "a" }], nextCursor: cursor ? null : "page2" };
    }),
    "/work",
  );
  const state = await store.ensure("t1");
  assert.deepEqual(state.thread.turns, [{ id: "a" }, { id: "b" }]);
  assert.deepEqual(state.queue, [{ id: "q" }]);
  await store.ensure("t1");
  assert.equal(calls.filter((method) => method === "thread/resume").length, 1);
});
test("cross workspace thread is rejected before resume", async () => {
  const calls: string[] = [];
  const store = new ThreadStateStore(
    port((method) => {
      calls.push(method);
      return { thread: { ...thread(), cwd: "/other" } };
    }),
    "/work",
  );
  await assert.rejects(store.ensure("t1"), /different workspace/);
  assert.deepEqual(calls, ["thread/read"]);
});
test("stream deltas preserve native item id and final items replace provisional text", () => {
  const store = new ThreadStateStore(
    port(() => ({})),
    "/work",
  );
  store.markStarted(thread());
  store.apply({
    method: "turn/started",
    params: { threadId: "t1", turn: { id: "turn", items: [] } },
  });
  store.apply({
    method: "item/started",
    params: { threadId: "t1", turnId: "turn", item: { id: "i", type: "agentMessage", text: "" } },
  });
  store.apply({
    method: "item/agentMessage/delta",
    params: { threadId: "t1", turnId: "turn", itemId: "i", delta: "中" },
  });
  store.apply({
    method: "item/completed",
    params: {
      threadId: "t1",
      turnId: "turn",
      item: { id: "i", type: "agentMessage", text: "中文" },
    },
  });
  assert.deepEqual(store.get("t1")?.thread.turns, [
    { id: "turn", itemsView: "full", items: [{ id: "i", type: "agentMessage", text: "中文" }] },
  ]);
});

test("deletion revokes state and prevents an in-flight history load resurrecting it", async () => {
  const page = Promise.withResolvers<unknown>();
  const store = new ThreadStateStore(
    port((method) => {
      if (method === "thread/turns/list") return page.promise;
      return { thread: thread() };
    }),
    "/work",
  );
  const loading = store.ensure("t1");
  await new Promise((resolve) => setImmediate(resolve));
  store.apply({ method: "thread/deleted", params: { threadId: "t1" } });
  page.resolve({ data: [], nextCursor: null });
  await assert.rejects(loading, /deleted/);
  assert.equal(store.get("t1"), undefined);
  await assert.rejects(store.ensure("t1"), /deleted/);
});

test("late turn/item start and deltas never regress completed content", () => {
  const store = new ThreadStateStore(
    port(() => ({})),
    "/work",
  );
  store.markStarted({
    ...thread(),
    turns: [{ id: "turn", status: "inProgress", itemsView: "full", items: [] }],
  });
  store.apply({
    method: "item/completed",
    params: {
      threadId: "t1",
      turnId: "turn",
      item: { id: "i", type: "agentMessage", text: "final" },
    },
  });
  store.apply({
    method: "item/started",
    params: { threadId: "t1", turnId: "turn", item: { id: "i", type: "agentMessage", text: "" } },
  });
  store.apply({
    method: "item/agentMessage/delta",
    params: { threadId: "t1", turnId: "turn", itemId: "i", delta: "stale" },
  });
  store.apply({
    method: "turn/completed",
    params: {
      threadId: "t1",
      turn: { id: "turn", status: "completed", itemsView: "summary", items: [] },
    },
  });
  store.apply({
    method: "turn/started",
    params: {
      threadId: "t1",
      turn: { id: "turn", status: "inProgress", itemsView: "summary", items: [] },
    },
  });
  assert.deepEqual(store.get("t1")?.thread.turns, [
    {
      id: "turn",
      status: "completed",
      itemsView: "full",
      items: [{ id: "i", type: "agentMessage", text: "final" }],
    },
  ]);
});

test("history paging plus live notification retains earlier items in the same turn", async () => {
  const page = Promise.withResolvers<unknown>();
  const store = new ThreadStateStore(
    port((method) => {
      if (method === "thread/turns/list") return page.promise;
      if (method === "thread/queue/list") return { data: [], nextCursor: null };
      return { thread: thread() };
    }),
    "/work",
  );
  const loading = store.ensure("t1");
  await new Promise((resolve) => setImmediate(resolve));
  store.apply({ method: "thread/started", params: { thread: thread() } });
  store.apply({
    method: "turn/started",
    params: { threadId: "t1", turn: { id: "turn", status: "inProgress", items: [] } },
  });
  store.apply({
    method: "item/started",
    params: {
      threadId: "t1",
      turnId: "turn",
      item: { id: "live", type: "agentMessage", text: "now" },
    },
  });
  page.resolve({
    data: [
      {
        id: "turn",
        status: "inProgress",
        itemsView: "full",
        items: [{ id: "user", type: "userMessage", content: [] }],
      },
    ],
    nextCursor: null,
  });
  const state = await loading;
  assert.deepEqual(
    (state.thread.turns as { items: { id: string }[] }[])[0]!.items.map((item) => item.id),
    ["user", "live"],
  );
});

test("duplicate native thread records across pages keep first order and newest record", async () => {
  const calls: string[] = [];
  const first = { ...thread(), id: "same", updatedAt: 100, preview: "first" };
  const newest = { ...first, updatedAt: 200, preview: "newest" };
  const stale = { ...first, updatedAt: 150, preview: "stale" };
  const other = { ...thread(), id: "other", updatedAt: 175 };
  const store = new ThreadStateStore(
    port((method, params) => {
      calls.push(method);
      if (method !== "thread/list") return { data: [], nextCursor: null };
      return (params as { cursor?: string }).cursor
        ? {
            data: [other, stale, { ...newest, updatedAt: 200, preview: "late tie" }],
            nextCursor: null,
          }
        : { data: [first, newest], nextCursor: "page-2" };
    }),
    "/work",
  );
  assert.deepEqual(await store.list(), [newest, other]);
  assert.deepEqual(calls, ["thread/list", "thread/list"]);
});

test("thread-list duplicate canonicalization rejects malformed records instead of coercing", async () => {
  const malformed = { ...thread(), id: "same", updatedAt: "200", preview: "bad" };
  const store = new ThreadStateStore(
    port((method, params) =>
      method === "thread/list" && !(params as { cursor?: string }).cursor
        ? { data: [malformed], nextCursor: null }
        : { data: [], nextCursor: null },
    ),
    "/work",
  );
  await assert.rejects(store.list(), /updatedAt/);
});
