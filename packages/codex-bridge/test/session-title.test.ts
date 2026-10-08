import assert from "node:assert/strict";
import test from "node:test";
import { SessionTitleCoordinator } from "../src/session-title.js";
import type { CodexRpcPort } from "../src/contract.js";

function fixture() {
  const calls: { method: string; params: unknown }[] = [];
  const thread = {
    id: "thread-1",
    name: null as string | null,
    parentThreadId: null as string | null,
    forkedFromId: null,
    turns: [] as unknown[],
  };
  let text = '{"title":"Investigate build failure"}';
  let availableModels = ["gpt-5.6-luna"];
  let configured = { model_provider: "openai", model: "gpt-5.6-luna" };
  let requested = 0;
  const rpc = {
    async request(method: string, params: unknown) {
      calls.push({ method, params });
      if (method === "thread/read") return { thread };
      if (method === "thread/turns/list") return { data: thread.turns, nextCursor: null };
      if (method === "thread/name/set") {
        thread.name = (params as { name: string }).name;
        return {};
      }
      if (method === "config/read") return { config: configured };
      if (method === "model/list")
        return { data: availableModels.map((model) => ({ model })), nextCursor: null };
      throw new Error(`Unexpected native method: ${method}`);
    },
  } as CodexRpcPort;
  const auxiliary = {
    async handle() {
      requested++;
      return { text };
    },
  };
  const coordinator = new SessionTitleCoordinator({
    rpc,
    store: { get: () => ({ thread }) },
    auxiliary,
    cwd: "/project",
    workspaceId: "remote:A",
  });
  const user = {
    type: "userMessage",
    id: "item-1",
    content: [{ type: "text", text: "Please investigate the build failure" }],
  };
  function complete() {
    thread.turns = [{ id: "turn-1", items: [user] }];
    return coordinator.onNotification({
      method: "item/completed",
      params: { threadId: "thread-1", turnId: "turn-1", item: user },
    });
  }
  return {
    coordinator,
    rpc,
    thread,
    calls,
    complete,
    setText: (next: string) => (text = next),
    setConfigured: (providerId: string, modelId: string) =>
      (configured = { model_provider: providerId, model: modelId }),
    setModels: (next: string[]) => (availableModels = next),
    requested: () => requested,
  };
}

test("first native user item generates one auxiliary title and persists only native name", async () => {
  const f = fixture();
  f.coordinator.arm("thread-1", {
    providerId: "openai",
    modelId: "gpt-5.6-luna",
  });
  await f.complete();
  await f.complete();
  assert.equal(f.requested(), 1);
  assert.equal(f.thread.name, "Investigate build failure");
  assert.equal(f.calls.filter((call) => call.method === "thread/name/set").length, 1);
  assert.deepEqual(f.thread.turns, [
    {
      id: "turn-1",
      items: [
        {
          type: "userMessage",
          id: "item-1",
          content: [{ type: "text", text: "Please investigate the build failure" }],
        },
      ],
    },
  ]);
});

test("manual rename wins over a late automatic result", async () => {
  const f = fixture();
  f.setConfigured("custom", "small");
  let release!: (value: unknown) => void;
  const result = new Promise<unknown>((resolve) => {
    release = resolve;
  });
  const slow = new SessionTitleCoordinator({
    rpc: f.rpc,
    store: { get: () => ({ thread: f.thread }) },
    auxiliary: { handle: () => result },
    cwd: "/project",
    workspaceId: "remote:A",
  });
  slow.arm("thread-1", { providerId: "custom", modelId: "small" });
  const pending = slow.onNotification({
    method: "item/completed",
    params: {
      threadId: "thread-1",
      turnId: "turn-1",
      item: {
        type: "userMessage",
        id: "item-1",
        content: [{ type: "text", text: "Please investigate the build failure" }],
      },
    },
  });
  await slow.manualRename("thread-1", "My title");
  release({ text: '{"title":"Late title"}' });
  await pending;
  assert.equal(f.thread.name, "My title");
  assert.equal(f.calls.filter((call) => call.method === "thread/name/set").length, 1);
});

test("invalid output keeps preview without another model attempt", async () => {
  const f = fixture();
  f.setConfigured("custom", "small");
  f.setText("This is not a title object");
  f.coordinator.arm("thread-1", { providerId: "custom", modelId: "small" });
  await f.complete();
  assert.equal(f.thread.name, null);
  assert.equal(f.requested(), 1);
  assert.equal(
    f.calls.some((call) => call.method === "thread/name/set"),
    false,
  );
});

