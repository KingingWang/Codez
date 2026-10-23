import assert from "node:assert/strict";
import { once } from "node:events";
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { test, type TestContext } from "node:test";
import { createCodexProcess } from "../src/codex-process.js";
import type {
  CodexProcess,
  CodexNotification,
  CodexServerRequest,
  CodexProcessOptions,
} from "../src/contract.js";
import type { DesktopCodexMcpServer } from "@codez/shared";

const options = { timeout: 10_000, skip: process.platform === "win32" };
async function fixture(
  t: TestContext,
  mode = "normal",
  requestTimeoutMs = 1000,
  interactionTimeoutMs?: number,
  updatePlanToolEnabled = false,
  traceArgv = false,
  desktopMcpServers?: DesktopCodexMcpServer[],
  onRequestTimeout?: (info: { method: string; durationMs: number; pendingCount: number }) => void,
  onFrameDropped?: CodexProcessOptions["onFrameDropped"],
  onStderrSummary?: CodexProcessOptions["onStderrSummary"],
) {
  const directory = await mkdtemp(join(tmpdir(), "codez transport 中文 "));
  const executable = join(directory, "fake codex");
  const trace = join(directory, "trace");
  await copyFile(new URL("./fixtures/fake-codex.mjs", import.meta.url), executable);
  await chmod(executable, 0o700);
  const process = createCodexProcess({
    executable,
    cwd: directory,
    requestTimeoutMs,
    interactionTimeoutMs,
    updatePlanToolEnabled,
    desktopMcpServers,
    onRequestTimeout,
    onFrameDropped,
    onStderrSummary,
    env: {
      PATH: globalThis.process.env.PATH,
      HOME: directory,
      CODEX_HOME: directory,
      FAKE_CODEX_MODE: mode,
      FAKE_CODEX_TRACE: trace,
      ...(traceArgv ? { FAKE_CODEX_TRACE_ARGV: "1" } : {}),
    },
  });
  t.after(async () => {
    await process.close();
    await rm(directory, { recursive: true, force: true });
  });
  return { process, trace };
}
const closed = (process: CodexProcess) => new Promise<Error>((resolve) => process.onClose(resolve));
test("native resolved-request notifications revoke pending reply authority", options, async (t) => {
  const { process } = await fixture(t);
  process.onRequest(() => {});
  await process.initialize();
  await process.request("events");
  await process.request("resolve-approval");
  await assert.rejects(process.respond("approval-1", { decision: "accept" }), /stale/);
  await process.respond(42, { answers: {} });
});
function nextNotification(process: CodexProcess): Promise<CodexNotification> {
  return new Promise((resolve) => {
    const remove = process.onNotification((event) => {
      remove();
      resolve(event);
    });
  });
}

test(
  "native argv, isolated home, handshake order and concurrent initialize once",
  options,
  async (t) => {
    const { process } = await fixture(t);
    await assert.rejects(process.request("status"), /initializ/i);
    const first = process.initialize();
    await assert.rejects(process.request("status"), /initializ/i);
    await Promise.all([first, process.initialize(), process.initialize()]);
    await process.initialize();
    assert.equal((await process.request<{ initializeCount: number }>("status")).initializeCount, 1);
    await assert.rejects(process.request("initialize"), /reserved|handshake/i);
    await assert.rejects(process.request("initialized"), /reserved|handshake/i);
  },
);

test(
  "correlates concurrent responses, split UTF-8 and duplicate/unknown replies",
  options,
  async (t) => {
    const { process } = await fixture(t);
    await process.initialize();
    const slow = process.request("echo", { value: "slow", delay: 30 });
    const fast = process.request("echo", { value: "fast" });
    assert.deepEqual(await fast, { value: "fast" });
    assert.deepEqual(await slow, { value: "slow", delay: 30 });
    assert.equal(await process.request("utf8"), "你好🙂 café");
    assert.equal(await process.request("unknown-id"), "ok");
    assert.equal(await process.request("echo", null), null);
  },
);

test("RPC errors reject only their request and preserve the error code", options, async (t) => {
  const { process } = await fixture(t);
  await process.initialize();
  await assert.rejects(process.request("error"), { code: -32602, message: "invalid params" });
  assert.equal(await process.request("echo", "alive"), "alive");
});

