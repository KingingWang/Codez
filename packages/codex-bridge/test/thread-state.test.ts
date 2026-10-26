import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ThreadStateStore } from "../src/thread-state.js";
import { projectThreadMode } from "../src/command-input.js";
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
  const resumes: unknown[] = [];
  const store = new ThreadStateStore(
    port((method, params) => {
      calls.push(method);
      if (method === "thread/resume") {
        resumes.push(params);
        return { thread: thread() };
      }
      if (method === "thread/read") return { thread: thread() };
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
  // 原生 paginated resume 默认仍返回完整历史；桥接随后又调用 turns/list。
  // 冷恢复须只 attach 一次，历史由单一只读分页入口提供，避免单条 resume 帧超限。
  assert.deepEqual(resumes, [{ threadId: "t1", excludeTurns: true }]);
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

test("reasoning summaryTextDelta and textDelta stream into reasoning item before completion", () => {
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
    params: {
      threadId: "t1",
      turnId: "turn",
      item: { id: "r1", type: "reasoning", summary: [], content: [""] },
    },
  });
  store.apply({
    method: "item/reasoning/textDelta",
    params: { threadId: "t1", turnId: "turn", itemId: "r1", contentIndex: 0, delta: "先检查" },
  });
  store.apply({
    method: "item/reasoning/textDelta",
    params: { threadId: "t1", turnId: "turn", itemId: "r1", contentIndex: 0, delta: "代码" },
  });
  assert.deepEqual(store.get("t1")?.thread.turns, [
    {
      id: "turn",
      itemsView: "full",
      items: [
        {
          id: "r1",
          type: "reasoning",
          summary: [],
          content: ["先检查代码"],
          status: "inProgress",
        },
      ],
    },
  ]);
  store.apply({
    method: "item/completed",
    params: {
      threadId: "t1",
      turnId: "turn",
      item: { id: "r1", type: "reasoning", summary: ["先检查代码"], content: [] },
    },
  });
  assert.deepEqual(store.get("t1")?.thread.turns, [
    {
      id: "turn",
      itemsView: "full",
      items: [
        {
          id: "r1",
          type: "reasoning",
          summary: ["先检查代码"],
          content: [],
          status: "completed",
        },
      ],
    },
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

test("turn/completed without a prior local turn/started hydrates full items before touching projection", async () => {
  const store = new ThreadStateStore(
    port((method, params) => {
      const p = params as Record<string, unknown>;
      if (method === "thread/items/list") {
        assert.equal(p.threadId, "t1");
        assert.equal(p.turnId, "turn-orphan");
        return {
          data: [
            {
              turnId: "turn-orphan",
              item: { id: "user-1", type: "userMessage", content: [] },
            },
            {
              turnId: "turn-orphan",
              item: { id: "msg-1", type: "agentMessage", text: "recovered answer" },
            },
          ],
          nextCursor: null,
        };
      }
      return {};
    }),
    "/work",
  );
  store.markStarted(thread());
  await store.apply({
    method: "turn/completed",
    params: {
      threadId: "t1",
      turn: { id: "turn-orphan", status: "completed", itemsView: "summary", items: [] },
    },
  });
  assert.deepEqual(store.get("t1")?.thread.turns, [
    {
      id: "turn-orphan",
      status: "completed",
      itemsView: "full",
      items: [
        { id: "user-1", type: "userMessage", content: [] },
        { id: "msg-1", type: "agentMessage", text: "recovered answer" },
      ],
    },
  ]);
});

test("turn/completed arriving before thread/turns/list omits the new turn still resolves to full items", async () => {
  const page = Promise.withResolvers<unknown>();
  const store = new ThreadStateStore(
    port((method, params) => {
      const p = params as Record<string, unknown>;
      if (method === "thread/turns/list") return page.promise;
      if (method === "thread/queue/list") return { data: [], nextCursor: null };
      if (method === "thread/items/list") {
        return {
          data: [
            {
              turnId: p.turnId,
              item: { id: "live-item", type: "agentMessage", text: "from-items-list" },
            },
          ],
          nextCursor: null,
        };
      }
      return { thread: thread() };
    }),
    "/work",
  );
  const loading = store.ensure("t1");
  await new Promise((resolve) => setImmediate(resolve));
  await store.apply({ method: "thread/started", params: { thread: thread() } });
  await store.apply({
    method: "turn/completed",
    params: {
      threadId: "t1",
      turn: { id: "turn-new", status: "completed", itemsView: "summary", items: [] },
    },
  });
  page.resolve({
    data: [
      {
        id: "turn-old",
        status: "completed",
        itemsView: "full",
        items: [{ id: "old-item", type: "agentMessage", text: "old" }],
      },
    ],
    nextCursor: null,
  });
  const state = await loading;
  assert.deepEqual(state.thread.turns, [
    {
      id: "turn-old",
      status: "completed",
      itemsView: "full",
      items: [{ id: "old-item", type: "agentMessage", text: "old" }],
    },
    {
      id: "turn-new",
      status: "completed",
      itemsView: "full",
      items: [{ id: "live-item", type: "agentMessage", text: "from-items-list" }],
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
  // 归属判定要解析物理路径，thread/started 必须先落位，后续 turn/item 才有投影可写。
  await store.apply({ method: "thread/started", params: { thread: thread() } });
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

test("project discovery requests all providers and user-facing native sources on every page", async () => {
  const calls: Record<string, unknown>[] = [];
  const store = new ThreadStateStore(
    port((method, params) => {
      assert.equal(method, "thread/list");
      const request = params as Record<string, unknown>;
      calls.push(request);
      assert.deepEqual(request.modelProviders, []);
      assert.deepEqual(request.sourceKinds, ["cli", "vscode", "exec", "appServer"]);
      assert.equal(request.cwd, "/work");
      assert.equal(request.archived, false);
      return request.cursor
        ? { data: [{ ...thread(), id: "cli", modelProvider: "other" }], nextCursor: null }
        : { data: [thread(), { ...thread(), id: "foreign", cwd: "/other" }], nextCursor: "next" };
    }),
    "/work",
  );
  assert.deepEqual(
    (await store.list()).map((entry) => (entry as { id: string }).id),
    ["t1", "cli"],
  );
  assert.equal(calls.length, 2);
  await store.list();
  assert.equal(calls.length, 4, "opening a project scans native history again, not a cached list");
});

test("concurrent store.list() calls coalesce in flight and clear after settling", async () => {
  let listCalls = 0;
  const gate = Promise.withResolvers<{ data: unknown[]; nextCursor: null }>();
  const store = new ThreadStateStore(
    port((method) => {
      assert.equal(method, "thread/list");
      listCalls += 1;
      if (listCalls === 1) return gate.promise;
      if (listCalls === 2) throw new Error("transient list failure");
      return { data: [{ ...thread(), id: "after-recovery" }], nextCursor: null };
    }),
    "/work",
  );

  const [first, second, third] = [store.list(), store.list(), store.list()];
  assert.equal(listCalls, 1, "concurrent callers must share one in-flight thread/list scan");
  gate.resolve({ data: [thread()], nextCursor: null });
  const results = await Promise.all([first, second, third]);
  for (const rows of results) {
    assert.deepEqual(
      rows.map((entry) => (entry as { id: string }).id),
      ["t1"],
    );
  }

  await assert.rejects(store.list(), /transient list failure/);
  assert.equal(listCalls, 2);
  assert.deepEqual(
    (await store.list()).map((entry) => (entry as { id: string }).id),
    ["after-recovery"],
  );
  assert.equal(listCalls, 3);
});

test("aliased workspace path discovers, resumes and attributes native threads", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "codez-thread-state-alias-"));
  const physical = join(root, "physical");
  const alias = join(root, "alias");
  await mkdir(physical);
  await symlink(physical, alias, process.platform === "win32" ? "junction" : "dir");
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));

  const store = new ThreadStateStore(
    port((method) => {
      // CLI/exec 落盘的是物理路径；另一条记录属于真正不同的目录，必须继续被排除。
      if (method === "thread/list")
        return {
          data: [
            { ...thread(), cwd: physical },
            { ...thread(), id: "foreign", cwd: root },
          ],
          nextCursor: null,
        };
      if (method === "thread/read" || method === "thread/resume")
        return { thread: { ...thread(), cwd: physical } };
      if (method === "thread/turns/list") return { data: [{ id: "turn-1" }], nextCursor: null };
      if (method === "thread/queue/list") return { data: [], nextCursor: null };
      return {};
    }),
    alias,
  );

  assert.deepEqual(
    (await store.list()).map((row) => (row as { id: string }).id),
    ["t1"],
  );
  const state = await store.ensure("t1");
  assert.deepEqual(state.thread.turns, [{ id: "turn-1" }]);
  // thread/started 实时通知也必须把物理拼写归属到别名工作区。
  assert.equal(
    await store.apply({
      method: "thread/started",
      params: { thread: { ...thread(), id: "live", cwd: physical } },
    }),
    "live",
  );
  assert.equal(
    await store.apply({
      method: "thread/started",
      params: { thread: { ...thread(), id: "elsewhere", cwd: root } },
    }),
    undefined,
  );
});

test("turn/plan/updated upserts one normalized plan item per turn", async () => {
  const store = new ThreadStateStore(
    port(() => ({})),
    "/work",
  );
  store.markStarted(thread());
  await store.apply({
    method: "turn/started",
    params: { threadId: "t1", turn: { id: "turn", items: [] } },
  });
  await store.apply({
    method: "turn/plan/updated",
    params: {
      threadId: "t1",
      turnId: "turn",
      explanation: "先摸清现状",
      plan: [
        { step: "探查代码", status: "inProgress" },
        { step: "实现", status: "pending" },
        { step: "坏状态", status: "doing" },
        { step: 42, status: "completed" },
        "不是对象",
      ],
    },
  });
  let turns = store.get("t1")!.thread.turns as { items: unknown[] }[];
  assert.equal(turns[0]!.items.length, 1);
  assert.deepEqual(turns[0]!.items[0], {
    id: "plan-update",
    type: "planUpdate",
    explanation: "先摸清现状",
    plan: [
      { step: "探查代码", status: "in_progress" },
      { step: "实现", status: "pending" },
    ],
  });

  // 全量替换：同 turn 再更新时原位覆盖，不产生第二张卡；explanation 缺席即移除。
  await store.apply({
    method: "turn/plan/updated",
    params: {
      threadId: "t1",
      turnId: "turn",
      plan: [
        { step: "探查代码", status: "completed" },
        { step: "实现", status: "in_progress" },
      ],
    },
  });
  turns = store.get("t1")!.thread.turns as { items: unknown[] }[];
  assert.equal(turns[0]!.items.length, 1);
  assert.deepEqual(turns[0]!.items[0], {
    id: "plan-update",
    type: "planUpdate",
    plan: [
      { step: "探查代码", status: "completed" },
      { step: "实现", status: "in_progress" },
    ],
  });

  // 未知 turn 与空计划静默忽略，事件尾巴不受影响。
  await store.apply({
    method: "turn/plan/updated",
    params: { threadId: "t1", turnId: "missing", plan: [{ step: "x", status: "pending" }] },
  });
  await store.apply({
    method: "turn/plan/updated",
    params: { threadId: "t1", turnId: "turn", plan: [] },
  });
  turns = store.get("t1")!.thread.turns as { items: unknown[] }[];
  assert.equal(turns[0]!.items.length, 1);
});

test("thread/settings/updated syncs approvalsReviewer so an external auto_review switch projects edit", async () => {
  const store = new ThreadStateStore(
    port(() => ({})),
    "/work",
  );
  store.markStarted(thread());
  // 外部（CLI/另一窗口）切到 AI 代批：通知必须同步 approvalsReviewer，否则投影滞留旧值，
  // 标签与生效权限静默错位（specs/codex-permission-modes.md）。
  await store.apply({
    method: "thread/settings/updated",
    params: {
      threadId: "t1",
      threadSettings: {
        model: "m",
        effort: "high",
        sandboxPolicy: { type: "workspaceWrite" },
        approvalPolicy: "on-request",
        approvalsReviewer: "auto_review",
        collaborationMode: { mode: "default" },
      },
    },
  });
  const projected = store.get("t1")!.thread;
  assert.equal(projected.approvalsReviewer, "auto_review");
  assert.equal(projectThreadMode(projected), "edit");
});

test("item/autoApprovalReview started, strictReviewRequired, completed, and turn completion settle state", async () => {
  const changed: string[] = [];
  const store = new ThreadStateStore(
    port(() => ({})),
    "/work",
  );
  store.onChange((id) => changed.push(id));
  store.markStarted(thread());
  await store.apply({
    method: "turn/started",
    params: { threadId: "t1", turn: { id: "turn-1", status: "inProgress", items: [] } },
  });
  const beforeRevision = store.get("t1")!.revision;

  await store.apply({
    method: "item/autoApprovalReview/started",
    params: {
      threadId: "t1",
      turnId: "turn-1",
      reviewId: "review-1",
      targetItemId: "cmd-1",
      startedAtMs: 1_000,
      review: { status: "inProgress" },
      action: { type: "command", source: "shell", command: "git pull", cwd: "/work" },
    },
  });
  assert.equal(store.get("t1")!.revision, beforeRevision + 1);
  assert.equal(
    store.get("t1")!.autoApprovalReviews?.["turn-1"]?.["review-1"]?.status,
    "inProgress",
  );
  assert.equal(
    store.get("t1")!.autoApprovalReviews?.["turn-1"]?.["review-1"]?.actionSummary,
    "git pull",
  );

  await store.apply({
    method: "autoApprovalReview/strictReviewRequired",
    params: { threadId: "t1", turnId: "turn-1", startedAtMs: 1_010 },
  });
  assert.equal(
    store.get("t1")!.autoApprovalReviews?.["turn-1"]?.["review-1"]?.strictReviewRequired,
    true,
  );

  await store.apply({
    method: "item/autoApprovalReview/completed",
    params: {
      threadId: "t1",
      turnId: "turn-1",
      reviewId: "review-1",
      targetItemId: "cmd-1",
      startedAtMs: 1_000,
      completedAtMs: 1_500,
      decisionSource: "agent",
      review: {
        status: "approved",
        riskLevel: "low",
        userAuthorization: "high",
        rationale: "Read-only fetch from remote",
      },
      action: { type: "command", source: "shell", command: "git pull", cwd: "/work" },
    },
  });
  const completedEntry = store.get("t1")!.autoApprovalReviews?.["turn-1"]?.["review-1"];
  assert.equal(completedEntry?.status, "approved");
  assert.equal(completedEntry?.riskLevel, "low");
  assert.equal(completedEntry?.rationale, "Read-only fetch from remote");
  assert.equal(completedEntry?.completedAtMs, 1_500);

  // 迟到的 started 通知不得将已完成的 review 回退为 inProgress。
  const afterCompletedRevision = store.get("t1")!.revision;
  await store.apply({
    method: "item/autoApprovalReview/started",
    params: {
      threadId: "t1",
      turnId: "turn-1",
      reviewId: "review-1",
      targetItemId: "cmd-1",
      startedAtMs: 1_000,
      review: { status: "inProgress" },
      action: { type: "command", source: "shell", command: "git pull", cwd: "/work" },
    },
  });
  assert.equal(store.get("t1")!.revision, afterCompletedRevision);
  assert.equal(store.get("t1")!.autoApprovalReviews?.["turn-1"]?.["review-1"]?.status, "approved");

  // 第二个 inProgress review 在 turn 中断时自动收敛为 aborted。
  await store.apply({
    method: "item/autoApprovalReview/started",
    params: {
      threadId: "t1",
      turnId: "turn-1",
      reviewId: "review-2",
      targetItemId: null,
      startedAtMs: 2_000,
      review: { status: "inProgress" },
      action: {
        type: "networkAccess",
        target: "https://example.com:443",
        host: "example.com",
        protocol: "https",
        port: 443,
      },
    },
  });
  await store.apply({
    method: "turn/completed",
    params: { threadId: "t1", turn: { id: "turn-1", status: "interrupted", items: [] } },
  });
  assert.equal(store.get("t1")!.autoApprovalReviews?.["turn-1"]?.["review-2"]?.status, "aborted");
  assert.ok(changed.includes("t1"));
});

interface RawItem {
  id: string;
  type: string;
  text?: string;
  plan?: unknown;
  [key: string]: unknown;
}

interface RawTurn {
  id: string;
  status: string;
  itemsView: string;
  items: RawItem[];
  [key: string]: unknown;
}

/** N 轮已 settled 的历史 + 1 个活动轮：用于验证事件成本不随历史长度增长。 */
function longThread(settledTurns: number) {
  const turns: RawTurn[] = [];
  for (let index = 0; index < settledTurns; index += 1) {
    turns.push({
      id: `turn-${index}`,
      status: "completed",
      itemsView: "full",
      startedAt: 100 + index,
      completedAt: 101 + index,
      items: [
        { id: `item-${index}`, type: "agentMessage", text: `answer ${index}`, status: "completed" },
      ],
    });
  }
  turns.push({
    id: "turn-active",
    status: "inProgress",
    itemsView: "full",
    startedAt: 200 + settledTurns,
    items: [{ id: "stream", type: "agentMessage", text: "", status: "inProgress" }],
  });
  return { ...thread(), turns };
}

function turnsOf(store: ThreadStateStore): RawTurn[] {
  return store.get("t1")!.thread.turns as unknown as RawTurn[];
}

function turnById(store: ThreadStateStore, id: string): RawTurn {
  const found = turnsOf(store).find((turn) => turn.id === id);
  assert.ok(found, `missing turn ${id}`);
  return found;
}

test("流式 delta 走 turn/item 增量索引，turns 元素读取次数与历史长度无关", async () => {
  const store = new ThreadStateStore(
    port(() => ({})),
    "/work",
  );
  store.markStarted(longThread(1200));
  const state = store.get("t1")!;
  let reads = 0;
  // 计数代理只统计对 thread.turns 数值下标的读取：索引命中路径每条 delta 只读 1 个元素，
  // 旧的 `turns.map(object).find(...)` 会读满 1201 个。用可数的结构断言 O(1)，
  // 而不是依赖容易受机器负载影响的计时阈值。
  state.thread.turns = new Proxy(state.thread.turns as unknown[], {
    get(target, property, receiver) {
      if (typeof property === "string" && /^\d+$/.test(property)) reads += 1;
      return Reflect.get(target, property, receiver);
    },
  });
  const stream = () =>
    store.apply({
      method: "item/agentMessage/delta",
      params: { threadId: "t1", turnId: "turn-active", itemId: "stream", delta: "字" },
    });
  // 预热：首条 delta 会按当前数组建索引（O(N)），之后每条都必须走快路径。
  await stream();
  reads = 0;
  for (let index = 0; index < 40; index += 1) await stream();
  assert.ok(reads <= 120, `40 条 delta 读取 turns 元素 ${reads} 次，索引退化成线性扫描`);
  assert.equal(turnById(store, "turn-active").items[0]!.text, "字".repeat(41));
});

test("外部替换 turns/items 引用或原位改写元素时索引自愈，不会误判 turn 缺失", async () => {
  const store = new ThreadStateStore(
    port(() => ({})),
    "/work",
  );
  store.markStarted(longThread(3));
  const state = store.get("t1")!;
  const delta = (turnId: string, itemId: string, text: string) =>
    store.apply({
      method: "item/agentMessage/delta",
      params: { threadId: "t1", turnId, itemId, delta: text },
    });

  // 1) 整体替换 turns 引用并追加一轮（引用与长度同时变化）
  const extra: RawTurn = {
    id: "turn-extra",
    status: "inProgress",
    itemsView: "full",
    items: [{ id: "extra-item", type: "agentMessage", text: "" }],
  };
  state.thread.turns = [...turnsOf(store), extra];
  await delta("turn-extra", "extra-item", "A");
  assert.equal(extra.items[0]!.text, "A");

  // 2) 替换某轮 items 引用（长度变化）：新 item 立即可定位
  const settledTurn = turnById(store, "turn-0");
  await delta("turn-0", "item-0", "!");
  const late: RawItem = { id: "late", type: "agentMessage", text: "" };
  settledTurn.items = [...settledTurn.items, late];
  await delta("turn-0", "late", "B");
  assert.equal(late.text, "B");

  // 3) 原位替换 turn 元素（引用与长度都不变）：新 id 靠自愈扫描定位，旧 id 不再命中过期条目
  const displaced = turnById(store, "turn-1");
  const replacement: RawTurn = {
    id: "turn-1-moved",
    status: "completed",
    itemsView: "full",
    items: [{ id: "moved", type: "agentMessage", text: "" }],
  };
  (state.thread.turns as unknown[])[1] = replacement;
  await delta("turn-1-moved", "moved", "C");
  assert.equal(replacement.items[0]!.text, "C");
  await delta("turn-1", "item-1", "X");
  assert.equal(displaced.items[0]!.text, "answer 1");
  // 3 轮 settled + 活动轮 + 第 1 步追加的 turn-extra：被丢弃的 delta 不能追加出新 turn
  assert.equal(turnsOf(store).length, 5);

  // 4) 原位替换 item 元素（数组引用与长度都不变）：身份校验发现错位后重建该轮 item 索引
  const active = turnById(store, "turn-active");
  await delta("turn-active", "stream", "D");
  assert.equal(active.items[0]!.text, "D");
  active.items[0] = { id: "stream", type: "agentMessage", text: "reset", status: "inProgress" };
  await delta("turn-active", "stream", "E");
  assert.equal(active.items[0]!.text, "resetE");
});

test("turn/plan/updated 原位替换 plan item 后，同轮 item 索引仍原位更新而不追加", async () => {
  const store = new ThreadStateStore(
    port(() => ({})),
    "/work",
  );
  store.markStarted(longThread(2));
  const planUpdate = (plan: unknown) =>
    store.apply({
      method: "turn/plan/updated",
      params: { threadId: "t1", turnId: "turn-active", plan },
    });
  await planUpdate([{ step: "第一步", status: "in_progress" }]);
  const active = turnById(store, "turn-active");
  const firstPlanItem = active.items.at(-1)!;
  assert.deepEqual(firstPlanItem.plan, [{ step: "第一步", status: "in_progress" }]);
  // 第二次更新是原位替换（items 引用与长度都不变）：索引必须失效重建，不能滞留旧 item
  await planUpdate([{ step: "第一步", status: "completed" }]);
  assert.notEqual(active.items.at(-1), firstPlanItem);
  assert.deepEqual(active.items.at(-1)!.plan, [{ step: "第一步", status: "completed" }]);
  await store.apply({
    method: "item/completed",
    params: {
      threadId: "t1",
      turnId: "turn-active",
      item: {
        id: "plan-update",
        type: "planUpdate",
        plan: [{ step: "第一步", status: "completed" }],
        status: "completed",
      },
    },
  });
  assert.equal(
    active.items.filter((item) => item.id === "plan-update").length,
    1,
    "plan item 必须原位替换而不是追加第二张计划卡",
  );
  await store.apply({
    method: "item/agentMessage/delta",
    params: { threadId: "t1", turnId: "turn-active", itemId: "stream", delta: "D" },
  });
  assert.equal(active.items[0]!.text, "D");
});

test("thread/tokenUsage/updated 缺 turnId 时倒序定位活动轮，全 settled 时回退最后一轮", async () => {
  const usage = {
    total: { inputTokens: 11_000, outputTokens: 300, totalTokens: 11_300 },
    last: { inputTokens: 10_000, outputTokens: 200, totalTokens: 10_200 },
  };
  const pushUsage = (store: ThreadStateStore) =>
    store.apply({
      method: "thread/tokenUsage/updated",
      params: { threadId: "t1", tokenUsage: usage },
    });
  // 长历史里活动轮在末尾：归属活动轮，且不需要复制整份历史（旧实现 map(object) 每帧分配）
  const long = new ThreadStateStore(
    port(() => ({})),
    "/work",
  );
  long.markStarted(longThread(1200));
  await pushUsage(long);
  assert.deepEqual(Object.keys(long.get("t1")!.turnTokenUsage ?? {}), ["turn-active"]);
  // 活动轮在中间：倒序找最后一个 inProgress，与旧 findLast 语义一致
  const middle = new ThreadStateStore(
    port(() => ({})),
    "/work",
  );
  middle.markStarted({
    ...thread(),
    turns: [
      { id: "a", status: "completed", itemsView: "full", items: [] },
      { id: "b", status: "inProgress", itemsView: "full", items: [] },
      { id: "c", status: "completed", itemsView: "full", items: [] },
    ],
  });
  await pushUsage(middle);
  assert.deepEqual(Object.keys(middle.get("t1")!.turnTokenUsage ?? {}), ["b"]);
  // 全部 settled：回退到最后一轮
  const settled = new ThreadStateStore(
    port(() => ({})),
    "/work",
  );
  settled.markStarted({
    ...thread(),
    turns: [
      { id: "a", status: "completed", itemsView: "full", items: [] },
      { id: "b", status: "completed", itemsView: "full", items: [] },
    ],
  });
  await pushUsage(settled);
  assert.deepEqual(Object.keys(settled.get("t1")!.turnTokenUsage ?? {}), ["b"]);
});