test("an API-key account can use a model listed by native Codex", async () => {
  const f = fixture();
  f.setConfigured("openai", "gpt-5.6-codex");
  f.coordinator.arm("thread-1", { providerId: "openai", modelId: "gpt-5.6-luna" });
  await f.complete();
  assert.equal(f.requested(), 1);
  assert.equal(
    f.calls.some((call) => call.method === "account/read"),
    false,
  );
});

test("unavailable model skips generation without falling back", async () => {
  const f = fixture();
  f.setConfigured("openai", "gpt-5.6-codex");
  f.setModels([]);
  f.coordinator.arm("thread-1", { providerId: "openai", modelId: "gpt-5.6-luna" });
  await f.complete();
  assert.equal(f.requested(), 0);
  assert.equal(f.thread.name, null);
});

test("custom configured model is available even when omitted from model/list", async () => {
  const f = fixture();
  f.setConfigured("custom", "small");
  f.setModels([]);
  f.coordinator.arm("thread-1", { providerId: "custom", modelId: "small" });
  await f.complete();
  assert.equal(f.requested(), 1);
});

test("a missing provider/model pair cannot use an identically named model in another provider", async () => {
  const f = fixture();
  f.setConfigured("openai", "gpt-5.6-codex");
  f.coordinator.arm("thread-1", { providerId: "custom", modelId: "gpt-5.6-luna" });
  await f.complete();
  assert.equal(f.requested(), 0);
});

test("a short first input and a child thread do not generate a title", async () => {
  const f = fixture();
  f.thread.parentThreadId = "parent";
  f.coordinator.arm("thread-1", { providerId: "custom", modelId: "small" });
  await f.complete();
  assert.equal(f.requested(), 0);
  const other = fixture();
  other.coordinator.arm("thread-1", { providerId: "custom", modelId: "small" });
  const short = {
    type: "userMessage",
    id: "item-1",
    content: [{ type: "text", text: "hi" }],
  };
  await other.coordinator.onNotification({
    method: "item/completed",
    params: { threadId: "thread-1", turnId: "turn-1", item: short },
  });
  assert.equal(other.requested(), 0);
});

test("external native name update invalidates the generated result", async () => {
  const f = fixture();
  f.setConfigured("custom", "small");
  let release!: (value: unknown) => void;
  const result = new Promise<unknown>((resolve) => {
    release = resolve;
  });
  const coordinator = new SessionTitleCoordinator({
    rpc: f.rpc,
    store: { get: () => ({ thread: f.thread }) },
    auxiliary: { handle: () => result },
    cwd: "/project",
    workspaceId: "remote:A",
  });
  coordinator.arm("thread-1", { providerId: "custom", modelId: "small" });
  const pending = coordinator.onNotification({
    method: "item/completed",
    params: {
      threadId: "thread-1",
      turnId: "turn-1",
      item: {
        type: "userMessage",
        id: "item-1",
        content: [{ type: "text", text: "Please investigate the build failure" }],
      },
    },
  });
  f.thread.name = "External title";
  await coordinator.onNotification({
    method: "thread/name/updated",
    params: { threadId: "thread-1", threadName: "External title" },
  });
  release({ text: '{"title":"Late title"}' });
  await pending;
  assert.equal(f.thread.name, "External title");
  assert.equal(
    f.calls.some((call) => call.method === "thread/name/set"),
    false,
  );
});

test("a reverted first user item cannot receive its stale generated title", async () => {
  const f = fixture();
  f.setConfigured("custom", "small");
  let release!: (value: unknown) => void;
  const result = new Promise<unknown>((resolve) => {
    release = resolve;
  });
  const coordinator = new SessionTitleCoordinator({
    rpc: f.rpc,
    store: { get: () => ({ thread: f.thread }) },
    auxiliary: { handle: () => result },
    cwd: "/project",
    workspaceId: "remote:A",
  });
  coordinator.arm("thread-1", { providerId: "custom", modelId: "small" });
  const pending = coordinator.onNotification({
    method: "item/completed",
    params: {
      threadId: "thread-1",
      turnId: "turn-1",
      item: {
        type: "userMessage",
        id: "item-1",
        content: [{ type: "text", text: "Please investigate the build failure" }],
      },
    },
  });
  f.thread.turns = [{ id: "replacement-turn", items: [{ type: "userMessage", id: "edited" }] }];
  release({ text: '{"title":"Stale original title"}' });
  await pending;
  assert.equal(f.thread.name, null);
  assert.equal(
    f.calls.some((call) => call.method === "thread/name/set"),
    false,
  );
});