test(
  "notifications, server requests, unsubscribe, and exactly one reply per ID",
  options,
  async (t) => {
    const { process } = await fixture(t);
    await process.initialize();
    const events: CodexNotification[] = [];
    const requests: CodexServerRequest[] = [];
    const remove = process.onNotification((event) => events.push(event));
    const removeRequest = process.onRequest((event) => requests.push(event));
    await process.request("events");
    assert.equal(events[0]?.method, "item/delta");
    assert.deepEqual(
      requests.map((request) => request.id),
      ["approval-1", 42],
    );
    remove();
    let received = nextNotification(process);
    await process.respond("approval-1", { decision: "decline" });
    assert.deepEqual((await received).params, {
      id: "approval-1",
      result: { decision: "decline" },
    });
    received = nextNotification(process);
    await process.respondError(42, { code: -32601, message: "Unsupported" });
    assert.deepEqual((await received).params, {
      id: 42,
      error: { code: -32601, message: "Unsupported" },
    });
    assert.equal(events.length, 1);
    await assert.rejects(process.respond("approval-1", {}), /pending|stale/i);
    await assert.rejects(process.respond(999, {}), /pending|stale/i);
    removeRequest();
    await process.request("events");
    assert.equal(requests.length, 2);
  },
);

test("unhandled server requests fail closed", options, async (t) => {
  const { process } = await fixture(t);
  await process.initialize();
  await process.request("events");
  const status = await process.request<{ replies: { error: { code: number } }[] }>("status");
  assert.deepEqual(
    status.replies.map((reply) => reply.error.code),
    [-32601, -32601],
  );
});

test("server request expiry prevents late approval", options, async (t) => {
  const { process } = await fixture(t, "normal", 1000, 100);
  await process.initialize();
  process.onRequest(() => {});
  await process.request("events");
  await delay(160);
  await assert.rejects(process.respond("approval-1", {}), /pending|stale/i);
  assert.equal((await process.request<{ replies: unknown[] }>("status")).replies.length, 2);
});

test(
  "human interactions outlive the RPC timeout by default; close invalidates unanswered requests",
  options,
  async (t) => {
    const { process } = await fixture(t, "normal", 5000);
    await process.initialize();
    // 全套并发时子进程启动可能超过 100ms；握手留真实预算，期限语义由虚拟时钟验证。
    t.mock.timers.enable({ apis: ["setTimeout"] });
    process.onRequest(() => {});
    await process.request("events");
    const timeout = assert.rejects(process.request("hang"), /timed out/i);
    // 等待真实管道写完再推进虚拟时间，避免把背压写入期限误当成 RPC 等待期限。
    await process.request("status");
    t.mock.timers.tick(5001);
    await timeout;
    t.mock.timers.reset();
    assert.deepEqual((await process.request<{ replies: unknown[] }>("status")).replies, []);
    const received = nextNotification(process);
    await process.respond("approval-1", { decision: "accept" });
    assert.deepEqual((await received).params, { id: "approval-1", result: { decision: "accept" } });
    await process.close();
    await assert.rejects(process.respond(42, { answers: {} }), /closed/i);
  },
);

test("invalid explicit interaction deadlines reject before spawning", () => {
  for (const interactionTimeoutMs of [0, -1, NaN, Infinity, 1.5, 2_147_483_648]) {
    assert.throws(
      () =>
        createCodexProcess({
          executable: "/nonexistent/codez-codex-test",
          cwd: tmpdir(),
          interactionTimeoutMs,
        }),
      /interaction timeout/i,
    );
  }
});

test(
  "timeout never retries mutations; late replies cannot settle newer requests",
  options,
  async (t) => {
    // macOS CI 冷启动可能超过 100ms；握手用常规预算，迟到响应由显式 barrier 控制。
    const timeouts: Array<{ method: string; durationMs: number; pendingCount: number }> = [];
    const { process } = await fixture(
      t,
      "normal",
      1000,
      undefined,
      false,
      false,
      undefined,
      (info) => timeouts.push(info),
    );
    await process.initialize();
    await assert.rejects(process.request("mutate"), /timed out/i);
    assert.deepEqual(timeouts, [{ method: "mutate", durationMs: 1000, pendingCount: 0 }]);
    await process.request("release-mutation");
    const status = await process.request<{ mutationCount: number }>("status");
    assert.equal(status.mutationCount, 1);
    assert.equal(await process.request("echo", "after timeout"), "after timeout");
  },
);

