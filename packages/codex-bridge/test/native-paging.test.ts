import assert from "node:assert/strict";
import test from "node:test";
import { paginateNativeRows } from "../src/native-paging.js";
import { CodexTransportError } from "../src/rpc-errors.js";
import type { CodexRpcPort } from "../src/contract.js";

const tooLarge = () => new CodexTransportError("LIMIT", "Codex response frame exceeds size limit");

function port(read: (method: string, params: Record<string, unknown>) => unknown): CodexRpcPort {
  return {
    async request<T>(method: string, params?: unknown): Promise<T> {
      return read(method, params as Record<string, unknown>) as T;
    },
    async respond() {},
    async respondError() {},
  };
}

test("full history retries only a failed read-only page with a smaller limit", async () => {
  const calls: { cursor: unknown; limit: unknown }[] = [];
  const turns = ["a", "b", "c", "d"].map((id) => ({ id, itemsView: "full", items: [] }));
  const rpc = port((method, params) => {
    assert.equal(method, "thread/turns/list");
    calls.push({ cursor: params.cursor, limit: params.limit });
    if (Number(params.limit) > 3) throw tooLarge();
    const start = params.cursor === undefined ? 0 : Number(params.cursor);
    const data = turns.slice(start, start + Number(params.limit));
    return {
      data,
      nextCursor: start + data.length < turns.length ? String(start + data.length) : null,
    };
  });

  const actual = await paginateNativeRows(
    rpc,
    "thread/turns/list",
    { threadId: "t", itemsView: "full", sortDirection: "asc" },
    "history",
  );
  assert.deepEqual(actual, turns);
  assert.deepEqual(calls.slice(0, 2), [
    { cursor: undefined, limit: 100 },
    { cursor: undefined, limit: 50 },
  ]);
  assert.ok(calls.some(({ limit }) => limit === 3));
  assert.ok(calls.filter(({ cursor }) => cursor === "3").every(({ limit }) => limit === 3));
});

test("a single oversized full turn reads metadata and reconstructs its native items", async () => {
  const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
  const items = [
    { id: "user", type: "userMessage", content: [] },
    { id: "tool", type: "agentMessage", text: "complete" },
  ];
  const rpc = port((method, params) => {
    calls.push({ method, params });
    if (method === "thread/turns/list") {
      if (params.itemsView === "full") throw tooLarge();
      assert.equal(params.itemsView, "notLoaded");
      assert.equal(params.limit, 1);
      return {
        data: [{ id: "turn", status: "completed", itemsView: "notLoaded", items: [] }],
        nextCursor: null,
      };
    }
    assert.equal(method, "thread/items/list");
    assert.equal(params.threadId, "t");
    assert.equal(params.turnId, "turn");
    if (Number(params.limit) > 1) throw tooLarge();
    const index = params.cursor === undefined ? 0 : 1;
    return {
      data: [{ turnId: "turn", item: items[index] }],
      nextCursor: index === 0 ? "item-next" : null,
    };
  });

  const actual = await paginateNativeRows(
    rpc,
    "thread/turns/list",
    { threadId: "t", itemsView: "full", sortDirection: "asc" },
    "history",
  );
  assert.deepEqual(actual, [{ id: "turn", status: "completed", itemsView: "full", items }]);
  assert.equal(calls.filter(({ method }) => method === "thread/items/list").length > 2, true);
});

test("one oversized item remains an explicit LIMIT and never loops or fabricates a turn", async () => {
  let itemCalls = 0;
  const rpc = port((method, params) => {
    if (method === "thread/turns/list") {
      if (params.itemsView === "full") throw tooLarge();
      return {
        data: [{ id: "turn", itemsView: "notLoaded", items: [] }],
        nextCursor: null,
      };
    }
    itemCalls++;
    throw tooLarge();
  });
  await assert.rejects(
    paginateNativeRows(rpc, "thread/turns/list", { threadId: "t", itemsView: "full" }, "history"),
    { code: "LIMIT" },
  );
  assert.ok(itemCalls > 0 && itemCalls < 10);
});

