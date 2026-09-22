import assert from "node:assert/strict";
import { chmod, copyFile, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { test, type TestContext } from "node:test";
import { createCodexProcess } from "../src/codex-process.js";
import type { CodexProcess, CodexNotification, CodexServerRequest } from "../src/contract.js";

const options = { timeout: 10_000, skip: process.platform === "win32" };
async function fixture(
  t: TestContext,
  mode = "normal",
  requestTimeoutMs = 1000,
  interactionTimeoutMs?: number,
) {
  const directory = await mkdtemp(join(tmpdir(), "zcode transport 中文 "));
  const executable = join(directory, "fake codex");
  const trace = join(directory, "trace");
  await copyFile(new URL("./fixtures/fake-codex.mjs", import.meta.url), executable);
  await chmod(executable, 0o700);
  const process = createCodexProcess({
    executable,
    cwd: directory,
    requestTimeoutMs,
    interactionTimeoutMs,
    env: {
      PATH: globalThis.process.env.PATH,
      HOME: directory,
      CODEX_HOME: directory,
      FAKE_CODEX_MODE: mode,
      FAKE_CODEX_TRACE: trace,
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
          executable: "/nonexistent/zcode-codex-test",
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
    const { process } = await fixture(t, "normal", 100);
    await process.initialize();
    await assert.rejects(process.request("mutate"), /timed out/i);
    await delay(140);
    const status = await process.request<{ mutationCount: number }>("status");
    assert.equal(status.mutationCount, 1);
    assert.equal(await process.request("echo", "after timeout"), "after timeout");
  },
);

for (const mode of ["handshake-timeout", "handshake-error"]) {
  test(`${mode} is terminal and never retries initialize`, options, async (t) => {
    const { process, trace } = await fixture(t, mode, 100);
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
      const { process } = await fixture(t);
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

for (const method of ["oversized", "truncated", "invalid-utf8", "duplicate-server-id"]) {
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

test("missing executable is an actionable startup failure", options, async () => {
  const process = createCodexProcess({
    executable: "/nonexistent/zcode-codex-test",
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
    await assert.rejects(process.request("echo", "x".repeat(8 * 1024 * 1024)), /large|limit/i);
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
