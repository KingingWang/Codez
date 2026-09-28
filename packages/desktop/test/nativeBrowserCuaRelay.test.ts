import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
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
  const servers = [
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

  unsubscribe();
  holder.set({ servers });
  assert.deepEqual(seen, [2, 0]);
});
