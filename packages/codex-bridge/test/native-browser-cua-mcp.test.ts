import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { PassThrough } from "node:stream";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import {
  NATIVE_BROWSER_CUA_MCP_BROWSER_METHODS,
  NATIVE_BROWSER_CUA_MCP_CUA_METHODS,
} from "@codez/shared";
import {
  createNativeBrowserCuaMcpRuntime,
  parseNativeCuaBrokerCredentials,
  startNativeBrowserCuaMcpStdio,
} from "../src/native-browser-cua-mcp.js";

function connectedBrokerSocket(): Socket {
  class FakeSocket extends EventEmitter {
    destroy(): void {}
  }
  const socket = new FakeSocket();
  queueMicrotask(() => socket.emit("connect"));
  return socket as unknown as Socket;
}

test("tools/list hides browser tools without a token or a listening Desktop broker", async () => {
  let tokenPresent = false;
  let brokerListening = false;
  let connections = 0;
  const runtime = createNativeBrowserCuaMcpRuntime({
    endpoint: "/fixture/native-browser.sock",
    tokenFile: "/fixture/native-browser.token",
    readFile: async () => {
      if (!tokenPresent) throw new Error("token missing");
      return "fixture-token";
    },
    connect: () => {
      connections += 1;
      if (!brokerListening) throw new Error("stale socket has no listener");
      return connectedBrokerSocket();
    },
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "fixture", version: "0" });
  await Promise.all([runtime.server.connect(serverTransport), client.connect(clientTransport)]);
  try {
    assert.deepEqual((await client.listTools()).tools, []);
    assert.equal(connections, 0, "missing token must not contact the broker");
    tokenPresent = true;
    assert.deepEqual((await client.listTools()).tools, [], "stale endpoint must not expose tools");
    brokerListening = true;
    assert.deepEqual(
      (await client.listTools()).tools.map((tool) => tool.name),
      ["browser_command", "cua_status"],
    );
    brokerListening = false;
    assert.deepEqual((await client.listTools()).tools, [], "Desktop quit must hide tools again");
  } finally {
    await Promise.allSettled([client.close(), runtime.server.close()]);
    runtime.dispose();
  }
});

test("tools/list checks a real broker socket, not just a leftover token file", async () => {
  const directory = await mkdtemp(join(tmpdir(), "codez-mcp-discovery-"));
  const endpoint =
    process.platform === "win32"
      ? `\\\\.\\pipe\\codez-mcp-discovery-${process.pid}-${Date.now()}`
      : join(directory, "broker.sock");
  const tokenFile = join(directory, "broker.token");
  await writeFile(tokenFile, "fixture-token\n");
  const broker = createServer((socket) => socket.destroy());
  const runtime = createNativeBrowserCuaMcpRuntime({ endpoint, tokenFile });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "fixture", version: "0" });
  try {
    await Promise.all([runtime.server.connect(serverTransport), client.connect(clientTransport)]);
    assert.deepEqual((await client.listTools()).tools, [], "token alone is not sufficient");
    await new Promise<void>((resolve, reject) => {
      broker.once("error", reject);
      broker.listen(endpoint, () => {
        broker.off("error", reject);
        resolve();
      });
    });
    assert.deepEqual(
      (await client.listTools()).tools.map((tool) => tool.name),
      ["browser_command", "cua_status"],
    );
  } finally {
    await Promise.allSettled([client.close(), runtime.server.close()]);
    runtime.dispose();
    await new Promise<void>((resolve) => broker.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  }
});

test("native browser_command rejects disallowed methods before token or broker connection", async () => {
  let tokenReads = 0;
  let connections = 0;
  const runtime = createNativeBrowserCuaMcpRuntime({
    endpoint: "/fixture/native-browser.sock",
    tokenFile: "/fixture/native-browser.token",
    readFile: async () => {
      tokenReads += 1;
      return "fixture-token";
    },
    connect: () => {
      connections += 1;
      throw new Error("broker must not be contacted");
    },
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "fixture", version: "0" });
  await Promise.all([runtime.server.connect(serverTransport), client.connect(clientTransport)]);
  try {
    await assert.rejects(
      () => client.callTool({ name: "browser_command", arguments: { method: "evaluate" } }),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /allowed method/u);
        return true;
      },
    );
    assert.equal(tokenReads, 0);
    assert.equal(connections, 0);
  } finally {
    await Promise.allSettled([client.close(), runtime.server.close()]);
    runtime.dispose();
  }
});

