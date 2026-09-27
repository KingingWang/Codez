import { createConnection, type Socket } from "node:net";
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { INVALID_PARAMS, Server, type Transport } from "@modelcontextprotocol/server";
import { z } from "zod";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import {
  CODEZ_NATIVE_BROWSER_CUA_BROWSER_ENV,
  CODEZ_NATIVE_BROWSER_CUA_CUA_ENV,
  CODEZ_NATIVE_BROWSER_CUA_ENDPOINT_ENV,
  CODEZ_NATIVE_BROWSER_CUA_TOKEN_FILE_ENV,
  CODEZ_NATIVE_BROWSER_CUA_UNAVAILABLE_REASON,
  nativeBrowserCuaMcpBrowserCommandJsonSchema,
  nativeBrowserCuaMcpBrowserCommandSchema,
  nativeBrowserCuaMcpBrowserMethodSchema,
  nativeBrowserCuaMcpResponseSchema,
  type NativeBrowserCuaMcpResponse,
} from "@codez/shared";

const MAX_RESPONSE_BYTES = 32 * 1024 * 1024;

const tools = [
  {
    name: "browser_command",
    // 字段速查表必须留在描述里：部分客户端（含 Codex）会丢弃 JSON Schema 联合，
    // 模型主要依据这里的说明组装参数；缺字段时桥接层会返回带字段路径的精确错误。
    description:
      "Run one validated command against the Desktop-owned in-app browser. " +
      "Prefer getState/snapshot before acting. " +
      "Per-method fields: navigate(url); click(ref or x,y); fill(ref,value); type(ref,text); " +
      "press(key[,ref]); select(ref,values); check(ref[,checked]); hover(ref or x,y); " +
      "scroll([ref or x,y]); cuaScroll(x,y,scrollX,scrollY); domCuaScroll(scrollX,scrollY[,nodeId]); " +
      "drag(fromRef/from,toRef/to); cuaDrag(path); screenshot([ref|fullPage|clip]); " +
      "elementInfo(x,y); waitFor(selector|text|textGone[,timeoutMs]); " +
      "getDialog(); handleDialog(accept[,promptText]); snapshot(); getState(); " +
      "back/forward/reload take no extra fields. tabId is always optional.",
    inputSchema: nativeBrowserCuaMcpBrowserCommandJsonSchema,
  },
  {
    name: "cua_status",
    description:
      "Report whether the Desktop Computer Use runtime and permission boundary are available.",
    inputSchema: { type: "object", additionalProperties: false, properties: {} } as const,
  },
];

const nativeBrowserCuaToolNameSchema = z.enum(["browser_command", "cua_status"]);
const parseNativeBrowserCuaToolName = (
  value: unknown,
): z.infer<typeof nativeBrowserCuaToolNameSchema> => {
  const parsed = nativeBrowserCuaToolNameSchema.safeParse(value);
  if (!parsed.success) invalidParams("Tool not found");
  return parsed.data;
};

export function nativeBrowserCuaEnvironment(env: NodeJS.ProcessEnv = process.env): {
  endpoint: string;
  tokenFile: string;
} {
  const endpoint = env[CODEZ_NATIVE_BROWSER_CUA_ENDPOINT_ENV]?.trim();
  const tokenFile = env[CODEZ_NATIVE_BROWSER_CUA_TOKEN_FILE_ENV]?.trim();
  if (!endpoint || !tokenFile) {
    throw new Error("Native Browser/CUA MCP endpoint configuration is unavailable");
  }
  return { endpoint, tokenFile };
}

export function parseNativeBrowserCuaFacts(env: NodeJS.ProcessEnv = process.env): {
  browserAvailable: boolean;
  cuaAvailable: boolean;
} {
  return {
    browserAvailable: env[CODEZ_NATIVE_BROWSER_CUA_BROWSER_ENV] === "1",
    cuaAvailable: env[CODEZ_NATIVE_BROWSER_CUA_CUA_ENV] === "1",
  };
}

