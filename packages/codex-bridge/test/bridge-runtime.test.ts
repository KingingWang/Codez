import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { zcodeWorkspaceGenerateTextResultSchema } from "@zcode/shared";
import {
  V4_METHODS,
  commandAckSchema,
  v4ConversationSubscribeResultSchema,
  routedTopicWireFrameSchema,
  type RoutedTopicWireFrame,
} from "@zcode/shared/zcode-protocol-v4";
import { BridgeRuntime } from "../src/bridge-runtime.js";
import type { CodexProcess, CodexNotification, CodexServerRequest } from "../src/contract.js";
import { CodexRpcError } from "../src/rpc-errors.js";
import { threadFixture } from "./projection-fixtures.test.js";
// Adapter acceptance 4/7/9: runtime → native admission → ACK → post-response initial.
// Scope regressions use fake RPCs; rejection must happen before native execution.
const cwd = "/workspace",
  workspaceId = "identity-A";
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
const generate = {
  workspace: { workspacePath: cwd, workspaceKey: workspaceId, workspaceIdentity: workspaceId },
  selection: { providerId: "openai", modelId: "fixture-model" },
  prompt: "Write a commit subject",
  querySource: "git-commit",
  operationId: "aux-1",
};
const subscribe = (topic: string, clientMode = "desktop-continuous") => ({
  topic,
  clientMode,
  connectionId: "desktop-1",
  workspace: generate.workspace,
});
const create = (id = "create-1", identity = workspaceId) => ({
  type: "createSession",
  commandId: id,
  clientId: "desktop-1",
  sessionId: null,
  issuedAt: 1,
  payload: { workspaceId: identity },
});
async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), "zcode-runtime-qa-"));
  const notifications = new Set<(event: CodexNotification) => void>();
  const requests = new Set<(event: CodexServerRequest) => void>();
  const closes = new Set<(error: Error) => void>();
  const calls: { method: string; params: unknown }[] = [];
  const frames: RoutedTopicWireFrame[] = [],
    order: string[] = [],
    fatal: Error[] = [];
  const started = Promise.withResolvers<void>();
  let closeCount = 0,
    closed = false;
  const authority = { thread: threadFixture() };
  const emit = (method: string, params: unknown) => {
    for (const listener of notifications) listener({ method, params });
  };
  const handlers: Record<string, (params: Record<string, unknown>) => unknown> = {
    "config/read": () => ({ config: { model: "fixture-model", model_provider: "openai" } }),
    "model/list": () => ({ data: [], nextCursor: null }),
    "skills/list": () => ({ data: [{ cwd, skills: [], errors: [] }] }),
    "thread/list": () => ({ data: [authority.thread], nextCursor: null }),
    "thread/read": () => ({ thread: authority.thread }),
    "thread/resume": () => ({ thread: authority.thread }),
    "thread/turns/list": () => ({ data: authority.thread.turns, nextCursor: null }),
    "thread/queue/list": () => ({ data: [], nextCursor: null }),
    "thread/start": (p) => ({
      thread: {
        ...authority.thread,
        id: p.ephemeral ? "aux-thread" : "created",
        ephemeral: !!p.ephemeral,
      },
      cwd,
      model: "fixture-model",
      modelProvider: "openai",
      approvalPolicy: "never",
      sandbox: { type: "readOnly", networkAccess: false },
    }),
    "turn/start": () => {
      started.resolve();
      return { turn: { id: "aux-turn" } };
    },
    "turn/interrupt": () => ({}),
    "thread/unsubscribe": () => ({ status: "unsubscribed" }),
  };
  const rpc: CodexProcess = {
    async request<T>(method: string, params?: unknown): Promise<T> {
      calls.push({ method, params });
      assert.ok(handlers[method], `Unexpected native RPC: ${method}`);
      return (await handlers[method]!(params as Record<string, unknown>)) as T;
    },
    onNotification(fn) {
      notifications.add(fn);
      return () => notifications.delete(fn);
    },
    onRequest(fn) {
      requests.add(fn);
      return () => requests.delete(fn);
    },
    onClose(fn) {
      closes.add(fn);
      return () => closes.delete(fn);
    },
    async initialize() {},
    async respond() {},
    async respondError() {},
    async close() {
      closeCount++;
    },
  };
  const runtime = new BridgeRuntime({
    rpc,
    cwd,
    workspaceId,
    stateRoot: root,
    async notify(method, params) {
      assert.equal(method, "v4/conversation/frame");
      const frame = routedTopicWireFrameSchema.parse(params);
      frames.push(frame);
      order.push(`frame:${frame.topic}`);
    },
    fatal(error) {
      fatal.push(error);
    },
  });
  const close = async () => {
    if (!closed) {
      closed = true;
      await runtime.close();
    }
  };
  t.after(async () => {
    await close();
    await tick();
    await rm(root, { recursive: true, force: true });
    assert.deepEqual(fatal, []);
  });
  return {
    runtime,
    calls,
    handlers,
    frames,
    order,
    started,
    authority,
    emit,
    close,
    listeners: () => notifications.size + requests.size + closes.size,
    closeCount: () => closeCount,
  };
}

