import assert from "node:assert/strict";
import test from "node:test";
import { ThreadStateStore } from "../src/thread-state.js";
import { projectSessionSummary } from "../src/projection.js";
import { projectLegacySnapshot } from "../src/projection-legacy.js";
import { reconcileBridgeSessions } from "../src/thread-queries.js";
import { handleLegacySession } from "../src/legacy-sessions.js";
import { CodexRpcError } from "../src/rpc-errors.js";
import type { CodexRpcPort } from "../src/contract.js";
import { readRecentNativeActivity } from "../src/thread-activity.js";

const thread = () => ({
  id: "t",
  cwd: "/work",
  createdAt: 100,
  updatedAt: 120,
  modelProvider: "openai",
  preview: "history",
  status: { type: "idle" },
  turns: [],
  name: null,
  forkedFromId: null,
  parentThreadId: null,
});
function port(handler: (method: string) => unknown): CodexRpcPort {
  return {
    async request<T>(method: string) {
      return handler(method) as T;
    },
    async respond() {},
    async respondError() {},
  };
}
test("cold resume metadata and non-activity notifications never advance the baseline", async () => {
  const store = new ThreadStateStore(
    port((method) => {
      if (method === "thread/read") return { thread: thread() };
      if (method === "thread/resume") return { thread: { ...thread(), updatedAt: 999 } };
      return { data: [], nextCursor: null };
    }),
    "/work",
  );
  const state = await store.ensure("t");
  assert.equal(projectSessionSummary(state.thread, "/work").lastActivityAt, 120000);
  for (const method of [
    "thread/settings/updated",
    "thread/goal/updated",
    "thread/goal/cleared",
    "thread/tokenUsage/updated",
    "thread/name/updated",
    "thread/status/changed",
  ]) {
    await store.apply({
      method,
      params: {
        threadId: "t",
        threadSettings: {},
        tokenUsage: {},
        goal: {},
        status: { type: "idle" },
        threadName: "renamed",
      },
    });
    assert.equal(projectSessionSummary(state.thread, "/work").lastActivityAt, 120000, method);
  }
});

test("only successfully applied missing-time live activity uses receipt time", async (t) => {
  t.mock.method(Date, "now", () => 150123);
  const store = new ThreadStateStore(
    port(() => ({})),
    "/work",
  );
  const state = store.markStarted(thread());
  await store.apply({
    method: "turn/started",
    params: {
      threadId: "t",
      turn: {
        id: "turn",
        status: "inProgress",
        items: [
          {
            id: "prompt",
            type: "userMessage",
            content: [{ type: "text", text: "hello", text_elements: [] }],
          },
        ],
      },
    },
  });
  assert.equal(state.thread.updatedAt, 150);
  assert.equal(projectSessionSummary(state.thread, "/work").lastActivityAt, 150000);
  assert.equal(projectLegacySnapshot(state.thread, "/work").session.updatedAt, 150000);
  t.mock.method(Date, "now", () => 160456);
  await store.apply({
    method: "item/started",
    params: {
      threadId: "t",
      turnId: "turn",
      startedAtMs: 151000,
      item: { id: "item", type: "agentMessage", text: "" },
    },
  });
  assert.equal(state.thread.updatedAt, 151);
  await store.apply({
    method: "item/agentMessage/delta",
    params: {
      threadId: "t",
      turnId: "turn",
      itemId: "item",
      delta: "live",
    },
  });
  assert.equal(state.thread.updatedAt, 160);
  assert.equal(projectSessionSummary(state.thread, "/work").lastActivityAt, 160000);
  assert.equal(projectLegacySnapshot(state.thread, "/work").session.updatedAt, 160000);
  await store.apply({
    method: "item/completed",
    params: {
      threadId: "t",
      turnId: "turn",
      completedAtMs: 161000,
      item: { id: "item", type: "agentMessage", text: "done" },
    },
  });
  t.mock.method(Date, "now", () => 999000);
  await store.apply({
    method: "item/agentMessage/delta",
    params: {
      threadId: "t",
      turnId: "turn",
      itemId: "item",
      delta: "stale",
    },
  });
  assert.equal(state.thread.updatedAt, 161);
});
test("native turn seconds and item milliseconds advance monotonically; ignored deltas do not", async () => {
  const store = new ThreadStateStore(
    port(() => ({})),
    "/work",
  );
  const state = store.markStarted(thread());
  await store.apply({
    method: "turn/started",
    params: {
      threadId: "t",
      turn: { id: "turn", status: "inProgress", startedAt: 130, items: [] },
    },
  });
  assert.equal(state.thread.updatedAt, 130);
  await store.apply({
    method: "item/started",
    params: {
      threadId: "t",
      turnId: "turn",
      item: { id: "item", type: "agentMessage", text: "", startedAtMs: 140123 },
    },
  });
  assert.equal(state.thread.updatedAt, 140);
  assert.equal(projectSessionSummary(state.thread, "/work").lastActivityAt, 140000);
  await store.apply({
    method: "item/agentMessage/delta",
    params: {
      threadId: "t",
      turnId: "turn",
      itemId: "missing",
      delta: "ignored",
    },
  });
  assert.equal(state.thread.updatedAt, 140);
  await store.apply({
    method: "turn/completed",
    params: {
      threadId: "t",
      turn: { id: "turn", status: "completed", completedAt: 135, items: [] },
    },
  });
  assert.equal(state.thread.updatedAt, 140);
});