for (const mode of ["handshake-timeout", "handshake-error"]) {
  test(`${mode} is terminal and never retries initialize`, options, async (t) => {
    // 并行跑大量原生单测时，Node 子进程冷启动 + 500ms EOF 优雅关闭窗口不能小于 100ms RPC 超时，
    // 否则 fake-codex 尚未完成模块加载就被 SIGTERM 终止，无法写出 EOF trace。
    const { process, trace } = await fixture(t, mode, 300);
    await assert.rejects(process.initialize());
    await assert.rejects(process.initialize());
    await assert.rejects(process.request("status"));
    await process.close();
    assert.match(await readFile(trace, "utf8"), /EOF/);
  });
}

const invalidFrames = [
  "SECRET_FRAME\n",
  "[]\n",
  "null\n",
  '{"id":null,"result":1}\n',
  '{"id":1,"result":1,"error":{"code":1,"message":"bad"}}\n',
  '{"id":1,"error":{"code":"bad","message":"bad"}}\n',
  '{"method":false}\n',
  '{"method":"event","result":1}\n',
  '{"id":1}\n',
  '{"jsonrpc":"1.0","method":"event"}\n',
];
for (const text of invalidFrames) {
  test(
    `invalid frame fails closed without exposing payload: ${invalidFrames.indexOf(text)}`,
    options,
    async (t) => {
      // macOS CI 冷启动波动曾让 1s 的默认 RPC 期限先于畸形帧到达；
      // 此处检验的是协议 fail-closed，不是超时语义，给子进程独立的真实启动预算。
      const { process } = await fixture(t, "normal", 4000);
      await process.initialize();
      const didClose = closed(process);
      const pending = assert.rejects(process.request("hang"), /frame|protocol/i);
      await assert.rejects(process.request("raw", { text }), /frame|protocol/i);
      await pending;
      const error = await didClose;
      assert.doesNotMatch(error.message, /SECRET/);
    },
  );
}

test(
  "oversized response fails only its request and allows later traffic",
  { ...options, timeout: 30_000 },
  async (t) => {
    // macOS Intel CI 生成并输送 33 MiB 帧可能超过默认的 1s 测试期限；
    // 此测试只验证丢帧归因与连接恢复，不能让超时抢先于 LIMIT。
    const dropped: Parameters<NonNullable<CodexProcessOptions["onFrameDropped"]>>[0][] = [];
    const { process } = await fixture(
      t,
      "normal",
      20_000,
      undefined,
      false,
      false,
      undefined,
      undefined,
      (frame) => dropped.push(frame),
    );
    await process.initialize();
    await assert.rejects(process.request("oversized"), { code: "LIMIT" });
    assert.equal(dropped.length, 1);
    assert.deepEqual(
      { kind: dropped[0]?.kind, method: dropped[0]?.method },
      { kind: "response", method: "oversized" },
    );
    assert.ok((dropped[0]?.observedBytes ?? 0) > 32 * 1024 * 1024);
    assert.equal("prefix" in dropped[0]!, false);
    assert.equal(await process.request("echo", "alive"), "alive");
    assert.equal((await process.request<string>("large-valid")).length, 9 * 1024 * 1024);
  },
);

for (const method of ["truncated", "invalid-utf8", "duplicate-server-id"]) {
  test(`${method} terminates the connection`, options, async (t) => {
    const { process } = await fixture(t);
    await process.initialize();
    process.onRequest(() => {});
    await assert.rejects(process.request(method), /frame|protocol/i);
  });
}

test("process death rejects every pending request and emits close once", options, async (t) => {
  const { process } = await fixture(t);
  await process.initialize();
  let closes = 0;
  process.onClose(() => {
    closes++;
  });
  const didClose = closed(process);
  const pending = assert.rejects(process.request("hang"));
  await assert.rejects(process.request("die"));
  await pending;
  assert.doesNotMatch((await didClose).message, /SECRET/);
  await process.close();
  await process.close();
  assert.equal(closes, 1);
  await assert.rejects(process.respond(42, {}), /closed/i);
});

