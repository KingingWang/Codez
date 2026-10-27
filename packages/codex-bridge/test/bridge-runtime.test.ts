import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { codezWorkspaceGenerateTextResultSchema } from "@codez/shared";
import {
  V4_METHODS,
  commandAckSchema,
  v4ConversationSubscribeResultSchema,
  routedTopicWireFrameSchema,
  conversationSnapshotSchema,
  type RoutedTopicWireFrame,
} from "@codez/shared/codez-protocol-v4";
import { BridgeRuntime } from "../src/bridge-runtime.js";
import type { CodexProcess, CodexNotification, CodexServerRequest } from "../src/contract.js";
import { CodexRpcError, CodexTransportError } from "../src/rpc-errors.js";
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
async function fixture(t: TestContext, officialMarketplaceRoot?: string) {
  const root = await mkdtemp(join(tmpdir(), "codez-runtime-qa-"));
  const notifications = new Set<(event: CodexNotification) => void>();
  const requests = new Set<(event: CodexServerRequest) => void>();
  const closes = new Set<(error: Error) => void>();
  const calls: { method: string; params: unknown }[] = [];
  const frames: RoutedTopicWireFrame[] = [],
    order: string[] = [],
    fatal: Error[] = [],
    runtimeNoticeLogs: unknown[] = [];
  const fatalOrigins: (string | undefined)[] = [];
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
    ...(officialMarketplaceRoot ? { officialMarketplaceRoot } : {}),
    async notify(method, params) {
      assert.equal(method, "v4/conversation/frame");
      const frame = routedTopicWireFrameSchema.parse(params);
      frames.push(frame);
      order.push(`frame:${frame.topic}`);
    },
    logRuntimeNotice(notice) {
      runtimeNoticeLogs.push(notice);
    },
    fatal(error, origin) {
      fatal.push(error);
      fatalOrigins.push(origin);
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
    fatal,
    fatalOrigins,
    runtimeNoticeLogs,
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
  assert.equal(codezWorkspaceGenerateTextResultSchema.parse(response.result).text, "fix: QA");
  assert.equal(response.afterResponse, undefined);
  assert.equal(h.calls.filter((call) => call.method === "turn/start").length, 1);
  assert.equal(h.listeners(), 2, "only runtime notification/request listeners remain");
});

test("native project creation uses the primary cwd, full roots and durable origin", async (t) => {
  const h = await fixture(t);
  const response = await h.runtime.request(V4_METHODS.command, {
    ...create("multi-project"),
    payload: {
      workspaceId,
      codexProjectId: "project-ab",
      additionalDirectories: ["/other"],
    },
  });
  assert.equal((response.result as { status: string }).status, "accepted");
  const start = h.calls.find((call) => call.method === "thread/start");
  assert.deepEqual(start?.params, {
    cwd,
    historyMode: "paginated",
    runtimeWorkspaceRoots: [cwd, "/other"],
    threadSource: "codez_project:project-ab",
    model: undefined,
    modelProvider: undefined,
  });
});

test("cold subscribe overrides assigned roots but preserves external persisted native roots", async (t) => {
  const h = await fixture(t);
  await h.runtime.request(V4_METHODS.conversationSubscribe, {
    ...subscribe("conversation/thread-1"),
    additionalDirectories: ["/other"],
  });
  assert.deepEqual(h.calls.find((call) => call.method === "thread/resume")?.params, {
    threadId: "thread-1",
    excludeTurns: true,
    runtimeWorkspaceRoots: [cwd, "/other"],
  });
  await h.runtime.request(V4_METHODS.conversationSubscribe, {
    ...subscribe("conversation/thread-1"),
    additionalDirectories: ["/changed"],
  });
  assert.equal(h.calls.filter((call) => call.method === "thread/resume").length, 1);
  const external = await fixture(t);
  await external.runtime.request(
    V4_METHODS.conversationSubscribe,
    subscribe("conversation/thread-1"),
  );
  assert.deepEqual(external.calls.find((call) => call.method === "thread/resume")?.params, {
    threadId: "thread-1",
    excludeTurns: true,
  });
  const explicit = await fixture(t);
  await explicit.runtime.request("session/resume", {
    sessionId: "thread-1",
    additionalDirectories: ["/other"],
  });
  assert.deepEqual(explicit.calls.find((call) => call.method === "thread/resume")?.params, {
    threadId: "thread-1",
    excludeTurns: true,
    runtimeWorkspaceRoots: [cwd, "/other"],
  });
});

test("synthetic long native history resumes without duplicate turns and retains exact old-page row IDs", async (t) => {
  const h = await fixture(t);
  const base = threadFixture();
  const turns = Array.from({ length: 2600 }, (_, index) => ({
    ...base.turns[0]!,
    id: `turn-${index}`,
    items: base.turns[0]!.items.map((item) => ({
      ...item,
      id: `${item.id}-${index}`,
    })),
  }));
  h.authority.thread = { ...base, turns: [] };
  h.handlers["thread/resume"] = (params) => {
    assert.equal(params.excludeTurns, true);
    return { thread: { ...base, turns: [] } };
  };
  h.handlers["thread/turns/list"] = (params) => {
    const start = params.cursor === undefined ? 0 : Number(params.cursor);
    const data = turns.slice(start, start + Number(params.limit));
    return {
      data,
      nextCursor: start + data.length < turns.length ? String(start + data.length) : null,
    };
  };
  const response = await h.runtime.request(
    V4_METHODS.conversationSubscribe,
    subscribe("conversation/thread-1"),
  );
  await response.afterResponse!();
  const initial = h.frames.find((frame) => frame.topic === "conversation/thread-1");
  const payload = initial?.kind === "complete" ? initial.frame.payload : undefined;
  assert.ok(payload?.kind === "snapshot");
  const initialSnapshot = conversationSnapshotSchema.parse(payload.snapshot);
  assert.ok(initialSnapshot.rows.totalCount >= 10_000);
  assert.equal(initialSnapshot.rows.firstRowId, 0);
  const tailStart = initialSnapshot.rows.window[0]?.rowId;
  assert.ok(tailStart && tailStart > 0);
  assert.equal(h.calls.filter((call) => call.method === "thread/resume").length, 1);
  const older = (await h.runtime.request(V4_METHODS.conversationRowsRange, {
    sessionId: "thread-1",
    beforeRowId: tailStart,
    limit: 50,
  })) as { result: { rows: Array<{ rowId: number }> } };
  assert.equal(older.result.rows.at(-1)?.rowId, tailStart - 1);
  assert.equal(h.calls.filter((call) => call.method === "thread/turns/list").length, 26);
  assert.equal(h.calls.filter((call) => call.method === "thread/resume").length, 1);
});