test("unattached discovery refreshes changed activity without a history RPC for every row", async () => {
  let updatedAt = 120;
  let completedAt = 120;
  let injected = false;
  const methods: string[] = [];
  const rpc = port((method) => {
    methods.push(method);
    if (method === "thread/list")
      return {
        data: [
          { ...thread(), updatedAt },
          ...Array.from({ length: 20 }, (_, index) => ({ ...thread(), id: `other-${index}` })),
        ],
        nextCursor: null,
      };
    if (method === "thread/turns/list")
      return {
        data: [{ id: "external", status: "completed", completedAt, items: [] }],
        nextCursor: null,
      };
    if (method === "thread/items/list")
      return {
        data: [
          {
            turnId: "external",
            item: injected
              ? {
                  id: "last",
                  type: "userMessage",
                  content: [
                    {
                      type: "text",
                      text: "<environment_context><cwd>/work</cwd></environment_context>",
                    },
                  ],
                }
              : { id: "last", type: "agentMessage", text: "done" },
            completedAtMs: injected ? 1000123 : completedAt * 1000 + 123,
          },
        ],
        nextCursor: null,
      };
    return { thread: { ...thread(), updatedAt } };
  });
  const store = new ThreadStateStore(rpc, "/work");
  await store.list();
  await store.list();
  assert.deepEqual(methods, ["thread/list", "thread/list"]);
  updatedAt = 180;
  completedAt = 180;
  assert.equal(((await store.list()) as ReturnType<typeof thread>[])[0]!.updatedAt, 180);
  assert.equal(methods.filter((method) => method === "thread/turns/list").length, 1);
  assert.equal(methods.filter((method) => method === "thread/items/list").length, 1);
  updatedAt = 999; // settings/goal/token append，历史活动不变。
  const targeted = (await handleLegacySession(
    "session/list",
    { sessionIds: ["t"] },
    rpc,
    store,
    "/work",
  )) as {
    sessions: Array<{ updatedAt: number }>;
  };
  assert.equal(targeted.sessions[0]!.updatedAt, 180000);
  const reconciled = await reconcileBridgeSessions(
    { workspaceId: "/work", sessionIds: ["t"] },
    { rpc, store, cwd: "/work", workspaceId: "/work" },
  );
  assert.equal((reconciled.sessions[0] as { updatedAt: number }).updatedAt, 180000);
  const historyReads = methods.filter((method) => method === "thread/turns/list").length;
  await store.list();
  assert.equal(methods.filter((method) => method === "thread/turns/list").length, historyReads);
  assert.equal(store.get("t"), undefined, "只读补活动时间不加载或 resume 线程");
  assert.equal(methods.includes("thread/resume"), false);
  injected = true;
  updatedAt = 1000;
  assert.equal(
    ((await store.list()) as ReturnType<typeof thread>[])[0]!.updatedAt,
    180,
    "resume 注入的 user-role 环境块不是新的用户活动",
  );
});
test("scan completion overlays latest activity only, retaining native metadata and collection", async () => {
  const gate = Promise.withResolvers<unknown>();
  const store = new ThreadStateStore(
    port(() => gate.promise),
    "/work",
  );
  store.markStarted(thread());
  const listed = store.list();
  await store.apply({
    method: "turn/started",
    params: {
      threadId: "t",
      turn: { id: "turn", status: "inProgress", startedAt: 150, items: [] },
    },
  });
  gate.resolve({
    data: [{ ...thread(), preview: "native title", updatedAt: 999 }],
    nextCursor: null,
  });
  const [row] = (await listed) as ReturnType<typeof thread>[];
  assert.equal(row!.updatedAt, 150);
  assert.equal(row!.preview, "native title");
  assert.deepEqual(row!.turns, []);
});