test("native stderr produces one bounded summary without raw text", options, async (t) => {
  const summaries: CodexProcessOptions["onStderrSummary"] extends undefined
    ? never
    : Parameters<NonNullable<CodexProcessOptions["onStderrSummary"]>>[0][] = [];
  const { process } = await fixture(
    t,
    "normal",
    4000,
    undefined,
    false,
    false,
    undefined,
    undefined,
    undefined,
    (summary) => summaries.push(summary),
  );
  await process.initialize();
  await process.request("stderr-summary");
  await process.close();
  assert.equal(summaries.length, 1);
  assert.deepEqual(summaries[0], {
    exitCode: 0,
    signal: null,
    lineCount: 3,
    byteCount: 158,
    truncated: false,
    level: "error",
    target: "codex_core::config::provider",
    categories: ["connection", "error", "tls"],
  });
  assert.doesNotMatch(JSON.stringify(summaries), /secret|\/private|token|prompt/i);
});

test("native stderr recognizes bounded Rust tracing prefixes", options, async (t) => {
  const summaries: Parameters<NonNullable<CodexProcessOptions["onStderrSummary"]>>[0][] = [];
  const { process } = await fixture(
    t,
    "normal",
    4000,
    undefined,
    false,
    false,
    undefined,
    undefined,
    undefined,
    (summary) => summaries.push(summary),
  );
  await process.initialize();
  await process.request("stderr-rust-tracing");
  await process.close();
  assert.equal(summaries.length, 1);
  assert.deepEqual(
    {
      level: summaries[0]!.level,
      target: summaries[0]!.target,
      categories: summaries[0]!.categories,
    },
    { level: "info", target: "codex_native::session", categories: ["timeout"] },
  );
  assert.doesNotMatch(JSON.stringify(summaries), /\/secret/);
});

test("unbounded native stderr lines keep classification and memory bounded", options, async (t) => {
  const summaries: Parameters<NonNullable<CodexProcessOptions["onStderrSummary"]>>[0][] = [];
  const { process } = await fixture(
    t,
    "normal",
    4000,
    undefined,
    false,
    false,
    undefined,
    undefined,
    undefined,
    (summary) => summaries.push(summary),
  );
  await process.initialize();
  await process.request("stderr-long");
  await process.close();
  assert.equal(summaries.length, 1);
  assert.equal(summaries[0]!.lineCount, 1);
  assert.equal(summaries[0]!.byteCount, 2 * 1024 * 1024 + 50);
  assert.equal(summaries[0]!.truncated, true);
  assert.deepEqual(
    {
      level: summaries[0]!.level,
      target: summaries[0]!.target,
      categories: summaries[0]!.categories,
    },
    { level: "error", target: "codex_core::transport", categories: ["timeout", "error"] },
  );
  assert.doesNotMatch(JSON.stringify(summaries), /secret-token|a{100}|b{100}/);
});

test("empty native stderr emits a zero summary only once", options, async (t) => {
  const summaries: Parameters<NonNullable<CodexProcessOptions["onStderrSummary"]>>[0][] = [];
  const { process } = await fixture(
    t,
    "normal",
    4000,
    undefined,
    false,
    false,
    undefined,
    undefined,
    undefined,
    (summary) => summaries.push(summary),
  );
  await process.initialize();
  await process.close();
  await process.close();
  assert.equal(summaries.length, 1);
  assert.deepEqual(summaries[0], {
    exitCode: 0,
    signal: null,
    lineCount: 0,
    byteCount: 0,
    truncated: false,
    level: "unknown",
    target: undefined,
    categories: [],
  });
});

test("native stderr callback failure cannot break transport state", options, async (t) => {
  const { process } = await fixture(
    t,
    "normal",
    4000,
    undefined,
    false,
    false,
    undefined,
    undefined,
    undefined,
    () => {
      throw new Error("diagnostic callback failure");
    },
  );
  await process.initialize();
  await process.request("stderr-summary");
  assert.equal(await process.request("echo", "alive"), "alive");
  await process.close();
  await assert.rejects(process.initialize(), /closed/i);
});

test("missing executable is an actionable startup failure", options, async () => {
  const process = createCodexProcess({
    executable: "/nonexistent/codez-codex-test",
    cwd: tmpdir(),
  });
  await assert.rejects(process.initialize(), /executable|start|spawn/i);
  await process.close();
});

