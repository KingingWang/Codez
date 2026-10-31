import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import net, { createConnection, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { NATIVE_BROWSER_CUA_RELAY_REQUEST_MAX_BYTES } from "@codez/shared";
import {
  createDesktopBrowserRelay,
  type DesktopBrowserRelay,
} from "../src/codez-agent/desktopBrowserRelay.js";

// posix-only：CI 与桌面目标平台均为 unix socket；win32 named pipe 由同一份路径 helper 覆盖。
const itPosix = process.platform === "win32" ? test.skip : test;

function once<T = void>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((r, j) => {
    resolve = r;
    reject = j;
  });
  return { promise, resolve, reject };
}

async function roundtrip(endpoint: string, payload: string): Promise<string> {
  const done = once<string>();
  const socket = createConnection(endpoint);
  let buffer = "";
  socket.on("error", done.reject);
  socket.on("data", (chunk) => {
    buffer += chunk.toString();
    const newline = buffer.indexOf("\n");
    if (newline >= 0) done.resolve(buffer.slice(0, newline));
  });
  socket.on("close", () => done.reject(new Error("socket closed before a response line")));
  socket.on("connect", () => socket.write(`${payload}\n`));
  try {
    return await done.promise;
  } finally {
    socket.destroy();
  }
}

class FixtureRelaySocket extends EventEmitter {
  writable = true;
  responses = 0;
  readonly response = once<string>();

  end(payload: string) {
    this.responses += 1;
    this.writable = false;
    this.response.resolve(payload.trimEnd());
    this.emit("close");
    return this;
  }

  destroy() {
    this.writable = false;
    this.emit("close");
    return this;
  }
}

async function withFramedRelay(
  t: TestContext,
  run: (input: {
    relay: DesktopBrowserRelay;
    token: string;
    startConnection: (socket: FixtureRelaySocket) => void;
  }) => Promise<void>,
) {
  const root = await mkdtemp(join(tmpdir(), "codez-relay-framing-"));
  const originalCreateServer = net.createServer.bind(net);
  let acceptConnection: ((socket: Socket) => void) | undefined;
  const mockedCreateServer = t.mock.method(
    net,
    "createServer",
    (listener: (socket: Socket) => void) => {
      acceptConnection = listener;
      return originalCreateServer();
    },
  );
  // 使用真实 relay 生命周期与合成 socket 精确控制字节边界，不增加产品测试专用入口。
  syncBuiltinESMExports();
  const relay = createDesktopBrowserRelay({
    dataDirectory: root,
    temporaryDirectory: root,
    logger: { warn: () => {} },
  });
  try {
    await relay.setEnabled(true);
    const descriptor = relay.activeDescriptor();
    assert.ok(descriptor);
    const token = (await readFile(descriptor.tokenFile, "utf8")).trim();
    await run({
      relay,
      token,
      startConnection(socket) {
        assert.ok(acceptConnection);
        acceptConnection(socket as unknown as Socket);
      },
    });
  } finally {
    await relay.dispose();
    mockedCreateServer.mock.restore();
    syncBuiltinESMExports();
    await rm(root, { recursive: true, force: true });
  }
}

itPosix("relay request preserves every CJK and emoji byte split with one dispatch", async (t) => {
  await withFramedRelay(t, async ({ relay, token, startConnection }) => {
    const payload = JSON.stringify({
      id: randomUUID(),
      token,
      command: { method: "type", text: "输入中文🙂 日本語🧪 保留原样" },
    });
    const frame = Buffer.from(`${payload}\n`);
    const requests: string[] = [];
    const subscription = relay.onCommandRequest((request) => {
      requests.push(request.payload);
      relay.resolveCommand(request.requestId, JSON.stringify({ ok: true }));
    });
    let checkedSplits = 0;
    try {
      for (let offset = 1; offset < frame.length; offset += 1) {
        if ((frame[offset]! & 0xc0) !== 0x80) continue;
        const socket = new FixtureRelaySocket();
        const before = requests.length;
        startConnection(socket);
        socket.emit("data", frame.subarray(0, offset));
        socket.emit("data", frame.subarray(offset));
        socket.emit("data", frame);
        assert.equal(JSON.parse(await socket.response.promise).ok, true);
        assert.ok(requests.at(-1) === payload, `UTF-8 split at byte ${offset}`);
        assert.equal(requests.length, before + 1);
        assert.equal(socket.responses, 1);
        checkedSplits += 1;
      }
    } finally {
      subscription.dispose();
    }
    assert.ok(checkedSplits >= 20);
    t.diagnostic(`verified relay multibyte request splits: ${checkedSplits}`);
  });
});

