import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  NATIVE_BROWSER_CUA_RELAY_RESPONSE_MAX_BYTES,
  type DesktopCodexMcpServer,
} from "@codez/shared";
import {
  executeNativeBrowserCuaBrokerRequest,
  synthesizeNativeBrowserCuaFailureLine,
} from "../src/host/nativeBrowserCuaBrokerClient.js";
import { createNativeBrowserCuaMcpStateHolder } from "../src/host/nativeBrowserCuaMcpState.js";

const itPosix = process.platform === "win32" ? test.skip : test;

itPosix("host broker client swaps in the window token and returns the broker line", async () => {
  const root = await mkdtemp(join(tmpdir(), "codez-broker-client-"));
  const endpoint = join(root, "broker.sock");
  const tokenFile = join(root, "window.token");
  await writeFile(tokenFile, "window-token-value\n", { mode: 0o600 });
  const received: string[] = [];
  const server = createServer((socket) => {
    let buffer = "";
    socket.on("data", (chunk) => {
      buffer += chunk.toString();
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      received.push(buffer.slice(0, newline));
      const id = (JSON.parse(received[0]!) as { id: string }).id;
      socket.end(`${JSON.stringify({ id, ok: true, result: { ok: true, elapsedMs: 1 } })}\n`);
    });
  });
  await new Promise<void>((resolve) => server.listen(endpoint, resolve));
  try {
    const requestId = randomUUID();
    const line = await executeNativeBrowserCuaBrokerRequest({
      target: { endpoint, tokenFile },
      payload: JSON.stringify({
        id: requestId,
        token: "remote-local-token-must-be-replaced",
        command: { method: "getState" },
      }),
    });
    assert.equal(received.length, 1);
    const outbound = JSON.parse(received[0]!) as { token: string };
    assert.equal(outbound.token, "window-token-value");
    const response = JSON.parse(line) as { id: string; ok: boolean };
    assert.equal(response.id, requestId);
    assert.equal(response.ok, true);
  } finally {
    server.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("host broker client synthesizes backend_unavailable on failure classes", async () => {
  const root = await mkdtemp(join(tmpdir(), "codez-broker-client-"));
  try {
    const requestId = randomUUID();
    // broker 不可达
    const unreachable = await executeNativeBrowserCuaBrokerRequest({
      target: { endpoint: join(root, "missing.sock"), tokenFile: join(root, "missing.token") },
      payload: JSON.stringify({ id: requestId, token: "x", command: { method: "getState" } }),
      timeoutMs: 1_000,
    });
    let parsed = JSON.parse(unreachable) as { id: string; ok: boolean; error: string };
    assert.equal(parsed.id, requestId);
    assert.equal(parsed.ok, false);
    assert.equal(parsed.error, "backend_unavailable");

    // 非法 JSON：无法取 id 时回退随机 uuid，仍然是合法失败帧。
    const malformed = await executeNativeBrowserCuaBrokerRequest({
      target: { endpoint: join(root, "missing.sock"), tokenFile: join(root, "missing.token") },
      payload: "not-json",
      timeoutMs: 1_000,
    });
    parsed = JSON.parse(malformed) as { id: string; ok: boolean; error: string };
    assert.equal(parsed.ok, false);
    assert.equal(parsed.error, "backend_unavailable");

    // 无目标（开关关闭）的合成失败帧同样保持 id 关联。
    const disabled = synthesizeNativeBrowserCuaFailureLine(
      JSON.stringify({ id: requestId, token: "x" }),
      "disabled",
    );
    parsed = JSON.parse(disabled) as { id: string; ok: boolean; error: string };
    assert.equal(parsed.id, requestId);
    assert.equal(parsed.error, "backend_unavailable");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("native browser MCP state holder updates, notifies and derives the broker target", () => {
  const holder = createNativeBrowserCuaMcpStateHolder();
  assert.equal(holder.brokerTarget(), undefined);

  const seen: number[] = [];
  const unsubscribe = holder.subscribe((state) => seen.push(state.servers.length));
  const servers: DesktopCodexMcpServer[] = [
    {
      name: "codez-desktop-browser-cua",
      command: "/fixture/electron",
      args: ["/fixture/bridge.cjs", "native-browser-cua-mcp"],
      env: {
        CODEZ_NATIVE_BROWSER_CUA_ENDPOINT: "/tmp/broker.sock",
        CODEZ_NATIVE_BROWSER_CUA_TOKEN_FILE: "/tmp/broker.token",
      },
    },
    {
      name: "unrelated",
      command: "/fixture/other",
      args: [],
      env: {},
    },
  ];
  holder.set({
    servers,
    nativeBrowserCua: { browserAvailable: true, cuaAvailable: false },
  });
  assert.deepEqual(seen, [2]);
  assert.deepEqual(holder.brokerTarget(), {
    endpoint: "/tmp/broker.sock",
    tokenFile: "/tmp/broker.token",
  });

  holder.set({ servers: [], nativeBrowserCua: { browserAvailable: false, cuaAvailable: false } });
  assert.deepEqual(seen, [2, 0]);
  assert.equal(holder.brokerTarget(), undefined);

  // 独立 CUA 会让 server 载体继续存在；远端 relay 只能依赖 browser 授权事实。
  holder.set({ servers, nativeBrowserCua: { browserAvailable: false, cuaAvailable: true } });
  assert.equal(holder.brokerTarget(), undefined);

  holder.set({ servers, nativeBrowserCua: { browserAvailable: true, cuaAvailable: false } });
  assert.deepEqual(holder.brokerTarget(), {
    endpoint: "/tmp/broker.sock",
    tokenFile: "/tmp/broker.token",
  });

  unsubscribe();
  holder.set({ servers, nativeBrowserCua: { browserAvailable: true, cuaAvailable: false } });
  assert.deepEqual(seen, [2, 0, 2, 2]);
});

class FixtureBrokerSocket extends EventEmitter {
  readonly writes: string[] = [];
  destroyCount = 0;
  write(value: string) {
    this.writes.push(value);
    return true;
  }
  destroy() {
    this.destroyCount += 1;
    return this;
  }
}

async function readFixtureBrokerResponse(
  chunks: readonly Buffer[],
  options: { close?: boolean; timeoutMs?: number } = {},
) {
  const socket = new FixtureBrokerSocket();
  const requestId = "00000000-0000-4000-8000-000000000041";
  let connections = 0;
  const line = await executeNativeBrowserCuaBrokerRequest({
    target: { endpoint: "/fixture/broker.sock", tokenFile: "/fixture/window.token" },
    payload: JSON.stringify({
      id: requestId,
      token: "remote-token",
      command: { method: "getState" },
    }),
    readTokenFile: async () => "synthetic-window-token\n",
    timeoutMs: options.timeoutMs ?? 1_000,
    connect: () => {
      connections += 1;
      queueMicrotask(() => {
        socket.emit("connect");
        for (const chunk of chunks) socket.emit("data", chunk);
        if (options.close !== false) socket.emit("close");
      });
      return socket as unknown as Socket;
    },
  });
  return { line, socket, requestId, connections };
}

test("host broker response preserves every CJK and emoji byte split", async (t) => {
  const expected = JSON.stringify({
    id: "00000000-0000-4000-8000-000000000041",
    ok: true,
    result: { ok: true, state: { title: "中文页面😀 日本語🧪 错误说明" }, elapsedMs: 0 },
  });
  const frame = Buffer.from(`${expected}\n`);
  let checkedSplits = 0;
  for (let offset = 1; offset < frame.length; offset += 1) {
    if ((frame[offset]! & 0xc0) !== 0x80) continue;
    const result = await readFixtureBrokerResponse([
      frame.subarray(0, offset),
      frame.subarray(offset),
      Buffer.from('{"late":"must not settle another response"}\n'),
    ]);
    assert.equal(result.line, expected, `UTF-8 split at byte ${offset}`);
    assert.equal(result.line.includes("\ufffd"), false);
    assert.equal(result.connections, 1);
    assert.equal(result.socket.writes.length, 1);
    assert.equal(result.socket.destroyCount, 1);
    checkedSplits += 1;
  }
  assert.ok(checkedSplits >= 20);
  t.diagnostic(`verified multibyte response splits: ${checkedSplits}`);
});

test("host broker response accepts multiple raw chunks without repeated decoding", async () => {
  const expected = JSON.stringify({ ok: true, message: "分片🙂中文".repeat(4_000) });
  const frame = Buffer.from(`${expected}\n`);
  const chunks: Buffer[] = [];
  for (let offset = 0; offset < frame.length; offset += 37) {
    chunks.push(frame.subarray(offset, offset + 37));
  }
  const result = await readFixtureBrokerResponse(chunks);
  assert.ok(result.line === expected, "multichunk response must match the complete raw JSON");
  assert.equal(result.connections, 1);
  assert.equal(result.socket.writes.length, 1);
  assert.equal(result.socket.destroyCount, 1);
});

test("host broker response retains the exact 32 MiB received-byte boundary", async () => {
  const empty = JSON.stringify({ ok: true, message: "" });
  const expected = JSON.stringify({
    ok: true,
    message: "a".repeat(NATIVE_BROWSER_CUA_RELAY_RESPONSE_MAX_BYTES - Buffer.byteLength(empty) - 1),
  });
  const boundary = Buffer.from(`${expected}\n`);
  assert.equal(boundary.length, NATIVE_BROWSER_CUA_RELAY_RESPONSE_MAX_BYTES);
  const accepted = await readFixtureBrokerResponse([
    boundary.subarray(0, 65_537),
    boundary.subarray(65_537),
  ]);
  assert.equal(accepted.line, expected);
  const rejected = await readFixtureBrokerResponse([
    Buffer.alloc(NATIVE_BROWSER_CUA_RELAY_RESPONSE_MAX_BYTES, 0x61),
    Buffer.from("b"),
    Buffer.from("\n"),
  ]);
  assert.deepEqual(JSON.parse(rejected.line), {
    id: rejected.requestId,
    ok: false,
    error: "backend_unavailable",
    message: "Native Browser/CUA broker response exceeded the 32 MiB limit",
  });
  assert.equal(rejected.connections, 1);
  assert.equal(rejected.socket.writes.length, 1);
  assert.equal(rejected.socket.destroyCount, 1);
});

test("host broker partial close and timeout settle one failed request without retry", async () => {
  const closed = await readFixtureBrokerResponse([Buffer.from('{"title":"半个')]);
  const timedOut = await readFixtureBrokerResponse([], { close: false, timeoutMs: 1 });
  for (const result of [closed, timedOut]) {
    assert.equal(JSON.parse(result.line).ok, false);
    assert.equal(JSON.parse(result.line).error, "backend_unavailable");
    assert.equal(result.connections, 1);
    assert.equal(result.socket.writes.length, 1);
    assert.equal(result.socket.destroyCount, 1);
  }
  assert.match(closed.line, /closed the connection/u);
  assert.match(timedOut.line, /timed out/u);
});