test("close sends EOF, rejects pending immediately and is idempotent", options, async (t) => {
  const { process, trace } = await fixture(t);
  await process.initialize();
  const pending = assert.rejects(process.request("hang"), /closed/i);
  const first = process.close();
  await pending;
  await Promise.all([first, process.close()]);
  assert.equal(await readFile(trace, "utf8"), "EOF\n");
  await assert.rejects(process.initialize(), /closed/i);
});

test(
  "stubborn child is killed within a bounded shutdown after EOF then SIGTERM",
  options,
  async (t) => {
    const { process, trace } = await fixture(t, "stubborn");
    await process.initialize();
    const { pid } = await process.request<{ pid: number }>("status");
    const start = Date.now();
    await process.close();
    assert.ok(Date.now() - start < 4000);
    assert.match(await readFile(trace, "utf8"), /^EOF\nSIGTERM\n$/);
    assert.throws(() => globalThis.process.kill(pid, 0), { code: "ESRCH" });
  },
);

test(
  "serialization and oversized outgoing messages reject without corrupting transport",
  options,
  async (t) => {
    const { process } = await fixture(t);
    await process.initialize();
    const cyclic = {};
    Object.assign(cyclic, { cyclic });
    await assert.rejects(process.request("echo", cyclic), /serializ/i);
    await assert.rejects(process.request("echo", "x".repeat(33 * 1024 * 1024)), /large|limit/i);
    assert.equal(await process.request("echo", "ok"), "ok");
  },
);

test("bounded pending requests reject overflow and all settle on close", options, async (t) => {
  const { process } = await fixture(t);
  await process.initialize();
  const pending = Array.from({ length: 1024 }, () =>
    assert.rejects(process.request("hang"), /closed/i),
  );
  await assert.rejects(process.request("echo"), /limit/i);
  await process.close();
  await Promise.all(pending);
});

test("close during handshake is terminal, including late close subscribers", options, async (t) => {
  const { process } = await fixture(t, "handshake-timeout");
  const initializing = assert.rejects(process.initialize(), /closed/i);
  await process.close();
  await initializing;
  assert.match((await closed(process)).message, /closed/i);
  await assert.rejects(process.initialize(), /closed/i);
});

test("listener failure cannot break response correlation or close cleanup", options, async (t) => {
  const { process } = await fixture(t);
  await process.initialize();
  process.onNotification(() => {
    throw new Error("caller failure");
  });
  process.onClose(() => {
    throw new Error("caller failure");
  });
  const event = nextNotification(process);
  await process.request("events");
  assert.equal((await event).method, "item/delta");
  await process.close();
});

test(
  "unserializable replies retain reply rights and undefined result becomes null",
  options,
  async (t) => {
    const { process } = await fixture(t);
    await process.initialize();
    process.onRequest(() => {});
    await process.request("events");
    await assert.rejects(
      process.respond("approval-1", () => {}),
      /serializ/i,
    );
    await assert.rejects(process.respondError(42, { code: NaN, message: "invalid" }), /invalid/i);
    const received = nextNotification(process);
    await process.respond("approval-1", undefined);
    assert.deepEqual((await received).params, { id: "approval-1", result: null });
    await process.respondError(42, { code: -32601, message: "Unsupported" });
  },
);

test("update_plan 开关开启时向 app-server argv 注入 server 级配置覆盖", options, async (t) => {
  const enabled = await fixture(t, "normal", 1000, undefined, true, true);
  await enabled.process.initialize();
  const trace = await readFile(enabled.trace, "utf8");
  const argvLine = trace.split("\n").find((line) => line.startsWith("argv "));
  assert.ok(argvLine, "fixture 必须记录启动 argv");
  assert.deepEqual(JSON.parse(argvLine.slice(5)), [
    "app-server",
    "--listen",
    "stdio://",
    "-c",
    "features.instant_interrupt=false",
    "-c",
    "tools.update_plan.enabled=true",
  ]);
});

test("update_plan 开关缺省时 argv 仅含默认 instant_interrupt=false 覆盖", options, async (t) => {
  const disabled = await fixture(t, "normal", 1000, undefined, false, true);
  await disabled.process.initialize();
  const trace = await readFile(disabled.trace, "utf8");
  const argvLine = trace.split("\n").find((line) => line.startsWith("argv "));
  assert.ok(argvLine, "fixture 必须记录启动 argv");
  assert.deepEqual(JSON.parse(argvLine.slice(5)), [
    "app-server",
    "--listen",
    "stdio://",
    "-c",
    "features.instant_interrupt=false",
  ]);
});