test("native browser_command distinguishes token-read failure from broker connection failure", async () => {
  let tokenReads = 0;
  let connections = 0;
  const runtime = createNativeBrowserCuaMcpRuntime({
    endpoint: "/fixture/native-browser.sock",
    tokenFile: "/fixture/missing.token",
    readFile: async () => {
      tokenReads += 1;
      throw new Error("token read fixture failed");
    },
    connect: () => {
      connections += 1;
      throw new Error("broker connection fixture failed");
    },
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "fixture", version: "0" });
  await Promise.all([runtime.server.connect(serverTransport), client.connect(clientTransport)]);
  try {
    await assert.rejects(
      () => client.callTool({ name: "browser_command", arguments: { method: "getState" } }),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /token read fixture failed/u);
        return true;
      },
    );
    assert.equal(tokenReads, 1);
    assert.equal(connections, 0);
  } finally {
    await Promise.allSettled([client.close(), runtime.server.close()]);
    runtime.dispose();
  }
});

test("browser_command tool schema is a flat object covering every method's fields", async () => {
  const runtime = createNativeBrowserCuaMcpRuntime({
    endpoint: "/fixture/native-browser.sock",
    tokenFile: "/fixture/native-browser.token",
    readFile: async () => "fixture-token",
    connect: connectedBrokerSocket,
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "fixture", version: "0" });
  await Promise.all([runtime.server.connect(serverTransport), client.connect(clientTransport)]);
  try {
    const listed = await client.listTools();
    const tool = listed.tools.find((entry) => entry.name === "browser_command");
    assert.ok(tool, "browser_command tool must be listed");
    const schema = tool.inputSchema as {
      type?: unknown;
      required?: string[];
      additionalProperties?: boolean;
      properties?: Record<string, { type?: string; enum?: string[] }>;
    };
    // Codex 的工具管线会丢弃 oneOf/anyOf（GUI 实测：模型端只看到 {"type":"object"}），
    // 因此广告 schema 必须是扁平 object：method 枚举 + 全部字段平铺可选。
    assert.equal(schema.type, "object");
    assert.deepEqual(schema.required, ["method"]);
    assert.equal(schema.additionalProperties, false);
    const properties = schema.properties ?? {};
    assert.deepEqual(
      properties.method?.enum,
      [...NATIVE_BROWSER_CUA_MCP_BROWSER_METHODS],
      "method enum must list every exposed command",
    );
    for (const field of ["url", "ref", "value", "text", "key", "selector", "tabId"]) {
      assert.equal(properties[field]?.type, "string", `${field} must be declared as string`);
    }
    for (const field of ["x", "y", "scrollX", "scrollY", "timeoutMs", "maxElements"]) {
      // zod 的 int() 生成 integer，普通 number 生成 number；两者对调用方等价。
      assert.ok(
        ["number", "integer"].includes(properties[field]?.type ?? ""),
        `${field} must be declared as numeric`,
      );
    }
    for (const field of ["fullPage", "includeHidden", "checked", "accept", "doubleClick"]) {
      assert.equal(properties[field]?.type, "boolean", `${field} must be declared as boolean`);
    }
    // 同名字段跨方法形状冲突时收敛为公共类型而不是联合（联合会被 Codex 丢弃）。
    assert.equal(properties.text?.type, "string");
    assert.equal(Object.keys(properties).includes("oneOf"), false);
    // 描述里必须带逐方法字段速查，这是模型在扁平 schema 下的主要参数依据。
    assert.match(tool.description ?? "", /navigate\(url\)/u);
    assert.match(tool.description ?? "", /fill\(ref,value\)/u);
  } finally {
    await Promise.allSettled([client.close(), runtime.server.close()]);
    runtime.dispose();
  }
});

test("browser_command rejects schema-invalid arguments before token or broker connection", async () => {
  let tokenReads = 0;
  let connections = 0;
  const runtime = createNativeBrowserCuaMcpRuntime({
    endpoint: "/fixture/native-browser.sock",
    tokenFile: "/fixture/native-browser.token",
    readFile: async () => {
      tokenReads += 1;
      return "fixture-token";
    },
    connect: () => {
      connections += 1;
      throw new Error("broker must not be contacted");
    },
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "fixture", version: "0" });
  await Promise.all([runtime.server.connect(serverTransport), client.connect(clientTransport)]);
  try {
    await assert.rejects(
      () => client.callTool({ name: "browser_command", arguments: { method: "navigate" } }),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /arguments are invalid/u);
        return true;
      },
    );
    assert.equal(tokenReads, 0);
    assert.equal(connections, 0);
  } finally {
    await Promise.allSettled([client.close(), runtime.server.close()]);
    runtime.dispose();
  }
});

