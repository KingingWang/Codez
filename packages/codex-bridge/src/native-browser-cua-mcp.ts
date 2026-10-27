import { createConnection, type Socket } from "node:net";
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { INVALID_PARAMS, Server, type Transport } from "@modelcontextprotocol/server";
import { z } from "zod";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import {
  CODEZ_CUA_BROKER_GRANT_FILE_ENV_KEY,
  CODEZ_NATIVE_BROWSER_CUA_BROWSER_ENV,
  CODEZ_NATIVE_BROWSER_CUA_CUA_ENV,
  CODEZ_NATIVE_BROWSER_CUA_CUA_ENABLED_ENV,
  CODEZ_NATIVE_BROWSER_CUA_ENDPOINT_ENV,
  CODEZ_NATIVE_BROWSER_CUA_TOKEN_FILE_ENV,
  nativeBrowserCuaMcpBrowserCommandJsonSchema,
  nativeBrowserCuaMcpBrowserCommandSchema,
  nativeBrowserCuaMcpBrowserMethodSchema,
  nativeBrowserCuaMcpCuaCommandSchema,
  nativeBrowserCuaMcpCuaMethodSchema,
  nativeBrowserCuaMcpResponseSchema,
  type NativeBrowserCuaMcpResponse,
} from "@codez/shared";
import {
  buildLocalCuaExecutePayload,
  CUA_DEFAULT_TIMEOUT_MS,
  CUA_GET_APP_STATE_TIMEOUT_MS,
  cuaCommandTool,
  normalizeCuaCallToolResult,
  parseNativeCuaBrokerCredentials,
  nativeCuaToolErrorResult,
  callNativeCuaBroker,
  callNativeCuaStatus,
  type NativeCuaBrokerCredentials,
} from "./native-cua-mcp.js";

export {
  parseNativeCuaBrokerCredentials,
  type NativeCuaBrokerCredentials,
} from "./native-cua-mcp.js";

const MAX_RESPONSE_BYTES = 32 * 1024 * 1024;

const browserTool = {
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
};

const cuaStatusTool = {
  name: "cua_status",
  description:
    "Report whether the Desktop Computer Use runtime and permission boundary are available.",
  inputSchema: { type: "object", additionalProperties: false, properties: {} } as const,
};

const nativeBrowserCuaToolNameSchema = z.enum(["browser_command", "cua_status", "cua_command"]);
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
  cuaBroker?: NativeCuaBrokerCredentials;
  cuaGrantFile?: string;
  browserEnabled: boolean;
  cuaEnabled: boolean;
} {
  const endpoint = env[CODEZ_NATIVE_BROWSER_CUA_ENDPOINT_ENV]?.trim();
  const tokenFile = env[CODEZ_NATIVE_BROWSER_CUA_TOKEN_FILE_ENV]?.trim();
  const browserEnabled = env[CODEZ_NATIVE_BROWSER_CUA_BROWSER_ENV] !== "0";
  // 浏览器显式关闭时，CUA 只需要本地 grant；不能因 Main browser endpoint 失败而拒绝启动。
  if (browserEnabled && (!endpoint || !tokenFile)) {
    throw new Error("Native Browser/CUA MCP endpoint configuration is unavailable");
  }
  const cuaBroker = parseNativeCuaBrokerCredentials(env);
  return {
    endpoint: endpoint ?? "",
    tokenFile: tokenFile ?? "",
    ...(cuaBroker ? { cuaBroker } : {}),
    cuaGrantFile: env[CODEZ_CUA_BROKER_GRANT_FILE_ENV_KEY]?.trim() || undefined,
    // 旧调用未显式注入开关时保持 Browser/CUA 均可用；Desktop 注入的显式 0 必须生效。
    browserEnabled,
    cuaEnabled: env[CODEZ_NATIVE_BROWSER_CUA_CUA_ENABLED_ENV] !== "0",
  };
}