test("partial activity reads coalesce, retain turn evidence and retry the dirty item on the next scan", async () => {
  const entered = Promise.withResolvers<void>();
  const item = Promise.withResolvers<unknown>();
  let recovered = false;
  let turns = 0;
  const rpc = port((method) => {
    if (method === "thread/turns/list") {
      turns++;
      return { data: [{ id: "external", completedAt: 180, items: [] }] };
    }
    entered.resolve();
    return recovered
      ? {
          data: [
            {
              turnId: "external",
              item: { id: "last", type: "agentMessage", text: "done" },
              completedAtMs: 181123,
            },
          ],
        }
      : item.promise;
  });
  const store = new ThreadStateStore(rpc, "/work");
  store.activityThread(thread());
  const metadata = { ...thread(), updatedAt: 999 };
  const reads = Array.from({ length: 3 }, () => store.refreshActivityThread(metadata));
  await entered.promise;
  item.reject(new Error("optional item read failed"));
  assert.deepEqual(
    (await Promise.all(reads)).map((row) => row.updatedAt),
    [180, 180, 180],
  );
  assert.equal(turns, 1, "失败的同一 flight 不由每个 waiter 各自重试");
  recovered = true;
  assert.equal((await store.refreshActivityThread(metadata)).updatedAt, 181);
  assert.equal(turns, 2);
  await store.refreshActivityThread(metadata);
  assert.equal(turns, 2);
});

test("list overlays all latest clocks after another row's optional activity read completes", async () => {
  for (const targeted of [false, true]) {
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<unknown>();
    const rpc: CodexRpcPort = {
      async request<T>(method: string, params: unknown) {
        const id = (params as { threadId?: string }).threadId;
        if (method === "thread/list")
          return { data: [thread(), { ...thread(), id: "external", updatedAt: 999 }] } as T;
        if (method === "thread/read") return { thread: { ...thread(), id, updatedAt: 999 } } as T;
        if (method === "thread/turns/list") {
          entered.resolve();
          return (await release.promise) as T;
        }
        return { data: [] } as T;
      },
      async respond() {},
      async respondError() {},
    };
    const store = new ThreadStateStore(rpc, "/work");
    store.markStarted(thread());
    store.activityThread({ ...thread(), id: "external" });
    const listing = handleLegacySession(
      "session/list",
      targeted ? { sessionIds: ["t", "external"] } : {},
      rpc,
      store,
      "/work",
    );
    await entered.promise;
    await store.apply({
      method: "turn/started",
      params: {
        threadId: "t",
        turn: { id: "live", status: "inProgress", startedAt: 180, items: [] },
      },
    });
    release.resolve({ data: [] });
    const result = (await listing) as { sessions: Array<{ sessionId: string; updatedAt: number }> };
    assert.equal(result.sessions.find((row) => row.sessionId === "t")!.updatedAt, 180000);
  }
});

test("writer-conflict load does not consume the fingerprint before reading running-turn item time", async () => {
  let items = 0;
  const rpc = port((method) => {
    if (method === "thread/resume") throw new CodexRpcError(-32600, "already has an active writer");
    if (method === "thread/read") return { thread: { ...thread(), updatedAt: 999 } };
    if (method === "thread/turns/list")
      return {
        data: [{ id: "running", status: "inProgress", startedAt: 130, items: [] }],
        nextCursor: null,
      };
    if (method === "thread/items/list") {
      items++;
      return {
        data: [
          {
            turnId: "running",
            item: { id: "last", type: "agentMessage", text: "activity" },
            completedAtMs: 180123,
          },
        ],
      };
    }
    return { data: [] };
  });
  const store = new ThreadStateStore(rpc, "/work");
  store.activityThread(thread());
  assert.equal((await store.ensure("t")).thread.updatedAt, 130);
  const result = (await handleLegacySession(
    "session/list",
    { sessionIds: ["t"] },
    rpc,
    store,
    "/work",
  )) as { sessions: Array<{ updatedAt: number }> };
  assert.equal(result.sessions[0]!.updatedAt, 180000);
  assert.equal(items, 1);
});