test("first-input command generates a native title through the isolated auxiliary path", async (t) => {
  const h = await fixture(t);
  h.authority.thread = {
    ...threadFixture(),
    id: "created",
    name: null,
    preview: "Please investigate the build failure",
    turns: [],
  };
  h.handlers["thread/start"] = (params) => ({
    thread: {
      ...h.authority.thread,
      id: params.ephemeral ? "title-aux" : "created",
      ephemeral: !!params.ephemeral,
    },
    cwd,
    model: params.model ?? "fixture-model",
    modelProvider: params.modelProvider ?? "openai",
    approvalPolicy: "never",
    sandbox: { type: "readOnly", networkAccess: false },
  });
  h.handlers["turn/start"] = (params) => {
    if (params.threadId === "title-aux") {
      queueMicrotask(() => {
        h.emit("item/completed", {
          threadId: "title-aux",
          turnId: "title-turn",
          item: {
            id: "title-answer",
            type: "agentMessage",
            text: '{"title":"Investigate build failure"}',
            phase: "final_answer",
          },
        });
        h.emit("turn/completed", {
          threadId: "title-aux",
          turn: { id: "title-turn", status: "completed", items: [] },
        });
      });
      return { turn: { id: "title-turn" } };
    }
    return { turn: { id: "main-turn" } };
  };
  h.handlers["thread/read"] = () => ({ thread: h.authority.thread });
  h.handlers["thread/turns/list"] = () => ({
    data: h.authority.thread.turns,
    nextCursor: null,
  });
  h.handlers["thread/name/set"] = (params) => {
    h.authority.thread.name = params.name as string;
    h.emit("thread/name/updated", {
      threadId: "created",
      threadName: params.name,
    });
    return {};
  };
  const ack = await h.runtime.request(V4_METHODS.command, {
    ...create("title-create"),
    payload: {
      workspaceId,
      titleGenerationModel: { providerId: "openai", modelId: "fixture-model" },
      firstInput: { text: "Please investigate the build failure" },
    },
  });
  assert.equal((ack.result as { status: string }).status, "accepted");
  const user = {
    id: "main-user",
    type: "userMessage",
    content: [{ type: "text", text: "Please investigate the build failure" }],
  };
  h.authority.thread.turns = [
    {
      id: "main-turn",
      itemsView: "full",
      status: "inProgress",
      error: null,
      startedAt: 121,
      completedAt: null,
      items: [user],
    },
  ];
  h.emit("turn/started", {
    threadId: "created",
    turn: { id: "main-turn", status: "inProgress", items: [] },
  });
  h.emit("item/completed", { threadId: "created", turnId: "main-turn", item: user });
  const deadline = Date.now() + 3_000;
  while (h.authority.thread.name === null && Date.now() < deadline) await tick();
  assert.equal(h.authority.thread.name, "Investigate build failure");
  assert.equal(h.calls.filter((call) => call.method === "thread/name/set").length, 1);
  assert.equal(
    h.calls.filter(
      (call) =>
        call.method === "thread/start" &&
        (call.params as { ephemeral?: boolean }).ephemeral === true,
    ).length,
    1,
  );
  const titleTurn = h.calls.find(
    (call) =>
      call.method === "turn/start" &&
      (call.params as { threadId?: string }).threadId === "title-aux",
  );
  assert.ok(titleTurn);
  assert.deepEqual((titleTurn.params as { outputSchema: unknown }).outputSchema, {
    type: "object",
    properties: { title: { type: "string", minLength: 1, maxLength: 36 } },
    required: ["title"],
    additionalProperties: false,
  });
});