test("oversized multi-item native turn preserves all content while every successful frame fits", async () => {
  const itemText = "x".repeat(17 * 1024 * 1024);
  const items = [
    { id: "first", type: "agentMessage", text: itemText },
    { id: "second", type: "agentMessage", text: itemText },
  ];
  const limitBytes = 32 * 1024 * 1024;
  const calls: Array<{ method: string; limit: number }> = [];
  const rpc = port((method, params) => {
    const limit = Number(params.limit);
    calls.push({ method, limit });
    if (method === "thread/turns/list") {
      if (params.itemsView === "notLoaded")
        return {
          data: [{ id: "turn", itemsView: "notLoaded", items: [] }],
          nextCursor: null,
        };
      // 模拟原生真实的 32 MiB NDJSON 上限：同一 turn 的两个 item 无论怎样缩
      // turns limit 都不能作为一帧读回，不是简单把 100 改为 1 的小页测试。
      assert.ok(Buffer.byteLength(JSON.stringify({ data: [{ id: "turn", items }] })) > limitBytes);
      throw tooLarge();
    }
    assert.equal(method, "thread/items/list");
    if (limit > 1) throw tooLarge();
    const index = params.cursor === undefined ? 0 : 1;
    const page = {
      data: [{ turnId: "turn", item: items[index] }],
      nextCursor: index === 0 ? "next" : null,
    };
    assert.ok(Buffer.byteLength(JSON.stringify(page)) < limitBytes);
    return page;
  });
  const rows = await paginateNativeRows(
    rpc,
    "thread/turns/list",
    { threadId: "thread", itemsView: "full", sortDirection: "asc" },
    "history",
  );
  assert.deepEqual(
    (rows[0] as { items: typeof items }).items.map((item) => item.id),
    ["first", "second"],
  );
  assert.equal((rows[0] as { items: typeof items }).items[1]?.text, itemText);
  assert.equal(calls.at(-1)?.method, "thread/items/list");
  assert.equal(calls.filter(({ method }) => method === "thread/turns/list").length, 8);
});

test("history and item pages with a next cursor must make progress", async () => {
  const stalledHistory = port(() => ({ data: [], nextCursor: "never-progress" }));
  await assert.rejects(
    paginateNativeRows(
      stalledHistory,
      "thread/turns/list",
      { threadId: "t", itemsView: "full" },
      "history",
    ),
    /Empty native history page/,
  );
  const stalledItems = port((method, params) => {
    if (method === "thread/turns/list") {
      if (params.itemsView === "full") throw tooLarge();
      return { data: [{ id: "turn", itemsView: "notLoaded", items: [] }], nextCursor: null };
    }
    return { data: [], nextCursor: "never-progress" };
  });
  await assert.rejects(
    paginateNativeRows(
      stalledItems,
      "thread/turns/list",
      { threadId: "t", itemsView: "full" },
      "history",
    ),
    /Empty native item page/,
  );
});

test("full history hydrates any summary or notLoaded turn returned by thread/turns/list", async () => {
  const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
  const rpc = port((method, params) => {
    calls.push({ method, params });
    if (method === "thread/turns/list") {
      return {
        data: [
          {
            id: "turn-full",
            status: "completed",
            itemsView: "full",
            items: [{ id: "full-item", type: "agentMessage", text: "ok" }],
          },
          {
            id: "turn-summary",
            status: "completed",
            itemsView: "summary",
            items: [],
          },
          {
            id: "turn-not-loaded",
            status: "completed",
            itemsView: "notLoaded",
            items: [],
          },
        ],
        nextCursor: null,
      };
    }
    assert.equal(method, "thread/items/list");
    assert.equal(params.threadId, "t");
    return {
      data: [
        {
          turnId: params.turnId,
          item: {
            id: `hydrated-${String(params.turnId)}`,
            type: "agentMessage",
            text: `text-${String(params.turnId)}`,
          },
        },
      ],
      nextCursor: null,
    };
  });

  const actual = await paginateNativeRows(
    rpc,
    "thread/turns/list",
    { threadId: "t", itemsView: "full", sortDirection: "asc" },
    "history",
  );
  assert.deepEqual(actual, [
    {
      id: "turn-full",
      status: "completed",
      itemsView: "full",
      items: [{ id: "full-item", type: "agentMessage", text: "ok" }],
    },
    {
      id: "turn-summary",
      status: "completed",
      itemsView: "full",
      items: [{ id: "hydrated-turn-summary", type: "agentMessage", text: "text-turn-summary" }],
    },
    {
      id: "turn-not-loaded",
      status: "completed",
      itemsView: "full",
      items: [
        { id: "hydrated-turn-not-loaded", type: "agentMessage", text: "text-turn-not-loaded" },
      ],
    },
  ]);
  assert.deepEqual(
    calls.filter((call) => call.method === "thread/items/list").map((call) => call.params.turnId),
    ["turn-summary", "turn-not-loaded"],
  );
});