test("recent activity reads use four connection slots and fixed one-entry pages", async () => {
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let active = 0;
  let max = 0;
  const rpc: CodexRpcPort = {
    async request<T>(method: string, params: unknown) {
      assert.equal((params as { limit: number }).limit, 1);
      assert.equal((params as { sortDirection: string }).sortDirection, "desc");
      active++;
      max = Math.max(active, max);
      if (active === 4) entered.resolve();
      await release.promise;
      active--;
      return (
        method === "thread/turns/list"
          ? { data: [{ id: "external", completedAt: 180, items: [] }] }
          : { data: [] }
      ) as T;
    },
    async respond() {},
    async respondError() {},
  };
  const reads = Array.from({ length: 10 }, (_, index) =>
    readRecentNativeActivity(rpc, `t-${index}`),
  );
  await entered.promise;
  assert.equal(max, 4);
  release.resolve();
  await Promise.all(reads);
  assert.equal(max, 4);
});
test("resume and history paging cannot swallow live activity", async () => {
  let store: ThreadStateStore;
  store = new ThreadStateStore(
    port((method) => {
      if (method === "thread/read") return { thread: thread() };
      if (method === "thread/resume") {
        void store.apply({
          method: "turn/started",
          params: {
            threadId: "t",
            turn: { id: "live", status: "inProgress", startedAt: 160, items: [] },
          },
        });
        return { thread: { ...thread(), updatedAt: 999 } };
      }
      return { data: [], nextCursor: null };
    }),
    "/work",
  );
  assert.equal((await store.ensure("t")).thread.updatedAt, 160);
});

test("writer-conflict refresh supplements real history time without trusting new metadata time", async () => {
  let persistedAt = 130;
  let rawUpdatedAt = 120;
  const store = new ThreadStateStore(
    port((method) => {
      if (method === "thread/resume")
        throw new CodexRpcError(-32600, "already has an active writer");
      if (method === "thread/turns/list")
        return {
          data: [{ id: "external", status: "completed", items: [], completedAt: persistedAt }],
          nextCursor: null,
        };
      return { thread: { ...thread(), updatedAt: rawUpdatedAt } };
    }),
    "/work",
  );
  assert.equal((await store.ensure("t")).thread.updatedAt, 130);
  persistedAt = 180;
  rawUpdatedAt = 999;
  store.invalidate("t");
  const state = await store.ensure("t");
  assert.equal(state.thread.updatedAt, 180);
  assert.equal(state.readOnly, "writer-conflict");
});

test("summary, legacy, targeted/full list and reconcile share the cleaned activity field", async () => {
  const rpc = port((method) => {
    if (method === "thread/list")
      return { data: [{ ...thread(), updatedAt: 999 }], nextCursor: null };
    return { thread: { ...thread(), updatedAt: 999 } };
  });
  const store = new ThreadStateStore(rpc, "/work");
  const state = store.markStarted(thread());
  assert.equal(projectLegacySnapshot(state.thread, "/work").session.updatedAt, 120000);
  assert.equal(projectSessionSummary(state.thread, "/work").lastActivityAt, 120000);
  for (const params of [{}, { sessionIds: ["t"] }]) {
    const response = (await handleLegacySession("session/list", params, rpc, store, "/work")) as {
      sessions: Array<{ updatedAt: number }>;
    };
    assert.equal(response.sessions[0]!.updatedAt, 120000);
  }
  state.readOnly = "writer-conflict";
  store.invalidate("t");
  const reconciled = await reconcileBridgeSessions(
    { workspaceId: "/work", sessionIds: ["t"] },
    { rpc, store, cwd: "/work", workspaceId: "/work" },
  );
  assert.equal(reconciled.sessions[0]!.exists, true);
  assert.equal((reconciled.sessions[0] as { updatedAt: number }).updatedAt, 120000);
});