test("a first input without a title model reports one bounded skip and never starts generation", async (t) => {
  // 修复依据：此前 `if (payload.titleGenerationModel) arm(...)` 在缺少选择时什么都不做，
  // 手机端/Bot/legacy facade 以及设置读取失败的提交都表现为“自动命名静默失效”，
  // 导出日志里没有任何线索。现在必须留下恰好一条有界原因，且不得猜测模型。
  const lines: string[] = [];
  t.mock.method(process.stderr, "write", (chunk: string | Uint8Array) => {
    lines.push(String(chunk));
    return true;
  });
  const titleLines = () => lines.filter((line) => line.includes("automatic title"));
  const h = await fixture(t);
  h.authority.thread = {
    ...threadFixture(),
    id: "created",
    name: null,
    preview: "Please investigate the build failure",
    turns: [],
  };
  h.handlers["thread/start"] = (params) => ({
    thread: {
      ...h.authority.thread,
      id: params.ephemeral ? "title-aux" : "created",
      ephemeral: !!params.ephemeral,
    },
    cwd,
    model: params.model ?? "fixture-model",
    modelProvider: params.modelProvider ?? "openai",
    approvalPolicy: "never",
    sandbox: { type: "readOnly", networkAccess: false },
  });
  h.handlers["thread/name/set"] = (params) => {
    h.authority.thread.name = params.name as string;
    return {};
  };
  const created = await h.runtime.request(V4_METHODS.command, create("no-title-create"));
  assert.equal(commandAckSchema.parse(created.result).status, "accepted");
  const send = async (commandId: string, text: string, issuedAt: number) => {
    const ack = await h.runtime.request(V4_METHODS.command, {
      type: "sendText",
      commandId,
      clientId: "desktop-1",
      sessionId: "created",
      issuedAt,
      payload: { text },
    });
    assert.equal(commandAckSchema.parse(ack.result).status, "accepted");
  };
  await send("no-title-1", "Please investigate the build failure", 2);
  assert.deepEqual(titleLines(), [
    "Codex desktop bridge warn: automatic title skipped; stage=arm; reason=missing-selection\n",
  ]);
  // 后续轮次既不重复上报，也不能补发标题（later turns do not rename the session）。
  h.authority.thread.turns = [
    {
      id: "main-turn",
      itemsView: "full",
      status: "completed",
      items: [
        {
          type: "userMessage",
          id: "main-user",
          content: [{ type: "text", text: "Please investigate the build failure" }],
        },
      ],
    },
  ];
  await send("no-title-2", "a second substantive message", 3);
  assert.deepEqual(titleLines(), [
    "Codex desktop bridge warn: automatic title skipped; stage=arm; reason=missing-selection\n",
  ]);
  assert.equal(
    h.calls.some(
      (call) =>
        call.method === "thread/start" &&
        (call.params as { ephemeral?: boolean }).ephemeral === true,
    ),
    false,
  );
  assert.equal(h.authority.thread.name, null);
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

test("successful desktop file rewind projection overlay republishes reverted file changes", async (t) => {
  const h = await fixture(t);
  h.authority.thread.turns[0]!.items = [
    ...h.authority.thread.turns[0]!.items,
    {
      type: "fileChange" as const,
      id: "file-change-1",
      status: "completed" as const,
      changes: [
        {
          path: "file.txt",
          diff: "@@ -1,1 +1,1 @@\n-old\n+context",
          kind: { type: "update" as const, move_path: null },
        },
      ],
    },
  ];
  const target = { rowId: 0, entityId: "codex:turn:turn-1" };
  const initial = await h.runtime.request(V4_METHODS.conversationRowsRange, {
    sessionId: "thread-1",
    limit: 1,
  });
  const subscription = await h.runtime.request(
    V4_METHODS.conversationSubscribe,
    subscribe("conversation/thread-1"),
  );
  await subscription.afterResponse?.();
  await tick();
  h.frames.length = 0;
  const before = await h.runtime.request(V4_METHODS.conversationFileChanges, {
    sessionId: "thread-1",
    target,
    baseRevision: (initial.result as { atRevision: number }).atRevision,
    baseLogEpoch: (initial.result as { atLogEpoch: string }).atLogEpoch,
  });
  assert.equal((before.result as { state?: string }).state, "active");
  const overlayPromise = h.runtime.request(V4_METHODS.conversationFileRewindProjectionOverlay, {
    sessionId: "thread-1",
    target,
    turnId: "turn-1",
  });
  await tick();
  assert.deepEqual(
    h.frames.filter((frame) => frame.topic === "conversation/thread-1"),
    [],
  );
  const overlay = await overlayPromise;
  await overlay.afterResponse?.();
  await tick();
  const frames = h.frames.filter((frame) => frame.topic === "conversation/thread-1");
  assert.equal(frames.length, 1);
  const lastFrame = frames.at(-1);
  const payload = lastFrame?.kind === "complete" ? lastFrame.frame.payload : undefined;
  assert.ok(payload?.kind === "snapshot");
  const snapshot = conversationSnapshotSchema.parse(payload.snapshot);
  const header = snapshot.rows.window.find((row) => row.rowId === 0);
  assert.equal(header?.kind, "turnHeader");
  assert.equal(header.fileChanges?.state, "reverted");
  const details = await h.runtime.request(V4_METHODS.conversationFileChanges, {
    sessionId: "thread-1",
    target,
    baseRevision: snapshot.revision,
    baseLogEpoch: snapshot.logEpoch,
  });
  assert.equal((details.result as { state?: string }).state, "reverted");
  await assert.rejects(
    h.runtime.request(V4_METHODS.conversationFileChanges, {
      sessionId: "thread-1",
      target,
      baseRevision: snapshot.revision - 1,
      baseLogEpoch: snapshot.logEpoch,
    }),
    /Conversation changed/,
  );
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

test("runtime notices only log and never enter desktop or mobile conversation frames", async (t) => {
  for (const mode of ["desktop-continuous", "web-remote-replayable"])
    await t.test(mode, async (t) => {
      const h = await fixture(t);
      h.emit("configWarning", {
        summary: "unrecognized configuration",
        details: "session-flags: token_budget is ignored",
        path: "/must-not-enter-logs/config.toml",
      });
      h.emit("modelProvider/authRecoveryStarted", {
        threadId: "thread-1",
        turnId: "turn-1",
        provider: "openai",
        message: "recovering auth",
      });
      h.emit("guardianWarning", { threadId: "another-thread", message: "other thread" });
      h.emit("warning", undefined);
      await tick();
      await tick();
      assert.deepEqual(h.runtimeNoticeLogs, [
        {
          kind: "configWarning",
          message: "unrecognized configuration",
          detail: "session-flags: token_budget is ignored",
        },
        {
          kind: "authRecovery",
          message: "recovering auth",
          threadId: "thread-1",
          turnId: "turn-1",
          provider: "openai",
          phase: "started",
        },
        { kind: "guardianWarning", message: "other thread", threadId: "another-thread" },
      ]);
      assert.equal(h.frames.length, 0);
      const response = await h.runtime.request(
        V4_METHODS.conversationSubscribe,
        subscribe("conversation/thread-1", mode),
      );
      await response.afterResponse!();
      const initial = h.frames.at(-1);
      const initialPayload = initial?.kind === "complete" ? initial.frame.payload : undefined;
      assert.ok(initialPayload?.kind === "snapshot");
      const initialFrameCount = h.frames.length;
      assert.equal("runtimeNotices" in initialPayload.snapshot, false);
      const snapshot = conversationSnapshotSchema.parse(initialPayload.snapshot);
      assert.equal(snapshot.control.lastError, null);
      assert.equal(snapshot.control.apiRetry, null);

      h.emit("warning", { threadId: null, message: "workspace warning" });
      h.emit("modelProvider/authRecoveryCompleted", {
        threadId: "thread-1",
        turnId: "turn-1",
        provider: "openai",
        message: "auth recovered",
      });
      await tick();
      await tick();
      assert.equal(h.runtimeNoticeLogs.length, 5);
      assert.deepEqual(h.runtimeNoticeLogs.at(-2), {
        kind: "warning",
        message: "workspace warning",
      });
      assert.deepEqual(h.runtimeNoticeLogs.at(-1), {
        kind: "authRecovery",
        message: "auth recovered",
        threadId: "thread-1",
        turnId: "turn-1",
        provider: "openai",
        phase: "completed",
      });
      assert.equal(
        h.frames.length,
        initialFrameCount,
        "runtime notices must not publish conversation frames",
      );
      assert.deepEqual(h.fatal, []);
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

test("slow sidebar refresh never delays the next turn on either delivery profile", async (t) => {
  for (const mode of ["desktop-continuous", "web-remote-replayable"])
    await t.test(mode, async (t) => {
      const h = await fixture(t);
      for (const topic of ["conversation/thread-1", `sessions-index/${workspaceId}`]) {
        const response = await h.runtime.request(
          V4_METHODS.conversationSubscribe,
          subscribe(topic, mode),
        );
        await response.afterResponse!();
      }
      const entered = Promise.withResolvers<void>();
      const listing = Promise.withResolvers<unknown>();
      h.handlers["thread/list"] = () => {
        entered.resolve();
        return listing.promise;
      };
      h.emit("turn/completed", {
        threadId: "thread-1",
        turn: { id: "turn-1", status: "completed" },
      });
      await entered.promise;
      try {
        h.emit("turn/started", {
          threadId: "thread-1",
          turn: { id: "turn-2", status: "inProgress", items: [] },
        });
        h.emit("item/completed", {
          threadId: "thread-1",
          turnId: "turn-2",
          item: { id: "second-answer", type: "agentMessage", text: "Second answer" },
        });
        await tick();
        const rows = await h.runtime.request(V4_METHODS.conversationRowsRange, {
          sessionId: "thread-1",
          limit: 100,
        });
        assert.match(JSON.stringify(rows.result), /Second answer/);
        assert.match(JSON.stringify(h.frames), /Second answer/);
      } finally {
        listing.resolve({ data: [h.authority.thread], nextCursor: null });
        await tick();
      }
    });
});

test("close invalidates a pending sidebar refresh without a late frame or fatal", async (t) => {
  const h = await fixture(t);
  const response = await h.runtime.request(
    V4_METHODS.conversationSubscribe,
    subscribe(`sessions-index/${workspaceId}`),
  );
  await response.afterResponse!();
  const entered = Promise.withResolvers<void>();
  const listing = Promise.withResolvers<unknown>();
  h.handlers["thread/list"] = () => {
    entered.resolve();
    return listing.promise;
  };
  h.emit("thread/name/updated", { threadId: "thread-1", threadName: "Updated" });
  await entered.promise;
  const count = h.frames.length;
  await h.close();
  listing.reject(new Error("Transport closed during index read"));
  await tick();
  assert.equal(h.frames.length, count);
});

test("slow configuration invalidation also leaves native turn events unblocked", async (t) => {
  const h = await fixture(t);
  for (const topic of ["conversation/thread-1", `workspace-config/${workspaceId}`]) {
    const response = await h.runtime.request(V4_METHODS.conversationSubscribe, subscribe(topic));
    await response.afterResponse!();
  }
  const entered = Promise.withResolvers<void>();
  const catalog = Promise.withResolvers<unknown>();
  h.handlers["model/list"] = () => {
    entered.resolve();
    return catalog.promise;
  };
  h.emit("account/updated", {});
  await entered.promise;
  try {
    h.emit("turn/started", {
      threadId: "thread-1",
      turn: { id: "turn-after-config", status: "inProgress", items: [] },
    });
    await tick();
    const rows = await h.runtime.request(V4_METHODS.conversationRowsRange, {
      sessionId: "thread-1",
      limit: 100,
    });
    assert.match(JSON.stringify(rows.result), /turn-after-config/);
  } finally {
    catalog.resolve({ data: [], nextCursor: null });
    await tick();
  }
});

test("sidebar invalidations coalesce during a blocked read and publish the latest state", async (t) => {
  const h = await fixture(t);
  const response = await h.runtime.request(
    V4_METHODS.conversationSubscribe,
    subscribe(`sessions-index/${workspaceId}`),
  );
  await response.afterResponse!();
  h.frames.length = 0;
  const entered = Promise.withResolvers<void>();
  const listing = Promise.withResolvers<unknown>();
  let reads = 0;
  h.handlers["thread/list"] = () => {
    reads++;
    if (reads === 1) {
      entered.resolve();
      return listing.promise;
    }
    return { data: [{ ...h.authority.thread, name: "Final sidebar name" }], nextCursor: null };
  };
  h.emit("thread/name/updated", { threadId: "thread-1", threadName: "First" });
  await entered.promise;
  for (let i = 0; i < 5; i++)
    h.emit("thread/name/updated", { threadId: "thread-1", threadName: `Name ${i}` });
  await tick();
  assert.equal(reads, 1);
  listing.resolve({ data: [h.authority.thread], nextCursor: null });
  await tick();
  assert.equal(reads, 2, "one additional read repairs all invalidations during IO");
  assert.equal(h.frames.length, 2);
  assert.match(JSON.stringify(h.frames.at(-1)), /Final sidebar name/);
});

test("first-turn userMessage completion refreshes sessions-index when post-ACK thread/list raced rollout persistence", async (t) => {
  for (const mode of ["desktop-continuous", "web-remote-replayable"])
    await t.test(mode, async (t) => {
      const h = await fixture(t);
      const topic = `sessions-index/${workspaceId}`;
      let persistedVisible = false;
      const createdThread = {
        ...h.authority.thread,
        id: "prewarmed-thread",
        name: null,
        preview: "First remote prompt",
        status: { type: "active", activeFlags: [] },
        turns: [
          {
            id: "turn-first",
            itemsView: "full",
            status: "inProgress",
            error: null,
            startedAt: 1700000100,
            completedAt: null,
            durationMs: null,
            items: [],
          },
        ],
      };
      h.handlers["thread/list"] = () => ({
        data: persistedVisible ? [h.authority.thread, createdThread] : [h.authority.thread],
        nextCursor: null,
      });
      const subscription = await h.runtime.request(
        V4_METHODS.conversationSubscribe,
        subscribe(topic, mode),
      );
      await subscription.afterResponse!();
      h.frames.length = 0;

      // 1. Prewarm draft session: not persisted in thread/list yet.
      h.handlers["thread/start"] = () => ({
        thread: { ...createdThread, status: { type: "idle" }, turns: [] },
        cwd,
        model: "fixture-model",
        modelProvider: "openai",
        approvalPolicy: "never",
        sandbox: { type: "readOnly", networkAccess: false },
      });
      const created = await h.runtime.request(V4_METHODS.command, create("prewarm-1"));
      await created.afterResponse!();
      await tick();
      assert.equal(JSON.stringify(h.frames).includes("prewarmed-thread"), false);
      h.frames.length = 0;

      // 2. First sendText ACK arrives before native rollout becomes visible in thread/list.
      h.handlers["turn/start"] = () => ({
        turn: { id: "turn-first", status: "inProgress", items: [] },
      });
      const sent = await h.runtime.request(V4_METHODS.command, {
        type: "sendText",
        commandId: "send-first-1",
        clientId: "desktop-1",
        sessionId: "prewarmed-thread",
        issuedAt: 2,
        payload: { text: "First remote prompt" },
      });
      assert.equal(commandAckSchema.parse(sent.result).status, "accepted");
      await sent.afterResponse!();
      await tick();
      assert.equal(JSON.stringify(h.frames).includes("prewarmed-thread"), false);

      // 3. Rollout materializes as userMessage item completes while turn is still running.
      persistedVisible = true;
      h.emit("item/completed", {
        threadId: "prewarmed-thread",
        turnId: "turn-first",
        item: {
          id: "user-item-1",
          type: "userMessage",
          content: [{ type: "text", text: "First remote prompt", text_elements: [] }],
        },
      });
      await tick();
      assert.equal(h.fatal.length, 0);
      assert.match(JSON.stringify(h.frames.at(-1)), /prewarmed-thread/);
    });
});

test("explicit project listing discovers external history for all existing index consumers", async (t) => {
  const h = await fixture(t);
  const topic = `sessions-index/${workspaceId}`;
  for (const [connectionId, clientMode] of [
    ["task-index", "desktop-continuous"],
    ["desktop", "desktop-continuous"],
    ["mobile", "web-remote-replayable"],
  ]) {
    const response = await h.runtime.request(V4_METHODS.conversationSubscribe, {
      ...subscribe(topic, clientMode),
      connectionId,
    });
    await response.afterResponse!();
  }
  h.frames.length = 0;
  const listCallsBefore = h.calls.filter((call) => call.method === "thread/list").length;
  h.authority.thread = { ...h.authority.thread, id: "external-cli-thread", name: "External CLI" };
  const response = await h.runtime.request("session/list", { workspace: generate.workspace });
  assert.match(JSON.stringify(response.result), /external-cli-thread/);
  assert.equal(h.frames.length, 0, "discovery response is sent before index invalidation");
  await response.afterResponse?.();
  await tick();
  assert.equal(h.frames.length, 3);
  assert.ok(h.frames.every((frame) => JSON.stringify(frame).includes("external-cli-thread")));
  const listCallsAfter = h.calls.filter((call) => call.method === "thread/list").length;
  assert.equal(
    listCallsAfter - listCallsBefore,
    1,
    "session/list and its post-response sessions-index refresh must share one native thread/list scan",
  );
  assert.equal(
    h.calls.some((call) => call.method === "thread/resume"),
    false,
    "scanning cannot resume external tasks",
  );
  h.frames.length = 0;
  const scoped = await h.runtime.request("session/list", {
    workspace: generate.workspace,
    sessionIds: ["external-cli-thread"],
  });
  await scoped.afterResponse?.();
  await tick();
  assert.equal(h.frames.length, 0, "targeted index repair cannot recursively trigger discovery");
});

test("a live sidebar failure remains fatal with a safe origin and no read retry", async (t) => {
  const h = await fixture(t);
  const response = await h.runtime.request(
    V4_METHODS.conversationSubscribe,
    subscribe(`sessions-index/${workspaceId}`),
  );
  await response.afterResponse!();
  const failure = new Error("Synthetic list failure");
  let reads = 0;
  h.handlers["thread/list"] = () => {
    reads++;
    throw failure;
  };
  h.emit("thread/name/updated", { threadId: "thread-1", threadName: "Updated" });
  await tick();
  assert.deepEqual(h.fatal.splice(0), [failure]);
  assert.deepEqual(h.fatalOrigins, ["sessions-index"]);
  assert.equal(reads, 1);
  await h.close();
  assert.equal(h.closeCount(), 1);
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

test("bridge start warms official marketplace registration from the cached snapshot", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "codez-official-warm-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const pluginsDir = join(root, ".agents", "plugins");
  await mkdir(pluginsDir, { recursive: true });
  await writeFile(
    join(pluginsDir, "marketplace.json"),
    JSON.stringify({ name: "codez-plugins-official", plugins: [] }),
  );
  await writeFile(
    join(pluginsDir, "marketplace.codez.json"),
    JSON.stringify({ catalogUpdatedAt: new Date().toISOString(), plugins: {} }),
  );
  const h = await fixture(t, root);
  // 预热在构造后即异步推进；这里同步补齐处理器，必定早于文件读完成。
  let registered = false;
  h.handlers["plugin/list"] = () => ({
    marketplaces: registered
      ? [
          {
            name: "codez-plugins-official",
            path: join(root, ".agents", "plugins", "marketplace.json"),
            plugins: [],
          },
        ]
      : [],
    marketplaceLoadErrors: [],
  });
  h.handlers["marketplace/add"] = () => {
    registered = true;
    return { marketplaceName: "codez-plugins-official", installedRoot: root, alreadyAdded: false };
  };
  // 预热涉及线程池文件读：事件循环存在 pending setImmediate 时 poll 阶段不会阻塞
  // 等待 I/O，固定 tick 数在慢/高负载 runner 上可能先于文件读完成（CI linux/arm64
  // 实测在此断言失败），因此轮询必须按墙钟截止时间而非固定 tick 数。
  const warmDeadline = Date.now() + 5_000;
  while (!registered && Date.now() < warmDeadline)
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  assert.equal(registered, true);
  assert.deepEqual(h.calls.find((call) => call.method === "marketplace/add")?.params, {
    source: root,
  });
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

for (const clientMode of ["desktop-continuous", "web-remote-replayable"]) {
  test(`${clientMode} publishes failed-turn recovery live and on cold resubscribe`, async (t) => {
    const h = await fixture(t);
    const topic = "conversation/thread-1";
    h.authority.thread.status = { type: "active", activeFlags: [] };
    h.authority.thread.turns[0]!.status = "inProgress";
    const subscribed = await h.runtime.request(
      V4_METHODS.conversationSubscribe,
      subscribe(topic, clientMode),
    );
    await subscribed.afterResponse!();
    h.emit("thread/status/changed", {
      threadId: "thread-1",
      status: { type: "systemError" },
    });
    const error = {
      message: "stream disconnected before completion: E2E_CODEX_STREAM_FAILURE",
    };
    h.emit("turn/completed", {
      threadId: "thread-1",
      turn: {
        id: "turn-1",
        status: "failed",
        error,
        completedAt: 125,
        items: [],
      },
    });
    // publisher 与 native event tail 都是异步的，等待实际终态帧而不是固定超时。
    await t.waitFor(() =>
      assert.match(JSON.stringify(h.frames.at(-1)), /E2E_CODEX_STREAM_FAILURE/),
    );
    const live = JSON.stringify(h.frames.at(-1));
    assert.match(live, /"phase":"error"/);
    assert.match(live, /E2E_CODEX_STREAM_FAILURE/);
    assert.match(live, /"mode":"startNow"/);
    assert.equal(h.calls.filter((call) => call.method === "turn/start").length, 0);
    assert.equal(h.calls.filter((call) => call.method === "thread/revert").length, 0);

    // 模拟已落盘历史：新 Bridge 实例重新 load，不能借 live cache 才恢复输入。
    h.authority.thread.status = { type: "systemError" };
    Object.assign(h.authority.thread.turns[0]!, {
      status: "failed",
      error,
      completedAt: 125,
    });
    const coldRuntime = await fixture(t);
    coldRuntime.authority.thread = structuredClone(h.authority.thread);
    const reopened = await coldRuntime.runtime.request(
      V4_METHODS.conversationSubscribe,
      subscribe(topic, clientMode),
    );
    await reopened.afterResponse!();
    const cold = JSON.stringify(coldRuntime.frames.at(-1));
    assert.match(cold, /"mode":"startNow"/);
    assert.match(cold, /"phase":"error"/);
    assert.match(cold, /E2E_CODEX_STREAM_FAILURE/);
    assert.equal(coldRuntime.calls.filter((call) => call.method === "turn/start").length, 0);
    assert.equal(coldRuntime.calls.filter((call) => call.method === "thread/read").length, 1);
  });
}

test("writer-conflict subscribe degrades to read-only; resync invalidates it and retries resume", async (t) => {
  const h = await fixture(t);
  let conflicted = true;
  const resumes = () => h.calls.filter((call) => call.method === "thread/resume").length;
  h.handlers["thread/resume"] = () => {
    if (conflicted) throw new CodexRpcError(-32600, "thread thread-1 already has an active writer");
    return { thread: h.authority.thread };
  };
  const topic = "conversation/thread-1";
  const subscribed = await h.runtime.request(V4_METHODS.conversationSubscribe, subscribe(topic));
  await subscribed.afterResponse!();
  const initial = JSON.stringify(h.frames.at(-1));
  assert.match(initial, /"writerConflict":\{"readOnly":true\}/);
  assert.match(initial, /guard\.codex\.writerConflict/);
  // 历史仍然投影（不是全屏错误）：fixture 的 assistant 文案在帧里。
  assert.match(initial, /Hello back/);
  // 锁仍占用时重订阅：失效只读条目并重试 resume，仍是只读。
  const resumedBefore = resumes();
  const again = await h.runtime.request(V4_METHODS.conversationSubscribe, subscribe(topic));
  await again.afterResponse!();
  assert.ok(resumes() > resumedBefore, "re-subscribe must retry resume");
  assert.match(JSON.stringify(h.frames.at(-1)), /"writerConflict":\{"readOnly":true\}/);
  // 锁释放后 resync：失效只读条目 → 重载 → resume 成功 → 快照恢复可写。
  // 重订阅已替换路由（旧 subscriptionId 作废），resync 必须用最新 ACK 的身份。
  conflicted = false;
  const latest = v4ConversationSubscribeResultSchema.parse(again.result).ack;
  const resynced = await h.runtime.request(V4_METHODS.conversationResync, {
    subscriptionId: latest.subscriptionId,
    topic,
    connectionId: "desktop-1",
    base: null,
    forceSnapshot: true,
  });
  await resynced.afterResponse!();
  const recovered = JSON.stringify(h.frames.at(-1));
  assert.equal(recovered.includes("writerConflict"), false);
  assert.match(recovered, /Hello back/);
});

for (const clientMode of ["desktop-continuous", "web-remote-replayable"]) {
  test(`${clientMode} reselect refreshes persisted external history while writer conflict remains`, async (t) => {
    const h = await fixture(t);
    h.handlers["thread/resume"] = () => {
      throw new CodexRpcError(-32600, "thread thread-1 already has an active writer");
    };
    const topic = "conversation/thread-1";
    const first = await h.runtime.request(
      V4_METHODS.conversationSubscribe,
      subscribe(topic, clientMode),
    );
    await first.afterResponse!();
    const firstFrame = h.frames.at(-1);
    const firstPayload = firstFrame?.kind === "complete" ? firstFrame.frame.payload : undefined;
    assert.ok(firstPayload?.kind === "snapshot");
    const firstSnapshot = conversationSnapshotSchema.parse(firstPayload.snapshot);
    assert.deepEqual(firstSnapshot.writerConflict, { readOnly: true });

    // 外部 TUI 不向当前 Bridge 连接推送事件；只有再次订阅才读取新落盘历史。
    h.authority.thread = {
      ...h.authority.thread,
      updatedAt: 140,
      turns: [
        ...h.authority.thread.turns,
        {
          id: "turn-from-tui",
          itemsView: "full",
          status: "completed",
          error: null,
          startedAt: 130,
          completedAt: 140,
          durationMs: 10000,
          items: [
            {
              type: "userMessage",
              id: "tui-user",
              content: [{ type: "text", text: "TUI follow-up", text_elements: [] }],
            },
            {
              type: "agentMessage",
              id: "tui-answer",
              text: "TUI persisted answer",
            },
          ],
        },
      ],
    };
    const frameCount = h.frames.length;
    const reads = h.calls.filter((call) => call.method === "thread/turns/list").length;
    const queues = h.calls.filter((call) => call.method === "thread/queue/list").length;
    const cached = await h.runtime.request(V4_METHODS.conversationRowsRange, {
      sessionId: "thread-1",
      limit: 100,
    });
    assert.doesNotMatch(JSON.stringify(cached.result), /TUI persisted answer/);
    assert.equal(h.frames.length, frameCount);

    const refreshed = await h.runtime.request(
      V4_METHODS.conversationSubscribe,
      subscribe(topic, clientMode),
    );
    assert.equal(h.frames.length, frameCount, "replacement snapshot waits for its ACK");
    await refreshed.afterResponse!();
    const refreshFrame = h.frames.at(-1);
    const refreshPayload =
      refreshFrame?.kind === "complete" ? refreshFrame.frame.payload : undefined;
    assert.ok(refreshPayload?.kind === "snapshot");
    const snapshot = conversationSnapshotSchema.parse(refreshPayload.snapshot);
    assert.deepEqual(snapshot.writerConflict, { readOnly: true });
    assert.deepEqual(snapshot.availability.compact, {
      allowed: false,
      reasonCode: "guard.codex.writerConflict",
    });
    assert.deepEqual(
      snapshot.rows.window.slice(0, firstSnapshot.rows.window.length),
      firstSnapshot.rows.window,
    );
    assert.equal(
      snapshot.rows.window.filter(
        (row) => row.entityId === "codex:turn:turn-from-tui:item:tui-answer",
      ).length,
      1,
    );
    assert.equal(h.calls.filter((call) => call.method === "thread/turns/list").length, reads + 1);
    assert.equal(
      h.calls.filter((call) => call.method === "thread/queue/list").length,
      queues,
      "conflicted refresh must not inspect the unverified native queue",
    );
  });
}

test("file rewind overlay injects a one-shot model notice into the next sendText", async (t) => {
  const h = await fixture(t);
  // 一轮已完成的 fileChange（add 全量正文），投影应给出 canRewindFiles 的 turnHeader。
  h.authority.thread.turns.push({
    id: "turn-rewind",
    itemsView: "full",
    status: "completed",
    error: null,
    startedAt: 121,
    completedAt: 130,
    durationMs: 9000,
    items: [
      {
        type: "userMessage",
        id: "user-2",
        content: [{ type: "text", text: "add a file", text_elements: [] }],
      },
      {
        type: "fileChange",
        id: "fc-1",
        status: "completed",
        changes: [
          { path: "/workspace/src/new.ts", diff: "export const a = 1;\n", kind: { type: "add" } },
        ],
      },
    ],
  });
  const range = (await h.runtime.request(V4_METHODS.conversationRowsRange, {
    sessionId: "thread-1",
    limit: 50,
  })) as {
    result: {
      rows: Array<{
        kind: string;
        rowId: number;
        entityId?: string;
        turnId?: string;
        actions?: { canRewindFiles?: boolean };
      }>;
    };
  };
  const header = range.result.rows.find(
    (row) => row.kind === "turnHeader" && row.turnId === "turn-rewind",
  );
  assert.ok(header, "fileChange turn 应投影出 turnHeader 行");
  assert.equal(header.actions?.canRewindFiles, true);

  const overlay = await h.runtime.request(V4_METHODS.conversationFileRewindProjectionOverlay, {
    sessionId: "thread-1",
    target: {
      rowId: header.rowId,
      ...(header.entityId !== undefined ? { entityId: header.entityId } : {}),
    },
    turnId: "turn-rewind",
  });
  await overlay.afterResponse?.();

  // fixture 缺省 turn/start 回包不带 status，投影会把该 turn 判成非法；
  // 这里返回完整运行中 turn，后续快照才能继续投影（现有用例发送后不再投影，未踩到）。
  h.handlers["turn/start"] = () => ({
    turn: {
      id: "live-after-rewind",
      status: "inProgress",
      items: [],
      itemsView: "full",
      startedAt: 131,
      completedAt: null,
      error: null,
    },
  });
  // 第一条发送后线程在跑，第二条走 queue 投递。
  h.handlers["thread/queue/add"] = () => ({
    queuedSubmission: {
      id: "native-added",
      input: [{ type: "text", text: "next", text_elements: [] }],
      clientUserMessageId: "after-rewind-2",
    },
  });

  // 撤销后第一条用户消息：prepend 一次性通知（相对路径 + 行级统计），原文保留在后。
  const sent = await h.runtime.request(V4_METHODS.command, {
    type: "sendText",
    commandId: "after-rewind-1",
    clientId: "desktop-1",
    sessionId: "thread-1",
    issuedAt: 2,
    payload: { text: "continue please" },
  });
  const sentAck = commandAckSchema.parse(sent.result);
  assert.equal(sentAck.status, "accepted", sentAck.message);
  const starts = h.calls.filter((call) => call.method === "turn/start");
  assert.equal(starts.length, 1);
  const input = (starts[0]!.params as { input: Array<{ text: string }> }).input;
  assert.ok(input[0]!.text.startsWith("[User action: file changes reverted]"));
  assert.ok(input[0]!.text.includes("- `src/new.ts` (+1/-0)"));
  assert.ok(input[0]!.text.endsWith("continue please"));

  // 快照投影同轮标记 reverted，且第二条消息不再携带通知。
  const snapshot = (await h.runtime.request(V4_METHODS.conversationRowsRange, {
    sessionId: "thread-1",
    limit: 50,
  })) as {
    result: {
      rows: Array<{ kind: string; turnId?: string; fileChanges?: { state?: string } }>;
    };
  };
  const revertedHeader = snapshot.result.rows.find(
    (row) => row.kind === "turnHeader" && row.turnId === "turn-rewind",
  );
  assert.equal(revertedHeader?.fileChanges?.state, "reverted");

  const second = await h.runtime.request(V4_METHODS.command, {
    type: "sendText",
    commandId: "after-rewind-2",
    clientId: "desktop-1",
    sessionId: "thread-1",
    issuedAt: 3,
    payload: { text: "next" },
  });
  assert.equal(commandAckSchema.parse(second.result).status, "accepted");
  const allStarts = h.calls.filter((call) => call.method === "turn/start");
  assert.equal(allStarts.length, 1);
  const queuedCalls = h.calls.filter((call) => call.method === "thread/queue/add");
  assert.equal(queuedCalls.length, 1);
  const queuedInput = (queuedCalls[0]!.params as { input: Array<{ text: string }> }).input;
  assert.ok(!queuedInput[0]!.text.includes("reverted"));
});

test("v4/sessionsIndex/reconcile reports tombstoned, existing and missing sessions without resuming threads", async (t) => {
  const h = await fixture(t);
  const deletedId = "deleted-thread";
  const unloadedId = "unloaded-thread";
  const foreignId = "foreign-thread";
  h.handlers["thread/read"] = (params) => {
    if (params.threadId === unloadedId) {
      return {
        thread: {
          ...h.authority.thread,
          id: unloadedId,
          name: "Archived title",
          createdAt: 100,
          updatedAt: 200,
          status: { type: "notLoaded" },
          turns: [],
        },
      };
    }
    if (params.threadId === foreignId) {
      return {
        thread: {
          ...h.authority.thread,
          id: foreignId,
          cwd: "/foreign",
          status: { type: "notLoaded" },
          turns: [],
        },
      };
    }
    if (params.threadId === deletedId) {
      return {
        thread: {
          ...h.authority.thread,
          id: deletedId,
          status: { type: "notLoaded" },
          turns: [],
        },
      };
    }
    throw new CodexRpcError(-32600, "thread not loaded");
  };
  h.handlers["thread/delete"] = () => ({});

  const deleteRes = await h.runtime.request(V4_METHODS.command, {
    type: "deleteSession",
    commandId: "del-1",
    clientId: "desktop-1",
    sessionId: deletedId,
    issuedAt: 1,
    payload: {},
  });
  assert.equal(commandAckSchema.parse(deleteRes.result).status, "accepted");

  const reconciled = await h.runtime.request(V4_METHODS.sessionsIndexReconcile, {
    workspaceId,
    sessionIds: [deletedId, unloadedId, foreignId, "missing-thread"],
  });
  assert.deepEqual(reconciled.result, {
    sessions: [
      {
        sessionId: deletedId,
        exists: true,
        deleted: true,
        title: "",
        titleSource: "default",
        createdAt: 0,
        updatedAt: 0,
      },
      {
        sessionId: unloadedId,
        exists: true,
        deleted: false,
        title: "Archived title",
        titleSource: "default",
        createdAt: 100000,
        updatedAt: 200000,
      },
      {
        sessionId: foreignId,
        exists: false,
        deleted: false,
      },
      {
        sessionId: "missing-thread",
        exists: false,
        deleted: false,
      },
    ],
  });
  assert.equal(
    h.calls.filter((call) => call.method === "thread/resume").length,
    0,
    "reconcile and cold deleteSession must not resume unloaded threads",
  );
});

test("reconciliation bounds native reads across simultaneous requests without losing result order", async (t) => {
  const h = await fixture(t);
  let active = 0;
  let peak = 0;
  h.handlers["thread/read"] = async (params) => {
    active += 1;
    peak = Math.max(peak, active);
    await new Promise<void>((resolve) => setTimeout(resolve, 2));
    active -= 1;
    return { thread: { ...h.authority.thread, id: params.threadId } };
  };
  const firstIds = Array.from({ length: 24 }, (_, index) => `first-${index}`);
  const secondIds = Array.from({ length: 24 }, (_, index) => `second-${index}`);
  const results = await Promise.all(
    [firstIds, secondIds].map((sessionIds) =>
      h.runtime.request(V4_METHODS.sessionsIndexReconcile, { workspaceId, sessionIds }),
    ),
  );
  assert.ok(peak > 1);
  assert.ok(peak <= 8, `native thread/read peak=${peak}`);
  for (const [index, result] of results.entries()) {
    assert.deepEqual(
      (result.result as { sessions: Array<{ sessionId: string }> }).sessions.map(
        (session) => session.sessionId,
      ),
      index === 0 ? firstIds : secondIds,
    );
  }
  assert.equal(h.calls.filter((call) => call.method === "thread/read").length, 48);
});

test("native timeout and unknown RPC failures never become missing thread facts", async (t) => {
  const h = await fixture(t);
  for (const error of [
    new CodexTransportError("TIMEOUT", "native request timed out"),
    new CodexRpcError(-32000, "native read unavailable"),
  ]) {
    h.handlers["thread/read"] = () => {
      throw error;
    };
    await assert.rejects(
      h.runtime.request(V4_METHODS.sessionsIndexReconcile, {
        workspaceId,
        sessionIds: ["unavailable-thread"],
      }),
      error,
    );
  }
  h.handlers["thread/read"] = () => {
    throw new CodexRpcError(-32600, "thread not loaded");
  };
  const result = await h.runtime.request(V4_METHODS.sessionsIndexReconcile, {
    workspaceId,
    sessionIds: ["missing-thread"],
  });
  assert.deepEqual(result.result, {
    sessions: [{ sessionId: "missing-thread", exists: false, deleted: false }],
  });
});

for (const clientMode of ["desktop-continuous", "web-remote-replayable"] as const) {
  test(`${clientMode} hydrates non-full turns during subscribe, fileChanges, plans and live turn/completed`, async (t) => {
    const h = await fixture(t);
    const hydratedTurnItems = [
      {
        type: "userMessage",
        id: "summary-user-1",
        content: [{ type: "text", text: "Fix remote projection", text_elements: [] }],
      },
      {
        type: "fileChange",
        id: "summary-fc-1",
        status: "completed",
        changes: [
          {
            path: "/workspace/src/fix.ts",
            diff: "export const fixed = true;\n",
            kind: { type: "add" },
          },
        ],
      },
      {
        type: "agentMessage",
        id: "summary-agent-1",
        text: "Hydrated from thread/items/list",
      },
    ];
    const liveOrphanItems = [
      {
        type: "userMessage",
        id: "orphan-user-1",
        content: [{ type: "text", text: "Follow-up without turn/started", text_elements: [] }],
      },
      {
        type: "agentMessage",
        id: "orphan-agent-1",
        text: "Orphan completed turn hydrated",
      },
    ];
    h.authority.thread = {
      ...h.authority.thread,
      turns: [
        {
          id: "turn-summary-1",
          itemsView: "summary",
          status: "completed",
          error: null,
          startedAt: 121,
          completedAt: 130,
          durationMs: 9000,
          items: [],
        },
      ],
    };
    h.handlers["thread/items/list"] = (params) => {
      const turnId = (params as { turnId?: string }).turnId;
      const items = turnId === "turn-orphan-2" ? liveOrphanItems : hydratedTurnItems;
      return {
        data: items.map((item) => ({ turnId, item })),
        nextCursor: null,
      };
    };

    const topic = "conversation/thread-1";
    const sub = await h.runtime.request(
      V4_METHODS.conversationSubscribe,
      subscribe(topic, clientMode),
    );
    await sub.afterResponse!();
    const initialFrame = h.frames.at(-1);
    const initialPayload =
      initialFrame?.kind === "complete" ? initialFrame.frame.payload : undefined;
    assert.ok(initialPayload?.kind === "snapshot");
    const initialSnapshot = conversationSnapshotSchema.parse(initialPayload.snapshot);
    assert.ok(
      initialSnapshot.rows.window.some(
        (row) =>
          row.kind === "assistantText" && row.text.includes("Hydrated from thread/items/list"),
      ),
    );
    const headerRow = initialSnapshot.rows.window.find(
      (row) => row.kind === "turnHeader" && row.turnId === "turn-summary-1",
    );
    assert.ok(headerRow);

    const fileChanges = await h.runtime.request(V4_METHODS.conversationFileChanges, {
      sessionId: "thread-1",
      baseRevision: initialSnapshot.revision,
      baseLogEpoch: initialSnapshot.logEpoch,
      target: { rowId: headerRow.rowId, entityId: headerRow.entityId },
    });
    assert.equal(
      (fileChanges.result as { items: Array<{ path: string }> }).items[0]?.path,
      "/workspace/src/fix.ts",
    );

    const plans = await h.runtime.request(V4_METHODS.conversationPlans, {
      sessionId: "thread-1",
    });
    assert.equal((plans.result as { atLogEpoch: string }).atLogEpoch, initialSnapshot.logEpoch);

    h.emit("turn/completed", {
      threadId: "thread-1",
      turn: {
        id: "turn-orphan-2",
        itemsView: "summary",
        status: "completed",
        error: null,
        startedAt: 131,
        completedAt: 135,
        durationMs: 4000,
        items: [],
      },
    });
    await tick();
    await tick();
    assert.equal(h.fatal.length, 0);
    const nextFrame = h.frames.at(-1);
    const nextPayload = nextFrame?.kind === "complete" ? nextFrame.frame.payload : undefined;
    assert.ok(nextPayload?.kind === "snapshot");
    const nextSnapshot = conversationSnapshotSchema.parse(nextPayload.snapshot);
    assert.ok(
      nextSnapshot.rows.window.some(
        (row) =>
          row.kind === "assistantText" && row.text.includes("Orphan completed turn hydrated"),
      ),
    );
  });
}
