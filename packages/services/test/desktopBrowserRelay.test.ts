import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createDesktopBrowserRelay } from "../src/codez-agent/desktopBrowserRelay.js";

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