export function createNativeBrowserCuaMcpRuntime(input: {
  endpoint: string;
  tokenFile: string;
  readFile?: (path: string) => Promise<string>;
  connect?: (endpoint: string) => Socket;
}): { server: Server; dispose: () => void } {
  let disposed = false;
  const active = new Set<Socket>();
  const server = new Server(
    { name: "codez-desktop-browser-cua", version: "0.1.0" },
    { capabilities: { tools: {} } },
  );
  server.setRequestHandler("tools/list", async () => ({ tools }));
  server.setRequestHandler("tools/call", async (request, extra) => {
    if (disposed) throw new Error("Native Browser/CUA MCP runtime is disposed");
    const toolName = parseNativeBrowserCuaToolName(request.params.name);
    if (toolName === "cua_status") {
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              available: false,
              reason: CODEZ_NATIVE_BROWSER_CUA_UNAVAILABLE_REASON,
            }),
          },
        ],
      };
    }
    const args = request.params.arguments ?? {};
    if (
      !args ||
      typeof args !== "object" ||
      !nativeBrowserCuaMcpBrowserMethodSchema.safeParse((args as { method?: unknown }).method)
        .success
    )
      invalidParams("browser_command requires an allowed method");
    // 与 broker 同源的整体校验：字段缺失/多余时在读取 token、连接 broker 之前失败，
    // 让调用方（Codex）立刻拿到带字段路径的参数错误，而不是含糊的下游失败。
    const parsedCommand = nativeBrowserCuaMcpBrowserCommandSchema.safeParse(args);
    if (!parsedCommand.success) {
      const issue = parsedCommand.error.issues[0];
      invalidParams(
        issue
          ? `browser_command arguments are invalid: ${issue.path.join(".") || "command"}: ${issue.message}`
          : "browser_command arguments are invalid",
      );
    }
    const response = await sendBrokerRequest(
      {
        id: randomUUID(),
        token: await readToken(),
        command: parsedCommand.data,
      },
      extra.mcpReq.signal,
    );
    if (!response.ok) {
      return {
        content: [{ type: "text" as const, text: response.message }],
        isError: true,
      };
    }
    return { structuredContent: response.result, content: [] };
  });
  return {
    server,
    dispose: () => {
      disposed = true;
      for (const socket of active) socket.destroy();
      active.clear();
    },
  };

  async function readToken(): Promise<string> {
    const token = input.readFile
      ? await input.readFile(input.tokenFile)
      : await readFile(input.tokenFile, "utf8");
    const trimmed = token.trim();
    if (!trimmed) throw new Error("Native Browser/CUA token file is empty");
    return trimmed;
  }

  async function sendBrokerRequest(
    payload: { id: string; token: string; command: unknown },
    signal: AbortSignal,
  ): Promise<NativeBrowserCuaMcpResponse> {
    const socket = input.connect?.(input.endpoint) ?? createConnection(input.endpoint);
    active.add(socket);
    return await new Promise((resolve, reject) => {
      let buffer = "";
      let settled = false;
      const finish = (error?: unknown, value?: NativeBrowserCuaMcpResponse) => {
        if (settled) return;
        settled = true;
        active.delete(socket);
        socket.destroy();
        if (error) reject(error);
        else if (value?.ok) resolve(value);
        else
          reject(
            new Error(value && !value.ok ? value.message : "Native broker returned no result"),
          );
      };
      const onAbort = () => finish(signal.reason ?? new DOMException("aborted", "AbortError"));
      signal.addEventListener("abort", onAbort, { once: true });
      socket.once("connect", () => socket.write(`${JSON.stringify(payload)}\n`));
      socket.on("data", (chunk: Buffer) => {
        buffer += chunk.toString("utf8");
        if (Buffer.byteLength(buffer) > MAX_RESPONSE_BYTES) {
          finish(new Error("Native Browser/CUA response exceeded the 32 MiB limit"));
          return;
        }
        const newline = buffer.indexOf("\n");
        if (newline < 0) return;
        try {
          const parsed = nativeBrowserCuaMcpResponseSchema.parse(
            JSON.parse(buffer.slice(0, newline)),
          );
          if (parsed.id !== payload.id) throw new Error("Native broker response id mismatch");
          finish(undefined, parsed);
        } catch (error) {
          finish(error);
        }
      });
      socket.once("error", finish);
      socket.once("close", () => {
        if (!settled) finish(new Error("Native broker closed before returning a response"));
      });
      if (signal.aborted) onAbort();
    });
  }
}

export type NativeBrowserCuaMcpStdioOptions = {
  endpoint: string;
  tokenFile: string;
  readFile?: (path: string) => Promise<string>;
  connect?: (endpoint: string) => Socket;
  transport?: Transport;
};

export function startNativeBrowserCuaMcpStdio(input: NativeBrowserCuaMcpStdioOptions): {
  close(): Promise<void>;
} {
  const runtime = createNativeBrowserCuaMcpRuntime(input);
  // 修复依据：Codex 的 MCP 客户端目前以 2025-06-18 旧版握手（initialize 无 envelope
  // 元数据），legacy:"reject" 会在握手阶段直接拒绝（-32022 unsupported protocol
  // version），表现为 MCP startup failed、工具列表恒为 0。legacy:"serve" 让同一
  // 工厂同时服务旧版与现代客户端，二者共享同一份工具定义与校验逻辑。
  const handle = serveStdio(() => runtime.server, {
    legacy: "serve",
    ...(input.transport ? { transport: input.transport } : {}),
  });
  let stopped = false;
  const close = async () => {
    if (stopped) return;
    stopped = true;
    runtime.dispose();
    await handle.close();
  };
  return { close };
}

export async function runNativeBrowserCuaMcp(): Promise<void> {
  const server = startNativeBrowserCuaMcpStdio(nativeBrowserCuaEnvironment());
  let stopped = false;
  const stop = () => {
    if (stopped) return;
    stopped = true;
    void server.close().finally(() => process.exit(0));
  };
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
  process.stdin.once("end", stop);
  process.stdin.once("error", stop);
}

export function invalidParams(message: string): never {
  throw Object.assign(new Error(message), { code: INVALID_PARAMS });
}