test("browser_command forwards a schema-valid command unchanged to the broker", async () => {
  let captured: unknown;
  class FakeSocket extends EventEmitter {
    destroy(): void {
      // broker 请求是短连接；测试里 destroy 只标记，不再触发额外事件。
    }
    write(data: string): boolean {
      captured = JSON.parse(data);
      queueMicrotask(() => this.emit("error", new Error("sentinel broker unreachable")));
      return true;
    }
  }
  const runtime = createNativeBrowserCuaMcpRuntime({
    endpoint: "/fixture/native-browser.sock",
    tokenFile: "/fixture/native-browser.token",
    readFile: async () => "fixture-token",
    connect: () => {
      const socket = new FakeSocket();
      queueMicrotask(() => socket.emit("connect"));
      return socket as unknown as Socket;
    },
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "fixture", version: "0" });
  await Promise.all([runtime.server.connect(serverTransport), client.connect(clientTransport)]);
  try {
    await assert.rejects(
      () =>
        client.callTool({
          name: "browser_command",
          arguments: { method: "navigate", url: "https://example.com/" },
        }),
      /sentinel broker unreachable/u,
    );
    const payload = captured as { id: string; token: string; command: unknown };
    assert.equal(typeof payload.id, "string");
    assert.equal(payload.token, "fixture-token");
    assert.deepEqual(payload.command, { method: "navigate", url: "https://example.com/" });
  } finally {
    await Promise.allSettled([client.close(), runtime.server.close()]);
    runtime.dispose();
  }
});

test("stdio entry serves a 2025-era (Codex dialect) initialize handshake and tools", async () => {
  // Codex 的 MCP 客户端以 2025-06-18 旧版握手（initialize 无 envelope 元数据）；
  // legacy:"reject" 会在握手阶段返回 -32022，该回归必须用传输级测试钉住。
  const clientToServer = new PassThrough();
  const serverToClient = new PassThrough();
  const server = startNativeBrowserCuaMcpStdio({
    endpoint: "/fixture/native-browser.sock",
    tokenFile: "/fixture/native-browser.token",
    readFile: async () => "fixture-token",
    connect: connectedBrokerSocket,
    transport: new StdioServerTransport(clientToServer, serverToClient),
  });

  let buffer = "";
  const pending = new Map<number, (message: Record<string, unknown>) => void>();
  serverToClient.on("data", (chunk: Buffer) => {
    buffer += chunk.toString("utf8");
    let index: number;
    while ((index = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (!line) continue;
      const message = JSON.parse(line) as Record<string, unknown>;
      const id = message.id;
      if (typeof id === "number" && pending.has(id)) {
        pending.get(id)!(message);
        pending.delete(id);
      }
    }
  });
  const send = (
    id: number,
    method: string,
    params: Record<string, unknown>,
  ): Promise<Record<string, unknown>> =>
    new Promise((resolve, reject) => {
      pending.set(id, resolve);
      clientToServer.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
      setTimeout(() => reject(new Error(`timeout waiting for ${method}`)), 5000);
    });

  try {
    const init = await send(1, "initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "legacy-fixture", version: "0" },
    });
    assert.ok(init.result, `legacy initialize must succeed, got ${JSON.stringify(init.error)}`);
    clientToServer.write(
      JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n",
    );
    const listed = await send(2, "tools/list", {});
    const tools = (listed.result as { tools: { name: string; inputSchema: unknown }[] }).tools;
    const browserTool = tools.find((tool) => tool.name === "browser_command");
    assert.ok(browserTool);
    const schema = browserTool.inputSchema as {
      type?: string;
      properties?: { method?: { enum?: string[] } };
    };
    assert.equal(schema.type, "object");
    assert.equal(
      schema.properties?.method?.enum?.length,
      NATIVE_BROWSER_CUA_MCP_BROWSER_METHODS.length,
    );
    const missingUrl = await send(3, "tools/call", {
      name: "browser_command",
      arguments: { method: "navigate" },
    });
    assert.match(JSON.stringify(missingUrl.error ?? missingUrl.result), /arguments are invalid/u);
  } finally {
    await server.close();
  }
});

test("cua_command is hidden and fails closed without local CUA broker credentials", async () => {
  const runtime = createNativeBrowserCuaMcpRuntime({
    endpoint: "/fixture/native-browser.sock",
    tokenFile: "/fixture/native-browser.token",
    readFile: async () => "fixture-token",
    connect: connectedBrokerSocket,
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "fixture", version: "0" });
  await Promise.all([runtime.server.connect(serverTransport), client.connect(clientTransport)]);
  try {
    assert.deepEqual(
      (await client.listTools()).tools.map((tool) => tool.name),
      ["browser_command", "cua_status"],
    );
    const status = await client.callTool({ name: "cua_status", arguments: {} });
    assert.equal(status.isError, undefined);
    const statusText = (status.content as { type: string; text: string }[])[0]?.text ?? "";
    assert.deepEqual(JSON.parse(statusText), {
      available: false,
      reason: "codez-cua.runtime_unavailable",
    });
    const commandResult = await client.callTool({
      name: "cua_command",
      arguments: { method: "list_apps" },
    });
    assert.equal(commandResult.isError, true);
  } finally {
    await Promise.allSettled([client.close(), runtime.server.close()]);
    runtime.dispose();
  }
});