export function parseNativeBrowserCuaFacts(env: NodeJS.ProcessEnv = process.env) {
  return {
    browserAvailable: env[CODEZ_NATIVE_BROWSER_CUA_BROWSER_ENV] === "1",
    cuaAvailable:
      env[CODEZ_NATIVE_BROWSER_CUA_CUA_ENV] === "1" &&
      env[CODEZ_NATIVE_BROWSER_CUA_CUA_ENABLED_ENV] !== "0",
  };
}

export function createNativeBrowserCuaMcpRuntime(input: {
  endpoint: string;
  tokenFile: string;
  cuaBroker?: NativeCuaBrokerCredentials;
  cuaGrantFile?: string;
  browserEnabled?: boolean;
  cuaEnabled?: boolean;
  readFile?: (path: string) => Promise<string>;
  connect?: (endpoint: string) => Socket;
}): { server: Server; dispose: () => void } {
  let disposed = false;
  const lifetime = new AbortController();
  const active = new Set<Socket>();
  const browserEnabled = input.browserEnabled ?? true;
  const cuaEnabled = input.cuaEnabled ?? true;
  const server = new Server(
    { name: "codez-desktop-browser-cua", version: "0.1.0" },
    { capabilities: { tools: {} } },
  );
  server.setRequestHandler("tools/list", async () => ({
    tools: [
      // Browser 工具绑定 Main broker 授权；CUA 工具只绑定本地 Helper 授权，二者互不渗透。
      ...(browserEnabled && (await desktopBrokerReachable()) ? [browserTool] : []),
      ...(cuaEnabled ? [cuaStatusTool, cuaCommandTool] : []),
    ],
  }));
  server.setRequestHandler("tools/call", async (request, extra) => {
    if (disposed) throw new Error("Native Browser/CUA MCP runtime is disposed");
    const toolName = parseNativeBrowserCuaToolName(request.params.name);
    if (toolName === "cua_status") {
      if (!cuaEnabled) return disabledToolResult("cua_status");
      return await callNativeCuaStatus({
        cuaBroker: input.cuaBroker,
        grantFile: input.cuaGrantFile,
        readFile: input.readFile,
        shouldContinue: () => !disposed,
        signal: AbortSignal.any([extra.mcpReq.signal, lifetime.signal]),
        timeoutMs: CUA_DEFAULT_TIMEOUT_MS,
        active,
        connect: input.connect,
      });
    }
    if (toolName === "cua_command") {
      if (!cuaEnabled) return disabledToolResult("cua_command");
      const args = request.params.arguments ?? {};
      if (
        !args ||
        typeof args !== "object" ||
        !nativeBrowserCuaMcpCuaMethodSchema.safeParse((args as { method?: unknown }).method).success
      ) {
        invalidParams("cua_command requires an allowed method");
      }
      const parsedCuaCommand = nativeBrowserCuaMcpCuaCommandSchema.safeParse(args);
      if (!parsedCuaCommand.success) {
        const issue = parsedCuaCommand.error.issues[0];
        invalidParams(
          issue
            ? `cua_command arguments are invalid: ${issue.path.join(".") || "command"}: ${issue.message}`
            : "cua_command arguments are invalid",
        );
      }
      const { method, ...cuaParams } = parsedCuaCommand.data;
      try {
        const result = await callNativeCuaBroker({
          cuaBroker: input.cuaBroker,
          grantFile: input.cuaGrantFile,
          readFile: input.readFile,
          shouldContinue: () => !disposed,
          method: "execute",
          params: buildLocalCuaExecutePayload(method, cuaParams),
          signal: AbortSignal.any([extra.mcpReq.signal, lifetime.signal]),
          timeoutMs:
            method === "get_app_state" ? CUA_GET_APP_STATE_TIMEOUT_MS : CUA_DEFAULT_TIMEOUT_MS,
          active,
          connect: input.connect,
        });
        return normalizeCuaCallToolResult(result);
      } catch (error) {
        return nativeCuaToolErrorResult(error);
      }
    }
    const args = request.params.arguments ?? {};
    if (!browserEnabled) {
      return {
        content: [
          {
            type: "text" as const,
            text: "Browser control is disabled by the user setting",
          },
        ],
        isError: true,
      };
    }
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
      lifetime.abort();
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

  function disabledToolResult(name: "cua_status" | "cua_command") {
    return {
      content: [
        {
          type: "text" as const,
          text: `${name} is disabled by the Computer Use plugin setting`,
        },
      ],
      isError: true,
    };
  }

  async function desktopBrokerReachable(): Promise<boolean> {
    if (!input.endpoint || !input.tokenFile) return false;
    try {
      await readToken();
      // 探测只连接，不发送命令或凭据；实际调用仍由 broker 校验 token。
      const socket = input.connect?.(input.endpoint) ?? createConnection(input.endpoint);
      return await new Promise<boolean>((resolve) => {
        let settled = false;
        const timeout = setTimeout(() => finish(false), 1_000);
        const finish = (reachable: boolean) => {
          if (settled) return;
          settled = true;
          clearTimeout(timeout);
          socket.destroy();
          resolve(reachable);
        };
        socket.once("connect", () => finish(true));
        socket.once("error", () => finish(false));
        socket.once("close", () => finish(false));
      });
    } catch {
      return false;
    }
  }

  async function sendBrokerRequest(
    payload: { id: string; token: string; command: unknown },
    signal: AbortSignal,
  ): Promise<NativeBrowserCuaMcpResponse> {
    const socket = input.connect?.(input.endpoint) ?? createConnection(input.endpoint);
    active.add(socket);
    return await new Promise((resolve, reject) => {
      // 修复原因：与 native-cua-mcp.ts 同一处缺陷——旧实现每个 chunk 都 `buffer += chunk.toString("utf8")`，
      // 跨 chunk 边界的多字节字符被解码成 U+FFFD；U+FFFD 在 JSON 字符串里合法，JSON.parse 不报错，
      // 于是乱码静默进入页面标题、无障碍树文本与错误信息并作为工具结果交给模型
      // （中文产品下实测 4000 个中文字符 + 8 MiB 截图响应，真实 Unix socket 上 40/40 次全部损坏）。
      // 同时 `Buffer.byteLength(buffer)` 与 `buffer.indexOf("\n")` 每 chunk 全量重扫，累计 O(n²)：
      // 32 MiB 响应阻塞 MCP 子进程事件循环约 8.5s，拖垮同一 server 上的其他请求并可能触发 MCP 超时。
      // 修复依据：按字节累积 chunk，只在新到的 chunk 内查找 0x0A —— ASCII 换行不可能出现在 UTF-8
      // 多字节序列内部（续字节 0x80-0xBF，首字节 0xC0 以上），字节扫描与旧的字符串扫描完全等价；
      // 取到完整帧后一次性解码，字符不可能跨边界。上限改用精确的已接收字节数，仍是 32 MiB fail-closed。
      const chunks: Buffer[] = [];
      let receivedBytes = 0;
      let frameComplete = false;
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
        if (frameComplete) return;
        chunks.push(chunk);
        receivedBytes += chunk.length;
        if (receivedBytes > MAX_RESPONSE_BYTES) {
          finish(new Error("Native Browser/CUA response exceeded the 32 MiB limit"));
          return;
        }
        const newline = chunk.indexOf(0x0a);
        if (newline < 0) return;
        frameComplete = true;
        const frame = Buffer.concat(chunks, receivedBytes)
          .subarray(0, receivedBytes - chunk.length + newline)
          .toString("utf8");
        try {
          const parsed = nativeBrowserCuaMcpResponseSchema.parse(JSON.parse(frame));
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
  cuaBroker?: NativeCuaBrokerCredentials;
  cuaGrantFile?: string;
  browserEnabled?: boolean;
  cuaEnabled?: boolean;
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