test("桌面专属 MCP 只通过进程级覆盖传入，字符串与数组按 TOML 转义", options, async (t) => {
  const { process, trace } = await fixture(t, "normal", 1000, undefined, false, true, [
    {
      name: "codez-desktop-browser-cua",
      command: '/tmp/my "bridge"',
      args: ["/tmp/bridge.cjs", "native-browser-cua-mcp"],
      env: { CODEZ_NATIVE_BROWSER_CUA_TOKEN_FILE: "/tmp/token file", ELECTRON_RUN_AS_NODE: "1" },
    },
  ]);
  await process.initialize();
  const content = await readFile(trace, "utf8");
  const argvLine = content.split("\n").find((line) => line.startsWith("argv "));
  assert.ok(argvLine);
  assert.deepEqual(JSON.parse(argvLine.slice(5)), [
    "app-server",
    "--listen",
    "stdio://",
    "-c",
    "features.instant_interrupt=false",
    "-c",
    'mcp_servers.codez-desktop-browser-cua={command="/tmp/my \\"bridge\\"",args=["/tmp/bridge.cjs","native-browser-cua-mcp"],env={"CODEZ_NATIVE_BROWSER_CUA_TOKEN_FILE"="/tmp/token file","ELECTRON_RUN_AS_NODE"="1"},enabled=true}',
  ]);
});

