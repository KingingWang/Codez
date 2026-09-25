import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdtemp, mkdir, writeFile, readFile, access, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { codezWorkspaceGenerateTextResultSchema } from "@codez/shared";
import type { CodexProcess, CodexNotification } from "../src/contract.js";
import { AuxiliaryText } from "../src/auxiliary-text.js";
import { createCodexProcess } from "../src/codex-process.js";

const params = {
  workspace: { workspacePath: "/workspace", workspaceKey: "fixture" },
  selection: {
    providerId: "fixture",
    modelId: "fixture-model",
    options: { reasoningLevel: "low" },
  },
  prompt: "Write a commit subject for this supplied diff",
  querySource: "git-commit",
  operationId: "op-1",
};
const result = {
  thread: { id: "aux-thread", ephemeral: true },
  cwd: "/workspace",
  sandbox: { type: "readOnly", networkAccess: false },
  approvalPolicy: "never",
  model: "fixture-model",
  modelProvider: "fixture",
};
function fixture() {
  const notifications = new Set<(event: CodexNotification) => void>();
  const closes = new Set<(error: Error) => void>();
  const calls: { method: string; params: unknown }[] = [];
  const started = Promise.withResolvers<void>();
  const emit = (method: string, params: unknown) => {
    for (const listener of notifications) listener({ method, params });
  };
  const complete = (threadId = "aux-thread", turnId = "aux-turn", status = "completed") => {
    emit("item/completed", {
      threadId,
      turnId,
      item: {
        type: "agentMessage",
        id: "answer",
        phase: "final_answer",
        text: "fix: preserve ACK ordering",
      },
    });
    emit("turn/completed", { threadId, turn: { id: turnId, status, items: [] } });
  };
  const handlers: Record<string, (p: unknown) => unknown | Promise<unknown>> = {
    "config/read": () => ({
      config: { mcp_servers: { fixture: { command: "must-not-run", required: true } } },
    }),
    "thread/start": () => structuredClone(result),
    "turn/start": () => {
      assert.ok(notifications.size);
      started.resolve();
      return { turn: { id: "aux-turn" } };
    },
    "turn/interrupt": () => ({}),
    "thread/unsubscribe": () => ({ status: "unsubscribed" }),
  };
  const rpc: CodexProcess = {
    async request<T>(method: string, p: unknown): Promise<T> {
      calls.push({ method, params: p });
      assert.ok(handlers[method], method);
      return (await handlers[method]!(p)) as T;
    },
    onNotification(listener) {
      notifications.add(listener);
      return () => notifications.delete(listener);
    },
    onClose(listener) {
      closes.add(listener);
      return () => closes.delete(listener);
    },
    onRequest() {
      return () => {};
    },
    async respond() {},
    async respondError() {},
    async initialize() {},
    async close() {},
  };
  return {
    auxiliary: new AuxiliaryText({ rpc, cwd: "/workspace" }),
    rpc,
    calls,
    handlers,
    notifications,
    closes,
    emit,
    complete,
    started,
  };
}

test("restricted ephemeral request waits for actual completion and disposes listeners", async () => {
  const f = fixture();
  const pending = f.auxiliary.handle("workspace/generateText", params);
  await f.started.promise;
  const start = f.calls.find((call) => call.method === "thread/start")!.params as Record<
    string,
    any
  >;
  assert.equal(start.ephemeral, true);
  assert.equal(start.sandbox, "read-only");
  assert.equal(start.approvalPolicy, "never");
  assert.deepEqual(start.environments, []);
  assert.deepEqual(start.dynamicTools, []);
  assert.deepEqual(start.runtimeWorkspaceRoots, []);
  assert.deepEqual(start.config.mcp_servers, { fixture: { enabled: false } });
  for (const feature of [
    "shell_tool",
    "unified_exec",
    "plugins",
    "apps",
    "browser_use",
    "computer_use",
    "hooks",
    "multi_agent",
    "js_repl",
  ])
    assert.equal(start.config[`features.${feature}`], false);
  let settled = false;
  void pending.then(() => {
    settled = true;
  });
  f.complete("other-thread");
  await Promise.resolve();
  assert.equal(settled, false);
  f.complete();
  const generated = codezWorkspaceGenerateTextResultSchema.parse(await pending);
  assert.equal(generated.text, "fix: preserve ACK ordering");
  assert.deepEqual(generated.selection, params.selection);
  assert.equal(generated.finishReason, "stop");
  assert.equal(f.notifications.size + f.closes.size, 0);
  assert.equal(f.calls.filter((call) => call.method === "thread/unsubscribe").length, 1);
  assert.equal(f.calls.filter((call) => call.method === "turn/interrupt").length, 0);
});

test("completion before turn/start reply is retained, not lost or applied to another turn", async () => {
  const f = fixture();
  f.handlers["turn/start"] = () => {
    f.complete("aux-thread", "other-turn");
    f.complete();
    return { turn: { id: "aux-turn" } };
  };
  const generated = codezWorkspaceGenerateTextResultSchema.parse(
    await f.auxiliary.handle("workspace/generateText", params),
  );
  assert.equal(generated.text, "fix: preserve ACK ordering");
});