test("cua_command exposes a flat schema and forwards validated commands and image blocks when local CUA broker is configured", async () => {
  let capturedBrokerFrame: Record<string, unknown> | undefined;
  class FakeCuaSocket extends EventEmitter {
    constructor(private readonly endpoint: string) {
      super();
    }
    destroy(): void {}
    write(data: string): boolean {
      if (this.endpoint === "/fixture/cua-broker.sock") {
        const frame = JSON.parse(data.trim()) as {
          id: string;
          method: string;
          capability: string;
          generation: number;
          params: Record<string, unknown>;
        };
        capturedBrokerFrame = frame;
        const result =
          frame.method === "permission_status"
            ? {
                platform: "darwin",
                accessibility: { state: "granted" },
                screen_recording: { state: "granted" },
              }
            : {
                content: [
                  { type: "image", data: "iVBORw0KGgoAAAANSUhEUg==", mimeType: "image/png" },
                  {
                    type: "text",
                    text: JSON.stringify({ state_id: "st-1", text: "Notes window" }),
                  },
                ],
                structuredContent: { state_id: "st-1", text: "Notes window" },
              };
        queueMicrotask(() => {
          this.emit("data", Buffer.from(`${JSON.stringify({ id: frame.id, ok: true, result })}\n`));
        });
      }
      return true;
    }
  }
  const cuaBroker = parseNativeCuaBrokerCredentials({
    CODEZ_CUA_PERMISSION_BROKER_SOCKET: "/fixture/cua-broker.sock",
    CODEZ_CUA_PLUGIN_AUTHORITY: "local-cua-authority",
    CODEZ_CUA_PERMISSION_BROKER_GENERATION: "3",
  });
  assert.deepEqual(cuaBroker, {
    socketPath: "/fixture/cua-broker.sock",
    capability: "local-cua-authority",
    generation: 3,
  });
  const runtime = createNativeBrowserCuaMcpRuntime({
    endpoint: "/fixture/native-browser.sock",
    tokenFile: "/fixture/native-browser.token",
    cuaBroker,
    readFile: async () => "fixture-token",
    connect: (endpoint) => {
      const socket = new FakeCuaSocket(endpoint);
      queueMicrotask(() => socket.emit("connect"));
      return socket as unknown as Socket;
    },
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "fixture", version: "0" });
  await Promise.all([runtime.server.connect(serverTransport), client.connect(clientTransport)]);
  try {
    const listed = await client.listTools();
    assert.deepEqual(
      listed.tools.map((tool) => tool.name),
      ["browser_command", "cua_status", "cua_command"],
    );
    const cuaTool = listed.tools.find((tool) => tool.name === "cua_command");
    assert.ok(cuaTool);
    const schema = cuaTool.inputSchema as {
      type?: string;
      required?: string[];
      properties?: Record<string, { enum?: string[] }>;
    };
    assert.equal(schema.type, "object");
    assert.deepEqual(schema.required, ["method"]);
    assert.deepEqual(schema.properties?.method?.enum, [...NATIVE_BROWSER_CUA_MCP_CUA_METHODS]);

    const status = await client.callTool({ name: "cua_status", arguments: {} });
    const statusPayload = JSON.parse(
      (status.content as { type: string; text: string }[])[0]?.text ?? "{}",
    ) as Record<string, unknown>;
    assert.equal(statusPayload.available, true);
    assert.equal(statusPayload.platform, "darwin");

    const stateResult = await client.callTool({
      name: "cua_command",
      arguments: {
        method: "get_app_state",
        app_ref: { name: "Notes" },
        include_screenshot: true,
      },
    });
    assert.equal(stateResult.isError, undefined);
    assert.equal(capturedBrokerFrame?.method, "execute");
    assert.equal(capturedBrokerFrame?.capability, "local-cua-authority");
    assert.equal(capturedBrokerFrame?.generation, 3);
    assert.deepEqual(capturedBrokerFrame?.params, {
      method: "get_app_state",
      input: { app_ref: { name: "Notes" }, include_screenshot: true },
      context: {
        workspaceKey: "native-browser-cua:local",
        sessionId: "codex-native-browser-cua",
        runtimeScope: "main",
      },
    });
    const blocks = stateResult.content as Array<{ type: string; data?: string; text?: string }>;
    assert.equal(blocks[0]?.type, "image");
    assert.equal(blocks[0]?.data, "iVBORw0KGgoAAAANSUhEUg==");
    assert.equal(blocks[1]?.type, "text");
  } finally {
    await Promise.allSettled([client.close(), runtime.server.close()]);
    runtime.dispose();
  }
});