test(
  "native turn/steer during in-flight reasoning stream does not abort the first model request and sends guidance in the next step",
  {
    skip: !process.env.CODEX_AUXILIARY_TEST_BINARY,
    timeout: 30_000,
  },
  async (t) => {
    const temporary = await mkdtemp(join(tmpdir(), "codez-steer-stream-"));
    const cwd = join(temporary, "workspace");
    const codexHome = join(temporary, "codex-home");
    await mkdir(cwd);
    await mkdir(codexHome);
    t.after(() => rm(temporary, { recursive: true, force: true }));

    const modelRequests: Record<string, unknown>[] = [];
    let firstResponseStream: ServerResponse | undefined;
    let firstRequestAborted = false;
    const firstReasoningSent = Promise.withResolvers<void>();
    const secondRequestReceived = Promise.withResolvers<void>();

    const sendSse = (res: ServerResponse, event: Record<string, unknown>) => {
      res.write(`event: ${String(event.type)}\ndata: ${JSON.stringify(event)}\n\n`);
    };

    const server = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        const parsed = JSON.parse(Buffer.concat(chunks).toString()) as Record<string, unknown>;
        modelRequests.push(parsed);
        const requestIndex = modelRequests.length;
        response.writeHead(200, {
          "content-type": "text/event-stream",
          "cache-control": "no-cache",
        });
        if (requestIndex === 1) {
          firstResponseStream = response;
          response.on("close", () => {
            if (!response.writableEnded) firstRequestAborted = true;
          });
          sendSse(response, {
            type: "response.created",
            response: {
              id: "resp-1",
              object: "response",
              status: "in_progress",
              output: [],
            },
          });
          sendSse(response, {
            type: "response.output_item.added",
            output_index: 0,
            item: {
              id: "reason-1",
              type: "reasoning",
              summary: [],
            },
          });
          sendSse(response, {
            type: "response.reasoning_summary_part.added",
            item_id: "reason-1",
            output_index: 0,
            summary_index: 0,
            part: { type: "summary_text", text: "" },
          });
          sendSse(response, {
            type: "response.reasoning_summary_text.delta",
            item_id: "reason-1",
            output_index: 0,
            summary_index: 0,
            delta: "Thinking about the first step...",
          });
          firstReasoningSent.resolve();
          return;
        }
        secondRequestReceived.resolve();
        const item = {
          type: "message",
          id: `msg-${requestIndex}`,
          role: "assistant",
          status: "completed",
          content: [{ type: "output_text", text: "Guided step completed", annotations: [] }],
        };
        const completed = {
          id: `resp-${requestIndex}`,
          object: "response",
          status: "completed",
          output: [item],
          usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
        };
        sendSse(response, {
          type: "response.created",
          response: { ...completed, status: "in_progress", output: [] },
        });
        sendSse(response, {
          type: "response.output_item.added",
          output_index: 0,
          item: { ...item, status: "in_progress", content: [] },
        });
        sendSse(response, { type: "response.output_item.done", output_index: 0, item });
        sendSse(response, { type: "response.completed", response: completed });
        response.end();
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
    await writeFile(
      join(codexHome, "config.toml"),
      `model_provider = "fixture"\nmodel = "gpt-5.2"\n` +
        `[model_providers.fixture]\nname = "Isolated fixture"\nbase_url = "http://127.0.0.1:${address.port}/v1"\nwire_api = "responses"\nrequires_openai_auth = false\n` +
        `[analytics]\nenabled = false\n`,
    );
    const rpc = createCodexProcess({
      executable: process.env.CODEX_AUXILIARY_TEST_BINARY!,
      cwd,
      env: {
        ...globalThis.process.env,
        CODEX_HOME: codexHome,
      },
    });
    t.after(async () => {
      await rpc.close();
    });
    await rpc.initialize();

    const reasoningStarted = Promise.withResolvers<void>();
    const turnCompleted = Promise.withResolvers<void>();
    const detach = rpc.onNotification((event) => {
      const params = event.params as { item?: { type?: string } };
      if (
        (event.method === "item/started" && params.item?.type === "reasoning") ||
        event.method === "item/reasoning/summaryTextDelta"
      ) {
        reasoningStarted.resolve();
      }
      if (event.method === "turn/completed") {
        turnCompleted.resolve();
      }
    });
    t.after(detach);

    const started = await rpc.request<{ thread: { id: string } }>("thread/start", {
      cwd,
      model: "gpt-5.2",
      modelProvider: "fixture",
      sandbox: "read-only",
      approvalPolicy: "never",
    });
    const turnStart = await rpc.request<{ turn: { id: string } }>("turn/start", {
      threadId: started.thread.id,
      input: [{ type: "text", text: "First prompt", text_elements: [] }],
    });

    await firstReasoningSent.promise;
    await reasoningStarted.promise;

    // 在思考流仍处于 in-flight 时发送引导（turn/steer）
    await rpc.request("turn/steer", {
      threadId: started.thread.id,
      expectedTurnId: turnStart.turn.id,
      input: [{ type: "text", text: "Guidance while thinking", text_elements: [] }],
    });

    // 等待一小段时间，验证第一轮流式请求绝不能被中断，且不会抢发第二轮请求
    await delay(150);
    assert.equal(firstRequestAborted, false, "in-flight reasoning stream must not be aborted");
    assert.equal(
      modelRequests.length,
      1,
      "next model step must wait for current request to finish",
    );

    // 正常完成第一轮流式输出
    assert.ok(firstResponseStream);
    const firstMessageItem = {
      type: "message",
      id: "msg-1",
      role: "assistant",
      status: "completed",
      content: [{ type: "output_text", text: "First step reply", annotations: [] }],
    };
    const firstCompleted = {
      id: "resp-1",
      object: "response",
      status: "completed",
      output: [
        {
          id: "reason-1",
          type: "reasoning",
          summary: [{ type: "summary_text", text: "Thinking about the first step..." }],
        },
        firstMessageItem,
      ],
      usage: { input_tokens: 8, output_tokens: 4, total_tokens: 12 },
    };
    sendSse(firstResponseStream, {
      type: "response.output_item.done",
      output_index: 0,
      item: firstCompleted.output[0],
    });
    sendSse(firstResponseStream, {
      type: "response.output_item.added",
      output_index: 1,
      item: { ...firstMessageItem, status: "in_progress", content: [] },
    });
    sendSse(firstResponseStream, {
      type: "response.output_item.done",
      output_index: 1,
      item: firstMessageItem,
    });
    sendSse(firstResponseStream, {
      type: "response.completed",
      response: firstCompleted,
    });
    firstResponseStream.end();

    // 第一轮正常结束后，引导在同一 turn 的第二次请求中发送
    await secondRequestReceived.promise;
    await turnCompleted.promise;
    assert.equal(firstRequestAborted, false);
    assert.equal(modelRequests.length, 2);
    const secondInputJson = JSON.stringify(modelRequests[1]?.input ?? []);
    assert.match(secondInputJson, /First prompt/);
    assert.match(secondInputJson, /First step reply/);
    assert.match(secondInputJson, /Guidance while thinking/);
  },
);