test("auxiliary dispatch precedes legacy unsupported control route and waits for completion", async (t) => {
  const h = await fixture(t);
  const pending = h.runtime.request("workspace/generateText", generate);
  await h.started.promise;
  let settled = false;
  void pending.then(() => {
    settled = true;
  });
  h.emit("item/completed", {
    threadId: "aux-thread",
    turnId: "aux-turn",
    item: { type: "agentMessage", id: "text", text: "fix: QA", phase: "final_answer" },
  });
  await tick();
  assert.equal(settled, false);
  h.emit("turn/completed", {
    threadId: "aux-thread",
    turn: { id: "aux-turn", status: "completed" },
  });
  const response = await pending;
  assert.equal(zcodeWorkspaceGenerateTextResultSchema.parse(response.result).text, "fix: QA");
  assert.equal(response.afterResponse, undefined);
  assert.equal(h.calls.filter((call) => call.method === "turn/start").length, 1);
  assert.equal(h.listeners(), 2, "only runtime notification/request listeners remain");
});

test("runtime cancellation and close abort auxiliary work, interrupt exact turn and remove listeners", async (t) => {
  for (const action of ["cancel", "close"])
    await t.test(action, async (t) => {
      const h = await fixture(t);
      const rejected = assert.rejects(h.runtime.request("workspace/generateText", generate), {
        code: -32800,
      });
      await h.started.promise;
      await tick();
      if (action === "cancel")
        assert.deepEqual(
          (await h.runtime.request("workspace/cancelGenerateText", { operationId: "aux-1" }))
            .result,
          { operationId: "aux-1", cancelled: true },
        );
      await h.close();
      await rejected;
      assert.deepEqual(
        h.calls.filter((call) => call.method === "turn/interrupt"),
        [{ method: "turn/interrupt", params: { threadId: "aux-thread", turnId: "aux-turn" } }],
      );
      assert.equal(h.listeners(), 0);
      assert.equal(h.closeCount(), 1);
      await assert.rejects(h.runtime.request("workspace/generateText", generate), { code: -32004 });
    });
});

test("all V4 subscription topics and both profiles defer initial frames until ACK write callback", async (t) => {
  for (const mode of ["desktop-continuous", "web-remote-replayable"])
    for (const topic of [
      "conversation/thread-1",
      `sessions-index/${workspaceId}`,
      `workspace-config/${workspaceId}`,
    ])
      await t.test(`${mode}:${topic}`, async (t) => {
        const h = await fixture(t);
        const response = await h.runtime.request(
          V4_METHODS.conversationSubscribe,
          subscribe(topic, mode),
        );
        const result = v4ConversationSubscribeResultSchema.parse(response.result);
        assert.deepEqual(Object.keys(response.result as object), ["ack"]);
        assert.equal(result.ack.mode, "snapshot");
        assert.equal(h.frames.length, 0);
        h.order.push("ack-written");
        await response.afterResponse!();
        assert.deepEqual(h.order.slice(0, 2), ["ack-written", `frame:${topic}`]);
        assert.equal(h.frames[0]?.deliveryKind, "initial");
        assert.equal(h.frames[0]?.subscriptionId, result.ack.subscriptionId);
        const count = h.frames.length;
        await response.afterResponse!();
        assert.equal(h.frames.length, count);
      });
});

test("V4 mutation ACK waits for native admission; index refresh is post-response; duplicates never replay", async (t) => {
  const h = await fixture(t);
  const subscription = await h.runtime.request(
    V4_METHODS.conversationSubscribe,
    subscribe(`sessions-index/${workspaceId}`),
  );
  await subscription.afterResponse!();
  h.frames.length = 0;
  h.order.length = 0;
  const entered = Promise.withResolvers<void>(),
    native = Promise.withResolvers<unknown>();
  h.handlers["thread/start"] = () => {
    entered.resolve();
    return native.promise;
  };
  const pending = h.runtime.request(V4_METHODS.command, create());
  let acknowledged = false;
  void pending.then(() => {
    acknowledged = true;
  });
  await entered.promise;
  await tick();
  assert.equal(acknowledged, false);
  assert.equal(h.frames.length, 0);
  native.resolve({ thread: { ...h.authority.thread, id: "created" } });
  const response = await pending;
  assert.equal(commandAckSchema.parse(response.result).status, "accepted");
  assert.equal(h.frames.length, 0);
  h.order.push("mutation-ack-written");
  await response.afterResponse!();
  assert.deepEqual(h.order, ["mutation-ack-written", `frame:sessions-index/${workspaceId}`]);
  assert.equal(
    JSON.stringify((await h.runtime.request(V4_METHODS.command, create())).result),
    JSON.stringify(response.result),
  );
  assert.equal(h.calls.filter((call) => call.method === "thread/start").length, 1);
  h.handlers["thread/start"] = () => {
    throw new CodexRpcError(-32001, "native refused");
  };
  const failed = await h.runtime.request(V4_METHODS.command, create("failed"));
  assert.equal(commandAckSchema.parse(failed.result).status, "failed");
  await h.runtime.request(V4_METHODS.command, create("failed"));
  assert.equal(h.calls.filter((call) => call.method === "thread/start").length, 2);
});

