import assert from "node:assert/strict";
import test from "node:test";
import type { TestContext } from "node:test";
import { SessionTitleCoordinator } from "../src/session-title.js";
import type { CodexRpcPort } from "../src/contract.js";

/** 捕获 bridge 的有界标题诊断行；断言只允许出现阶段/原因码，不允许出现用户内容。 */
function captureStderr(t: TestContext): string[] {
  const lines: string[] = [];
  t.mock.method(process.stderr, "write", (chunk: string | Uint8Array) => {
    lines.push(String(chunk));
    return true;
  });
  return lines;
}

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
  f.coordinator.armFirstInput("thread-1", {
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
  slow.armFirstInput("thread-1", { providerId: "custom", modelId: "small" });
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

test("invalid output keeps preview without another model attempt", async (t) => {
  const lines = captureStderr(t);
  const f = fixture();
  f.setConfigured("custom", "small");
  f.setText("This is not a title object");
  f.coordinator.armFirstInput("thread-1", { providerId: "custom", modelId: "small" });
  await f.complete();
  assert.equal(f.thread.name, null);
  assert.equal(f.requested(), 1);
  assert.equal(
    f.calls.some((call) => call.method === "thread/name/set"),
    false,
  );
  assert.deepEqual(lines, [
    "Codex desktop bridge warn: automatic title skipped; stage=generation; reason=invalid-title\n",
  ]);
});

test("auxiliary failure keeps preview and logs only a bounded stage and code", async (t) => {
  const lines: string[] = [];
  t.mock.method(process.stderr, "write", (chunk: string | Uint8Array) => {
    lines.push(String(chunk));
    return true;
  });
  const f = fixture();
  const coordinator = new SessionTitleCoordinator({
    rpc: f.rpc,
    store: { get: () => ({ thread: f.thread }) },
    auxiliary: {
      async handle() {
        throw Object.assign(new Error("secret prompt /workspace user.dotted"), { code: -32600 });
      },
    },
    cwd: "/project",
    workspaceId: "remote:A",
  });
  coordinator.armFirstInput("thread-1", { providerId: "openai", modelId: "gpt-5.6-luna" });
  await coordinator.onNotification({
    method: "item/completed",
    params: {
      threadId: "thread-1",
      item: {
        type: "userMessage",
        id: "item-1",
        content: [{ type: "text", text: "Please investigate the build failure" }],
      },
    },
  });
  assert.equal(f.thread.name, null);
  assert.equal(
    f.calls.some(({ method }) => method === "thread/name/set"),
    false,
  );
  assert.deepEqual(lines, [
    "Codex desktop bridge warn: automatic title failed; stage=generation; code=-32600\n",
  ]);
});

test("an API-key account can use a model listed by native Codex", async () => {
  const f = fixture();
  f.setConfigured("openai", "gpt-5.6-codex");
  f.coordinator.armFirstInput("thread-1", { providerId: "openai", modelId: "gpt-5.6-luna" });
  await f.complete();
  assert.equal(f.requested(), 1);
  assert.equal(
    f.calls.some((call) => call.method === "account/read"),
    false,
  );
});

test("unavailable model skips generation without falling back", async (t) => {
  const lines = captureStderr(t);
  const f = fixture();
  f.setConfigured("openai", "gpt-5.6-codex");
  f.setModels([]);
  f.coordinator.armFirstInput("thread-1", { providerId: "openai", modelId: "gpt-5.6-luna" });
  await f.complete();
  assert.equal(f.requested(), 0);
  assert.equal(f.thread.name, null);
  // 规格禁止回落到其它模型；跳过必须留下原因，否则换 provider 后表现为静默失效。
  assert.deepEqual(lines, [
    "Codex desktop bridge warn: automatic title skipped; stage=availability; reason=unavailable\n",
  ]);
});

test("custom configured model is available even when omitted from model/list", async () => {
  const f = fixture();
  f.setConfigured("custom", "small");
  f.setModels([]);
  f.coordinator.armFirstInput("thread-1", { providerId: "custom", modelId: "small" });
  await f.complete();
  assert.equal(f.requested(), 1);
});

test("a missing provider/model pair cannot use an identically named model in another provider", async () => {
  const f = fixture();
  f.setConfigured("openai", "gpt-5.6-codex");
  f.coordinator.armFirstInput("thread-1", { providerId: "custom", modelId: "gpt-5.6-luna" });
  await f.complete();
  assert.equal(f.requested(), 0);
});

test("a short first input and a child thread do not generate a title", async (t) => {
  const lines = captureStderr(t);
  const f = fixture();
  f.thread.parentThreadId = "parent";
  f.coordinator.armFirstInput("thread-1", { providerId: "custom", modelId: "small" });
  await f.complete();
  assert.equal(f.requested(), 0);
  // 子线程在 arm 阶段就被拒绝，不是跳过，不产生诊断行。
  assert.deepEqual(lines, []);
  const other = fixture();
  other.coordinator.armFirstInput("thread-1", { providerId: "custom", modelId: "small" });
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
  assert.deepEqual(lines, [
    "Codex desktop bridge warn: automatic title skipped; stage=input; reason=short-input\n",
  ]);
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
  coordinator.armFirstInput("thread-1", { providerId: "custom", modelId: "small" });
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

test("a reverted first user item cannot receive its stale generated title", async (t) => {
  const lines = captureStderr(t);
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
  coordinator.armFirstInput("thread-1", { providerId: "custom", modelId: "small" });
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
  assert.deepEqual(lines, [
    "Codex desktop bridge warn: automatic title skipped; stage=native-read; reason=first-item-mismatch\n",
  ]);
});

test("a first input without a title model reports once and never renames later turns", async (t) => {
  const lines = captureStderr(t);
  const f = fixture();
  f.coordinator.armFirstInput("thread-1", undefined);
  f.coordinator.armFirstInput("thread-1", undefined);
  // 缺选择时不能猜测或回落到会话模型；只留一条有界原因，且一个线程最多一条。
  assert.deepEqual(lines, [
    "Codex desktop bridge warn: automatic title skipped; stage=arm; reason=missing-selection\n",
  ]);
  await f.complete();
  assert.equal(f.requested(), 0);
  assert.equal(f.thread.name, null);
  assert.deepEqual(lines, [
    "Codex desktop bridge warn: automatic title skipped; stage=arm; reason=missing-selection\n",
  ]);
  // 后续轮次即使补上选择也不改名（later turns do not rename the session）。
  f.coordinator.armFirstInput("thread-1", { providerId: "custom", modelId: "small" });
  await f.complete();
  assert.equal(f.requested(), 0);
  assert.equal(f.thread.name, null);
});

test("a follow-up input without a title model stays silent", async (t) => {
  const lines = captureStderr(t);
  const f = fixture();
  f.thread.turns = [
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
  ];
  // 线程已有用户消息 = 不是首条输入，普通追问不该刷诊断行。
  f.coordinator.armFirstInput("thread-1", undefined);
  assert.deepEqual(lines, []);

  // 本来就没有命名资格的线程（子线程 / 已命名）也不能报“缺少标题模型”，
  // 否则辅助对话与子代理的每条消息都会刷出假告警。
  const child = fixture();
  child.thread.turns = [];
  child.thread.parentThreadId = "parent";
  child.coordinator.armFirstInput("thread-1", undefined);
  const named = fixture();
  named.thread.name = "Already named";
  named.coordinator.armFirstInput("thread-1", undefined);
  assert.deepEqual(lines, []);
});

test("armFirstInput with a selection arms the first native user item", async (t) => {
  const lines = captureStderr(t);
  const f = fixture();
  f.setConfigured("custom", "small");
  f.coordinator.armFirstInput("thread-1", { providerId: "custom", modelId: "small" });
  await f.complete();
  assert.equal(f.thread.name, "Investigate build failure");
  assert.deepEqual(lines, []);
});