test("cancel interrupts exactly the owned thread and turn once", async () => {
  const f = fixture();
  const pending = f.auxiliary.handle("workspace/generateText", params);
  const rejected = assert.rejects(pending, { code: -32800 });
  await f.started.promise;
  await Promise.resolve();
  assert.deepEqual(
    await f.auxiliary.handle("workspace/cancelGenerateText", { operationId: "unknown" }),
    { operationId: "unknown", cancelled: false },
  );
  assert.deepEqual(
    await f.auxiliary.handle("workspace/cancelGenerateText", { operationId: "op-1" }),
    { operationId: "op-1", cancelled: true },
  );
  await rejected;
  assert.deepEqual(
    f.calls.filter((call) => call.method === "turn/interrupt"),
    [{ method: "turn/interrupt", params: { threadId: "aux-thread", turnId: "aux-turn" } }],
  );
  assert.equal(f.notifications.size + f.closes.size, 0);
});

test("cancellation while turn admission is pending interrupts its late exact ID", async () => {
  const f = fixture();
  const gate = Promise.withResolvers<unknown>();
  f.handlers["turn/start"] = () => {
    f.started.resolve();
    return gate.promise;
  };
  const rejected = assert.rejects(f.auxiliary.handle("workspace/generateText", params), {
    code: -32800,
  });
  await f.started.promise;
  await f.auxiliary.handle("workspace/cancelGenerateText", { operationId: "op-1" });
  await rejected;
  gate.resolve({ turn: { id: "late-turn" } });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(f.calls.find((call) => call.method === "turn/interrupt")?.params, {
    threadId: "aux-thread",
    turnId: "late-turn",
  });
});

test("tools, token caps, scope mismatch and duplicate operations fail without extra turns", async () => {
  const f = fixture();
  for (const changed of [
    { tools: [{ name: "exec", inputSchema: {} }] },
    { maxOutputTokens: 100 },
    { messages: [{ role: "tool", content: "x", toolCallId: "call", toolName: "exec" }] },
    { workspace: { ...params.workspace, workspacePath: "/other" } },
  ])
    await assert.rejects(f.auxiliary.handle("workspace/generateText", { ...params, ...changed }));
  assert.equal(f.calls.length, 0);
  const pending = f.auxiliary.handle("workspace/generateText", params);
  await f.started.promise;
  await assert.rejects(f.auxiliary.handle("workspace/generateText", params));
  f.complete();
  await pending;
  assert.equal(f.calls.filter((call) => call.method === "turn/start").length, 1);
});

test("unsafe native sandbox or provider substitution fails before turn/start", async () => {
  for (const changes of [
    { sandbox: { type: "workspaceWrite", networkAccess: false } },
    { sandbox: { type: "readOnly", networkAccess: true } },
    { modelProvider: "wrong" },
    { thread: { id: "aux-thread", ephemeral: false } },
  ]) {
    const f = fixture();
    f.handlers["thread/start"] = () => ({ ...result, ...changes });
    await assert.rejects(f.auxiliary.handle("workspace/generateText", params));
    assert.equal(f.calls.filter((call) => call.method === "turn/start").length, 0);
    assert.equal(f.notifications.size + f.closes.size, 0);
  }
});

test("failed/empty turns, unsafe output, disconnection and shutdown fail closed", async () => {
  for (const failure of ["failed", "empty", "close", "tool", "oversized", "shutdown"]) {
    const f = fixture();
    const pending = f.auxiliary.handle("workspace/generateText", params);
    const rejected = assert.rejects(pending);
    await f.started.promise;
    if (failure === "failed") f.complete("aux-thread", "aux-turn", "failed");
    else if (failure === "empty")
      f.emit("turn/completed", {
        threadId: "aux-thread",
        turn: { id: "aux-turn", status: "completed", items: [] },
      });
    else if (failure === "shutdown") await f.auxiliary.close();
    else if (failure === "tool" || failure === "oversized")
      f.emit("item/completed", {
        threadId: "aux-thread",
        turnId: "aux-turn",
        item: {
          type: failure === "tool" ? "commandExecution" : "agentMessage",
          text: "x".repeat(65_537),
        },
      });
    else for (const listener of f.closes) listener(new Error("process closed"));
    await rejected;
    assert.equal(f.notifications.size + f.closes.size, 0);
  }
});

test("30-second deadline interrupts and never retries a turn", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const f = fixture();
  const pending = f.auxiliary.handle("workspace/generateText", params);
  const rejected = assert.rejects(pending, { code: -32001 });
  await f.started.promise;
  await Promise.resolve();
  t.mock.timers.tick(30_001);
  await rejected;
  assert.equal(f.calls.filter((call) => call.method === "turn/start").length, 1);
  assert.equal(f.calls.filter((call) => call.method === "turn/interrupt").length, 1);
  assert.equal(f.notifications.size + f.closes.size, 0);
});

