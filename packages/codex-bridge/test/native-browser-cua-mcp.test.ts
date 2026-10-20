import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, rm, writeFile, readFile as readFileReal } from "node:fs/promises";
import { createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { PassThrough } from "node:stream";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import {
  CODEZ_NATIVE_BROWSER_CUA_BROWSER_ENV,
  CODEZ_NATIVE_BROWSER_CUA_CUA_ENABLED_ENV,
  NATIVE_BROWSER_CUA_MCP_BROWSER_METHODS,
  NATIVE_BROWSER_CUA_MCP_CUA_METHODS,
} from "@codez/shared";
import {
  createNativeBrowserCuaMcpRuntime,
  nativeBrowserCuaEnvironment,
  parseNativeBrowserCuaFacts,
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
    browserEnabled: true,
    cuaEnabled: false,
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
      ["browser_command"],
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
  const runtime = createNativeBrowserCuaMcpRuntime({
    endpoint,
    tokenFile,
    browserEnabled: true,
    cuaEnabled: false,
  });
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
      ["browser_command"],
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
    browserEnabled: true,
    cuaEnabled: false,
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
    browserEnabled: true,
    cuaEnabled: false,
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
    browserEnabled: true,
    cuaEnabled: false,
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
    browserEnabled: true,
    cuaEnabled: false,
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
    browserEnabled: true,
    cuaEnabled: false,
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
    browserEnabled: true,
    cuaEnabled: false,
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

test("enabled CUA stays discoverable but fails closed before Helper credentials are ready", async () => {
  const runtime = createNativeBrowserCuaMcpRuntime({
    endpoint: "/fixture/native-browser.sock",
    tokenFile: "/fixture/native-browser.token",
    readFile: async () => "fixture-token",
    connect: connectedBrokerSocket,
    browserEnabled: true,
    cuaEnabled: true,
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "fixture", version: "0" });
  await Promise.all([runtime.server.connect(serverTransport), client.connect(clientTransport)]);
  try {
    // CUA 已启用但 Helper 凭据尚未就绪时，工具仍应广告；不可用在调用边界表达。
    assert.deepEqual(
      (await client.listTools()).tools.map((tool) => tool.name),
      ["browser_command", "cua_status", "cua_command"],
    );
    const status = await client.callTool({ name: "cua_status", arguments: {} });
    assert.equal(status.isError, undefined);
    const statusText = (status.content as { type: string; text: string }[])[0]?.text ?? "";
    assert.deepEqual(JSON.parse(statusText), {
      available: false,
      reason: "codez-cua.runtime_unavailable",
      retryable: false,
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
    browserEnabled: true,
    cuaEnabled: true,
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

test("native Browser/CUA tools and dispatch honor independent enablement flags", async () => {
  const browserConnections: string[] = [];
  const cuaConnections: string[] = [];
  const cuaBroker = parseNativeCuaBrokerCredentials({
    CODEZ_CUA_PERMISSION_BROKER_SOCKET: "/fixture/cua-broker.sock",
    CODEZ_CUA_PLUGIN_AUTHORITY: "local-cua-authority",
    CODEZ_CUA_PERMISSION_BROKER_GENERATION: "3",
  });
  const makeRuntime = (browserEnabled: boolean, cuaEnabled: boolean) =>
    createNativeBrowserCuaMcpRuntime({
      endpoint: "/fixture/native-browser.sock",
      tokenFile: "/fixture/native-browser.token",
      cuaBroker,
      readFile: async () => "fixture-token",
      connect: (endpoint) => {
        (endpoint === "/fixture/cua-broker.sock" ? cuaConnections : browserConnections).push(
          endpoint,
        );
        return connectedBrokerSocket();
      },
      browserEnabled,
      cuaEnabled,
    });

  const listNames = async (runtime: ReturnType<typeof makeRuntime>) => {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "fixture", version: "0" });
    await Promise.all([runtime.server.connect(serverTransport), client.connect(clientTransport)]);
    try {
      return (await client.listTools()).tools.map((tool) => tool.name);
    } finally {
      await Promise.allSettled([client.close(), runtime.server.close()]);
      runtime.dispose();
    }
  };

  assert.deepEqual(await listNames(makeRuntime(false, false)), []);
  assert.deepEqual(await listNames(makeRuntime(true, false)), ["browser_command"]);
  assert.deepEqual(await listNames(makeRuntime(false, true)), ["cua_status", "cua_command"]);
  assert.deepEqual(await listNames(makeRuntime(true, true)), [
    "browser_command",
    "cua_status",
    "cua_command",
  ]);
  browserConnections.length = 0;

  const browserDisabled = makeRuntime(false, true);
  const [browserClientTransport, browserServerTransport] = InMemoryTransport.createLinkedPair();
  const browserClient = new Client({ name: "fixture", version: "0" });
  await Promise.all([
    browserDisabled.server.connect(browserServerTransport),
    browserClient.connect(browserClientTransport),
  ]);
  try {
    const result = await browserClient.callTool({
      name: "browser_command",
      arguments: { method: "getState" },
    });
    assert.equal(result.isError, true);
    assert.match((result.content as { type: string; text: string }[])[0]?.text ?? "", /disabled/u);
  } finally {
    await Promise.allSettled([browserClient.close(), browserDisabled.server.close()]);
    browserDisabled.dispose();
  }

  const cuaDisabled = makeRuntime(true, false);
  const [cuaClientTransport, cuaServerTransport] = InMemoryTransport.createLinkedPair();
  const cuaClient = new Client({ name: "fixture", version: "0" });
  await Promise.all([
    cuaDisabled.server.connect(cuaServerTransport),
    cuaClient.connect(cuaClientTransport),
  ]);
  try {
    for (const name of ["cua_status", "cua_command"] as const) {
      const result = await cuaClient.callTool({
        name,
        arguments: name === "cua_command" ? { method: "list_apps" } : {},
      });
      assert.equal(result.isError, true);
      assert.match(
        (result.content as { type: string; text: string }[])[0]?.text ?? "",
        /disabled/u,
      );
    }
  } finally {
    await Promise.allSettled([cuaClient.close(), cuaDisabled.server.close()]);
    cuaDisabled.dispose();
  }

  assert.deepEqual(browserConnections, []);
  assert.deepEqual(cuaConnections, []);
});

test("native Browser/CUA environment parses explicit flags and preserves legacy defaults", () => {
  const baseEnv = {
    CODEZ_NATIVE_BROWSER_CUA_ENDPOINT: "/fixture/native-browser.sock",
    CODEZ_NATIVE_BROWSER_CUA_TOKEN_FILE: "/fixture/native-browser.token",
    CODEZ_CUA_PERMISSION_BROKER_SOCKET: "/fixture/cua-broker.sock",
    CODEZ_CUA_PLUGIN_AUTHORITY: "local-cua-authority",
    CODEZ_CUA_PERMISSION_BROKER_GENERATION: "7",
  };
  assert.deepEqual(nativeBrowserCuaEnvironment(baseEnv), {
    endpoint: "/fixture/native-browser.sock",
    tokenFile: "/fixture/native-browser.token",
    cuaBroker: {
      socketPath: "/fixture/cua-broker.sock",
      capability: "local-cua-authority",
      generation: 7,
    },
    browserEnabled: true,
    cuaEnabled: true,
    cuaGrantFile: undefined,
  });
  assert.deepEqual(
    nativeBrowserCuaEnvironment({
      ...baseEnv,
      [CODEZ_NATIVE_BROWSER_CUA_BROWSER_ENV]: "0",
      [CODEZ_NATIVE_BROWSER_CUA_CUA_ENABLED_ENV]: "0",
    }),
    {
      endpoint: "/fixture/native-browser.sock",
      tokenFile: "/fixture/native-browser.token",
      cuaBroker: {
        socketPath: "/fixture/cua-broker.sock",
        capability: "local-cua-authority",
        generation: 7,
      },
      browserEnabled: false,
      cuaEnabled: false,
      cuaGrantFile: undefined,
    },
  );
});

test("Host hello retains independent availability facts without reading Helper grants", () => {
  assert.deepEqual(
    parseNativeBrowserCuaFacts({
      CODEZ_NATIVE_BROWSER_CUA_BROWSER_AVAILABLE: "0",
      CODEZ_NATIVE_BROWSER_CUA_CUA_AVAILABLE: "1",
      CODEZ_NATIVE_BROWSER_CUA_CUA_ENABLED: "1",
    }),
    { browserAvailable: false, cuaAvailable: true },
  );
  assert.deepEqual(
    parseNativeBrowserCuaFacts({
      CODEZ_NATIVE_BROWSER_CUA_BROWSER_AVAILABLE: "1",
      CODEZ_NATIVE_BROWSER_CUA_CUA_AVAILABLE: "1",
      CODEZ_NATIVE_BROWSER_CUA_CUA_ENABLED: "0",
    }),
    { browserAvailable: true, cuaAvailable: false },
  );
});

test("browser-disabled CUA runtime starts without Main endpoint credentials", async () => {
  const runtime = createNativeBrowserCuaMcpRuntime({
    endpoint: "",
    tokenFile: "",
    cuaGrantFile: "/fixture/late-cua-grant.json",
    browserEnabled: false,
    cuaEnabled: true,
    readFile: async () => {
      const error = new Error("grant missing") as NodeJS.ErrnoException;
      error.code = "ENOENT";
      throw error;
    },
    connect: () => assert.fail("CUA warming must not connect the browser broker"),
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "fixture", version: "0" });
  await Promise.all([runtime.server.connect(serverTransport), client.connect(clientTransport)]);
  try {
    assert.deepEqual(
      (await client.listTools()).tools.map((tool) => tool.name),
      ["cua_status", "cua_command"],
    );
    const status = await client.callTool({ name: "cua_status", arguments: {} });
    assert.deepEqual(
      JSON.parse((status.content as { type: string; text: string }[])[0]?.text ?? "{}"),
      {
        available: false,
        reason: "codez-cua.runtime_warming",
        retryable: true,
      },
    );
  } finally {
    await Promise.allSettled([client.close(), runtime.server.close()]);
    runtime.dispose();
  }
});

test("CUA grant file is demand-read, validated, rotated and never consulted while disabled", async () => {
  const root = await mkdtemp(join(tmpdir(), "codez-cua-grant-"));
  const grantFile = join(root, "cua-grant.json");
  const frames: Record<string, unknown>[] = [];
  const endpoint =
    process.platform === "win32"
      ? `\\\\.\\pipe\\codez-cua-grant-${process.pid}-${Date.now()}`
      : join(root, "cua.sock");
  const server = createServer((socket) => {
    let buffer = "";
    socket.on("data", (chunk) => {
      buffer += chunk.toString();
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      const frame = JSON.parse(buffer.slice(0, newline)) as Record<string, unknown>;
      frames.push(frame);
      socket.end(`${JSON.stringify({ id: frame.id, ok: true, result: {} })}\n`);
    });
  });
  let fileReads = 0;
  let grantReadStarted!: () => void;
  const firstRead = new Promise<void>((resolve) => {
    grantReadStarted = resolve;
  });
  const runtime = createNativeBrowserCuaMcpRuntime({
    endpoint: "",
    tokenFile: "",
    cuaBroker: { socketPath: "/stale/socket", capability: "stale", generation: 0 },
    cuaGrantFile: grantFile,
    browserEnabled: false,
    cuaEnabled: true,
    readFile: async (path) => {
      assert.equal(path, grantFile, "CUA must not read browser credentials");
      fileReads += 1;
      grantReadStarted();
      return await readFileReal(path, "utf8");
    },
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "fixture", version: "0" });
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(endpoint, () => {
        server.off("error", reject);
        resolve();
      });
    });
    await Promise.all([runtime.server.connect(serverTransport), client.connect(clientTransport)]);
    assert.deepEqual(
      (await client.listTools()).tools.map((tool) => tool.name),
      ["cua_status", "cua_command"],
    );
    assert.equal(fileReads, 0, "tools/list must not warm the late grant file");

    const delayedStatus = client.callTool({ name: "cua_status", arguments: {} });
    await firstRead;
    await writeFile(
      grantFile,
      JSON.stringify({ socketPath: endpoint, capability: "auth-1", generation: 1 }),
    );
    const status = await delayedStatus;
    assert.equal(status.isError, undefined);
    assert.equal(frames.at(-1)?.capability, "auth-1");

    await writeFile(grantFile, JSON.stringify({ socketPath: endpoint, capability: "not-cua" }));
    const malformed = await client.callTool({ name: "cua_status", arguments: {} });
    assert.match(JSON.stringify(malformed), /generation/u);
    assert.equal(frames.length, 1, "invalid grant must not fall back to stale static credentials");

    await writeFile(
      grantFile,
      JSON.stringify({ socketPath: endpoint, capability: "auth-2", generation: 2 }),
    );
    await client.callTool({ name: "cua_status", arguments: {} });
    assert.equal(frames.at(-1)?.capability, "auth-2", "rotation must be reread on every call");

    const disabled = createNativeBrowserCuaMcpRuntime({
      endpoint: "",
      tokenFile: "",
      cuaGrantFile: grantFile,
      cuaEnabled: false,
      browserEnabled: false,
      readFile: async () => assert.fail("disabled CUA must not read grant"),
      connect: () => assert.fail("disabled CUA must not connect"),
    });
    const [disabledClientTransport, disabledServerTransport] = InMemoryTransport.createLinkedPair();
    const disabledClient = new Client({ name: "fixture", version: "0" });
    try {
      await Promise.all([
        disabled.server.connect(disabledServerTransport),
        disabledClient.connect(disabledClientTransport),
      ]);
      assert.deepEqual((await disabledClient.listTools()).tools, []);
      for (const name of ["cua_status", "cua_command"]) {
        const result = await disabledClient.callTool({
          name,
          arguments: name === "cua_command" ? { method: "list_apps" } : {},
        });
        assert.equal(result.isError, true);
      }
    } finally {
      disabled.dispose();
      await Promise.allSettled([disabledClient.close(), disabled.server.close()]);
    }
  } finally {
    runtime.dispose();
    await Promise.allSettled([client.close(), runtime.server.close()]);
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
});