test("read-only codex/request methods forward once; execution and unknown RPCs never escape allowlist", async (t) => {
  const h = await fixture(t);
  for (const method of [
    "account/read",
    "model/list",
    "config/read",
    "configRequirements/read",
    "skills/list",
    "mcpServerStatus/list",
    "plugin/list",
    "plugin/read",
  ]) {
    const result = { native: method };
    h.handlers[method] = () => result;
    assert.deepEqual(
      (await h.runtime.request("codex/request", { method, params: {} })).result,
      result,
    );
  }
  const count = h.calls.length;
  for (const method of [
    "thread/start",
    "thread/read",
    "turn/start",
    "command/exec",
    "fs/readFile",
    "unknown/mutation",
  ])
    await assert.rejects(h.runtime.request("codex/request", { method, params: { cwd: "/other" } }));
  await assert.rejects(
    h.runtime.request("codex/request", { method: "config/read", id: "injected" }),
  );
  assert.equal(h.calls.length, count);
});

test("codex/request preserves native error code/message without retries", async (t) => {
  const h = await fixture(t),
    native = new CodexRpcError(-32001, "fixture version conflict");
  h.handlers["config/read"] = () => {
    throw native;
  };
  await assert.rejects(
    h.runtime.request("codex/request", { method: "config/read" }),
    (error) => error === native,
  );
  assert.equal(h.calls.length, 1);
});

test("cross-workspace topics, identities and native thread cwd are rejected before resume/mutation", async (t) => {
  const h = await fixture(t);
  await assert.rejects(
    h.runtime.request(V4_METHODS.conversationSubscribe, subscribe("sessions-index/identity-B")),
  );
  await assert.rejects(
    h.runtime.request(V4_METHODS.conversationSubscribe, {
      ...subscribe("conversation/thread-1"),
      workspace: { ...generate.workspace, workspaceIdentity: "identity-B" },
    }),
  );
  assert.equal(h.calls.length, 0);
  h.authority.thread.cwd = "/other";
  await assert.rejects(
    h.runtime.request(V4_METHODS.conversationSubscribe, subscribe("conversation/thread-1")),
    /different workspace/,
  );
  const response = await h.runtime.request(V4_METHODS.command, {
    type: "renameSession",
    commandId: "rename",
    clientId: "desktop-1",
    sessionId: "thread-1",
    issuedAt: 1,
    payload: { title: "must not rename" },
  });
  assert.equal(commandAckSchema.parse(response.result).status, "failed");
  assert.ok(h.calls.every((call) => call.method === "thread/read"));
  assert.equal(h.frames.length, 0);
});
test("allowlisted reads cannot escape bridge cwd or select an unadvertised marketplace", async (t) => {
  const h = await fixture(t);
  h.handlers["plugin/list"] = () => ({ marketplaces: [] });
  for (const [method, params] of [
    ["config/read", { cwd: "/other/private-project", includeLayers: true }],
    ["skills/list", { cwds: ["/other/private-project"] }],
    ["plugin/read", { marketplacePath: "/other/private-marketplace", pluginName: "private" }],
  ] as const) {
    h.handlers[method] = (received) => ({ received });
    await assert.rejects(h.runtime.request("codex/request", { method, params }), /scope mismatch/);
    assert.equal(
      h.calls.some((call) => call.method === method),
      false,
    );
  }
});
test("path-only create fallback is retained but explicit foreign identity is rejected", async (t) => {
  const h = await fixture(t);
  assert.equal(
    commandAckSchema.parse(
      (await h.runtime.request(V4_METHODS.command, create("foreign", "identity-B"))).result,
    ).status,
    "failed",
  );
  assert.equal(
    commandAckSchema.parse(
      (await h.runtime.request(V4_METHODS.command, create("path-fallback", cwd))).result,
    ).status,
    "accepted",
  );
  const pending = h.runtime.request("workspace/generateText", {
    ...generate,
    workspace: {
      ...generate.workspace,
      workspaceKey: "identity-B",
      workspaceIdentity: "identity-B",
    },
  });
  await assert.rejects(pending, { code: -32602 });
  assert.equal(h.calls.filter((call) => call.method === "turn/start").length, 0);
});