test("malformed native completion and thread cleanup failure do not retry", async () => {
  for (const failure of ["malformed-turn", "cleanup-failure"] as const) {
    const f = fixture();
    if (failure === "cleanup-failure")
      f.handlers["thread/unsubscribe"] = () => Promise.reject(new Error("cleanup refused"));
    const pending = f.auxiliary.handle("workspace/generateText", params);
    let rejection: Promise<void> | undefined;
    if (failure === "malformed-turn") rejection = assert.rejects(pending, { code: -32000 });
    else void pending.catch(() => {});
    await f.started.promise;
    if (failure === "malformed-turn") {
      f.emit("turn/completed", {
        threadId: "aux-thread",
        turn: { id: "aux-turn" },
      });
      await Promise.resolve();
    } else {
      f.complete();
      const generated = codezWorkspaceGenerateTextResultSchema.parse(await pending);
      assert.equal(generated.text, "fix: preserve ACK ordering");
    }
    if (rejection) await rejection;
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(f.calls.filter((call) => call.method === "turn/start").length, 1);
    assert.equal(
      f.calls.filter((call) => call.method === "thread/unsubscribe").length,
      1,
      "cleanup is attempted exactly once and never retried",
    );
    assert.equal(f.notifications.size + f.closes.size, 0);
  }
});

test(
  "pinned native isolation: no model tools, MCP/notify side effects or persisted thread",
  {
    skip: !process.env.CODEX_AUXILIARY_TEST_BINARY,
    timeout: 60_000,
  },
  async (t) => {
    const temporary = await mkdtemp(join(tmpdir(), "codez-auxiliary-"));
    const cwd = join(temporary, "workspace"),
      codexHome = join(temporary, "codex-home");
    await mkdir(cwd);
    await mkdir(codexHome);
    t.after(() => rm(temporary, { recursive: true, force: true }));
    const modelRequests: Record<string, unknown>[] = [];
    const server = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        modelRequests.push(JSON.parse(Buffer.concat(chunks).toString()));
        const item = {
          type: "message",
          id: "msg-aux",
          role: "assistant",
          status: "completed",
          content: [{ type: "output_text", text: "fix: isolated commit helper", annotations: [] }],
        };
        const completed = {
          id: "resp-aux",
          object: "response",
          status: "completed",
          output: [item],
          usage: { input_tokens: 8, output_tokens: 4, total_tokens: 12 },
        };
        const events = [
          {
            type: "response.created",
            response: { ...completed, status: "in_progress", output: [] },
          },
          {
            type: "response.output_item.added",
            output_index: 0,
            item: { ...item, status: "in_progress", content: [] },
          },
          { type: "response.output_item.done", output_index: 0, item },
          { type: "response.completed", response: completed },
        ];
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.end(
          events
            .map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
            .join(""),
        );
      });
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    t.after(() => {
      server.closeAllConnections();
      server.close();
    });
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const marker = join(temporary, "forbidden-side-effect");
    const command = [
      process.execPath,
      "-e",
      `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'unsafe')`,
    ];
    const config =
      `model_provider = "fixture"\nmodel = "gpt-5.2"\nnotify = ${JSON.stringify(command)}\n` +
      `[model_providers.fixture]\nname = "Isolated fixture"\nbase_url = "http://127.0.0.1:${address.port}/v1"\nwire_api = "responses"\nrequires_openai_auth = false\n` +
      `[mcp_servers.forbidden]\ncommand = ${JSON.stringify(command[0])}\nargs = ${JSON.stringify(command.slice(1))}\nrequired = true\n` +
      `[analytics]\nenabled = false\n`;
    const configPath = join(codexHome, "config.toml");
    await writeFile(configPath, config);
    const env: NodeJS.ProcessEnv = { CODEX_HOME: codexHome };
    for (const key of [
      "PATH",
      "Path",
      "SystemRoot",
      "SYSTEMROOT",
      "WINDIR",
      "COMSPEC",
      "PATHEXT",
      "TEMP",
      "TMP",
      "TMPDIR",
      "LANG",
      "LC_ALL",
    ])
      if (process.env[key]) env[key] = process.env[key];
    const rpc = createCodexProcess({
      executable: process.env.CODEX_AUXILIARY_TEST_BINARY!,
      cwd,
      env,
    });
    const auxiliary = new AuxiliaryText({ rpc, cwd });
    t.after(async () => {
      await auxiliary.close();
      await rpc.close();
    });
    await rpc.initialize();
    const generated = codezWorkspaceGenerateTextResultSchema.parse(
      await auxiliary.handle("workspace/generateText", {
        ...params,
        workspace: { workspacePath: cwd, workspaceKey: cwd },
        selection: { providerId: "fixture", modelId: "gpt-5.2" },
      }),
    );
    assert.equal(generated.text, "fix: isolated commit helper");
    assert.equal(modelRequests.length, 1);
    assert.deepEqual(modelRequests[0]?.tools, []);
    assert.equal(await readFile(configPath, "utf8"), config);
    await assert.rejects(access(marker));
    const listed = await rpc.request<{ data: unknown[] }>("thread/list", { limit: 100 });
    assert.deepEqual(listed.data, []);
  },
);