itPosix("relay retains the 1 MiB received-byte bound and never dispatches overflow", async (t) => {
  await withFramedRelay(t, async ({ relay, token, startConnection }) => {
    const requests: string[] = [];
    const subscription = relay.onCommandRequest((request) => {
      requests.push(request.payload);
      relay.resolveCommand(request.requestId, JSON.stringify({ ok: true }));
    });
    try {
      const payload = { id: randomUUID(), token, command: { method: "type", text: "" } };
      const overhead = Buffer.byteLength(`${JSON.stringify(payload)}\n`);
      payload.command.text = "a".repeat(NATIVE_BROWSER_CUA_RELAY_REQUEST_MAX_BYTES - overhead);
      const boundary = Buffer.from(`${JSON.stringify(payload)}\n`);
      assert.equal(boundary.length, NATIVE_BROWSER_CUA_RELAY_REQUEST_MAX_BYTES);
      const accepted = new FixtureRelaySocket();
      startConnection(accepted);
      accepted.emit("data", boundary.subarray(0, 65_537));
      accepted.emit("data", boundary.subarray(65_537));
      assert.equal(JSON.parse(await accepted.response.promise).ok, true);
      assert.equal(requests.length, 1);
      assert.ok(requests[0] === JSON.stringify(payload), "boundary payload must remain exact");

      const rejected = new FixtureRelaySocket();
      startConnection(rejected);
      rejected.emit("data", Buffer.alloc(NATIVE_BROWSER_CUA_RELAY_REQUEST_MAX_BYTES, 0x61));
      rejected.emit("data", Buffer.from("b"));
      rejected.emit("data", boundary);
      assert.equal(JSON.parse(await rejected.response.promise).error, "invalid_request");
      assert.equal(requests.length, 1);
      assert.equal(rejected.responses, 1);
    } finally {
      subscription.dispose();
    }
  });
});

itPosix("relay does not redeliver an accepted mutation when its listener is rebuilt", async (t) => {
  await withFramedRelay(t, async ({ relay, token, startConnection }) => {
    const received = once<{ requestId: string; payload: string }>();
    const requests: string[] = [];
    const first = relay.onCommandRequest((request) => {
      requests.push(request.payload);
      received.resolve(request);
    });
    const socket = new FixtureRelaySocket();
    startConnection(socket);
    socket.emit(
      "data",
      Buffer.from(`${JSON.stringify({ id: randomUUID(), token, command: { method: "click" } })}\n`),
    );
    const request = await received.promise;
    first.dispose();
    const replacement = relay.onCommandRequest((replayed) => requests.push(replayed.payload));
    try {
      assert.equal(requests.length, 1);
      relay.resolveCommand(request.requestId, JSON.stringify({ ok: true }));
      assert.equal(JSON.parse(await socket.response.promise).ok, true);
      assert.equal(socket.responses, 1);
    } finally {
      replacement.dispose();
    }
  });
});

itPosix("relay drops a partial closed connection without dispatch", async (t) => {
  await withFramedRelay(t, async ({ relay, startConnection }) => {
    let requests = 0;
    const subscription = relay.onCommandRequest(() => {
      requests += 1;
    });
    try {
      const socket = new FixtureRelaySocket();
      startConnection(socket);
      socket.emit("data", Buffer.from('{"text":"部分中文🙂'));
      socket.destroy();
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.equal(requests, 0);
      assert.equal(socket.responses, 0);
      assert.equal(socket.listenerCount("data"), 0);
    } finally {
      subscription.dispose();
    }
  });
});

itPosix(
  "desktop browser relay authenticates with the remote-local token and relays responses",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "codez-browser-relay-"));
    const relay = createDesktopBrowserRelay({
      dataDirectory: root,
      temporaryDirectory: root,
      requestTimeoutMs: 5_000,
      logger: { warn: () => {} },
    });
    try {
      assert.equal(relay.active, false);
      assert.equal(relay.activeDescriptor(), undefined);

      assert.equal(await relay.setEnabled(true), true);
      // 幂等：重复授予不重建 socket/token。
      assert.equal(await relay.setEnabled(true), false);

      const descriptor = relay.activeDescriptor();
      assert.ok(descriptor, "granted relay must expose a spawn-env descriptor");
      const token = (await readFile(descriptor.tokenFile, "utf8")).trim();
      assert.equal((await stat(descriptor.tokenFile)).mode & 0o777, 0o600);

      const bad = await roundtrip(
        descriptor.endpoint,
        JSON.stringify({
          id: randomUUID(),
          token: "0".repeat(64),
          command: { method: "getState" },
        }),
      );
      assert.match(bad, /authentication_failed/u);

      const requests: { requestId: string; payload: string }[] = [];
      const seen = once();
      const subscription = relay.onCommandRequest((request) => {
        requests.push(request);
        seen.resolve();
      });
      const brokerRequestId = randomUUID();
      const rawPayload = JSON.stringify({
        id: brokerRequestId,
        token,
        command: { method: "getState" },
      });
      const pendingResponse = roundtrip(descriptor.endpoint, rawPayload);
      await seen.promise;
      assert.equal(requests.length, 1);
      // 原始载荷逐字节转发：token 置换只发生在 Host 侧，relay 不触碰内容。
      assert.equal(requests[0]!.payload, rawPayload);

      relay.resolveCommand(
        requests[0]!.requestId,
        JSON.stringify({
          id: brokerRequestId,
          ok: true,
          result: { ok: true, elapsedMs: 0 },
        }),
      );
      const line = await pendingResponse;
      assert.match(line, new RegExp(brokerRequestId, "u"));
      assert.match(line, /"ok":true/u);
      subscription.dispose();

      // 撤销：在途请求 fail closed，凭据与 socket 被清理。
      assert.equal(await relay.setEnabled(false), true);
      assert.equal(relay.active, false);
      assert.equal(relay.activeDescriptor(), undefined);
      await assert.rejects(stat(descriptor.tokenFile), /ENOENT/u);
      await assert.rejects(roundtrip(descriptor.endpoint, rawPayload), /./u);
    } finally {
      await relay.dispose();
      await rm(root, { recursive: true, force: true });
    }
  },
);

itPosix(
  "desktop browser relay fails pending requests on revoke and rejects when disabled",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "codez-browser-relay-"));
    const relay = createDesktopBrowserRelay({
      dataDirectory: root,
      temporaryDirectory: root,
      requestTimeoutMs: 60_000,
      logger: { warn: () => {} },
    });
    try {
      await relay.setEnabled(true);
      const descriptor = relay.activeDescriptor();
      assert.ok(descriptor);
      const token = (await readFile(descriptor.tokenFile, "utf8")).trim();
      relay.onCommandRequest(() => {});
      const pendingResponse = roundtrip(
        descriptor.endpoint,
        JSON.stringify({ id: randomUUID(), token, command: { method: "getState" } }),
      );
      // 等 relay 确实收下请求后再撤销。
      await new Promise((resolve) => setTimeout(resolve, 200));
      await relay.setEnabled(false);
      assert.match(await pendingResponse, /backend_unavailable/u);
    } finally {
      await relay.dispose();
      await rm(root, { recursive: true, force: true });
    }
  },
);

itPosix("desktop browser relay times out unanswered requests", async () => {
  const root = await mkdtemp(join(tmpdir(), "codez-browser-relay-"));
  const relay = createDesktopBrowserRelay({
    dataDirectory: root,
    temporaryDirectory: root,
    requestTimeoutMs: 100,
    logger: { warn: () => {} },
  });
  try {
    await relay.setEnabled(true);
    const descriptor = relay.activeDescriptor();
    assert.ok(descriptor);
    const token = (await readFile(descriptor.tokenFile, "utf8")).trim();
    relay.onCommandRequest(() => {});
    const line = await roundtrip(
      descriptor.endpoint,
      JSON.stringify({ id: randomUUID(), token, command: { method: "getState" } }),
    );
    assert.match(line, /backend_unavailable/u);
    assert.match(line, /timed out/u);
  } finally {
    await relay.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

itPosix("desktop browser relay rejects malformed frames and keeps serving", async () => {
  const root = await mkdtemp(join(tmpdir(), "codez-browser-relay-"));
  const relay = createDesktopBrowserRelay({
    dataDirectory: root,
    temporaryDirectory: root,
    requestTimeoutMs: 5_000,
    logger: { warn: () => {} },
  });
  try {
    await relay.setEnabled(true);
    const descriptor = relay.activeDescriptor();
    assert.ok(descriptor);
    const bad = await roundtrip(descriptor.endpoint, "not-json");
    assert.match(bad, /invalid_request/u);
    // 畸形帧不破坏后续连接。
    const again = await roundtrip(descriptor.endpoint, "still-not-json");
    assert.match(again, /invalid_request/u);
  } finally {
    await relay.dispose();
    await rm(root, { recursive: true, force: true });
  }
});
