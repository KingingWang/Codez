import { z } from "zod";
import { browserCommandSchema } from "./commands.js";
import { browserCommandResultSchema } from "./result.js";

export const CODEZ_NATIVE_BROWSER_CUA_MCP_SERVER_NAME = "codez-desktop-browser-cua";
export const CODEZ_NATIVE_BROWSER_CUA_MCP_ENTRY_MODE = "native-browser-cua-mcp";
export const CODEZ_NATIVE_BROWSER_CUA_ENDPOINT_ENV = "CODEZ_NATIVE_BROWSER_CUA_ENDPOINT";
export const CODEZ_NATIVE_BROWSER_CUA_TOKEN_FILE_ENV = "CODEZ_NATIVE_BROWSER_CUA_TOKEN_FILE";
export const CODEZ_NATIVE_BROWSER_CUA_BROWSER_ENV = "CODEZ_NATIVE_BROWSER_CUA_BROWSER_AVAILABLE";
export const CODEZ_NATIVE_BROWSER_CUA_CUA_ENV = "CODEZ_NATIVE_BROWSER_CUA_CUA_AVAILABLE";
export const CODEZ_NATIVE_BROWSER_CUA_ENDPOINT_PREFIX = "codez-native-browser-cua";
export const CODEZ_NATIVE_BROWSER_CUA_UNAVAILABLE_REASON = "codez-cua.runtime_unavailable";
export const NATIVE_BROWSER_CUA_MCP_BROWSER_METHODS = [
  "navigate",
  "back",
  "forward",
  "reload",
  "snapshot",
  "click",
  "fill",
  "type",
  "press",
  "cuaKeypress",
  "scroll",
  "cuaScroll",
  "domCuaScroll",
  "hover",
  "select",
  "check",
  "drag",
  "cuaDrag",
  "screenshot",
  "getState",
  "elementInfo",
  "getDialog",
  "handleDialog",
  "waitFor",
] as const;
// native broker 创建的浏览器 tab 的 synthetic owner scope：MCP server 是全局配置，
// 不绑定任何 Codez 会话，Desktop main 与 renderer 共用这两个标记识别「窗口级」原生
// 浏览器 tab（spec: codex-desktop-native-browser-cua「Side pane surfacing」）。
export const NATIVE_BROWSER_CUA_SESSION_ID = "codex-native-browser-cua";
export const NATIVE_BROWSER_CUA_WORKSPACE_KEY_PREFIX = "native-browser-cua:";

export const nativeBrowserCuaMcpBrowserMethodSchema = z.enum(
  NATIVE_BROWSER_CUA_MCP_BROWSER_METHODS,
);
export type NativeBrowserCuaMcpBrowserMethod = z.infer<
  typeof nativeBrowserCuaMcpBrowserMethodSchema
>;

// 修复依据：此前桥接层手写的 MCP inputSchema 只声明了 method 字段，Codex 无法构造
// navigate(url)、fill(ref,value) 等合法调用（模型按声明的参数生成调用）。这里直接从
// browserCommandSchema 过滤出允许暴露的方法，桥接层快速校验与对外 JSON Schema 都从该
// 子集派生，声明与校验共享同一事实源，不再漂移。
const nativeBrowserCuaMcpAllowedMethodSet: ReadonlySet<string> = new Set(
  NATIVE_BROWSER_CUA_MCP_BROWSER_METHODS,
);

function browserCommandOptionMethod(option: z.ZodType): string | undefined {
  const shape = (option.def as { shape?: Record<string, { def?: { values?: unknown[] } }> }).shape;
  const values = shape?.method?.def?.values;
  const method = Array.isArray(values) && values.length === 1 ? values[0] : undefined;
  return typeof method === "string" ? method : undefined;
}

const nativeBrowserCuaMcpBrowserCommandOptions = browserCommandSchema.options.filter((option) =>
  nativeBrowserCuaMcpAllowedMethodSet.has(browserCommandOptionMethod(option) ?? ""),
);

if (
  nativeBrowserCuaMcpBrowserCommandOptions.length !==
    NATIVE_BROWSER_CUA_MCP_BROWSER_METHODS.length ||
  NATIVE_BROWSER_CUA_MCP_BROWSER_METHODS.some(
    (method) =>
      !nativeBrowserCuaMcpBrowserCommandOptions.some(
        (option) => browserCommandOptionMethod(option) === method,
      ),
  )
) {
  // 允许列表与命令协议漂移属于编程错误，必须在模块加载时失败，不能静默降级为错误工具声明。
  throw new Error("native Browser/CUA MCP methods drifted from browserCommandSchema");
}

// 上方不变量已保证过滤结果非空；这里仅把数组收窄为 zod 要求的非空元组类型。
type BrowserCommandOption = (typeof browserCommandSchema.options)[number];
export const nativeBrowserCuaMcpBrowserCommandSchema = z.discriminatedUnion(
  "method",
  nativeBrowserCuaMcpBrowserCommandOptions as [BrowserCommandOption, ...BrowserCommandOption[]],
);

type BrowserCommandJsonVariant = { properties?: Record<string, Record<string, unknown>> };

// 修复依据（GUI 实测证据）：Codex 的工具管线会丢弃 oneOf/anyOf 联合，模型端只看到
// {"type":"object"} 且没有任何 properties，于是无论想传什么，最终 arguments 都被清空为
// {}。因此对外广告 schema 必须是扁平 object：method 枚举 + 全部字段平铺可选。
// 各方法的必填约束由工具描述说明，并由桥接层/broker 的 zod 联合严格校验兜底。
function mergeBrowserCommandProperty(
  existing: Record<string, unknown> | undefined,
  incoming: Record<string, unknown>,
): Record<string, unknown> {
  if (!existing) return incoming;
  if (JSON.stringify(existing) === JSON.stringify(incoming)) return existing;
  // 同名不同形（例如 type.text 与 waitFor.text 的 minLength 差异）：收敛为公共类型，
  // 不产生 oneOf/anyOf（会被 Codex 管线丢弃）；严格性由运行时校验保证。
  if (typeof existing.type === "string" && existing.type === incoming.type)
    return { type: existing.type };
  return {};
}

const generatedNativeBrowserCuaMcpBrowserCommandJsonSchema = z.toJSONSchema(
  nativeBrowserCuaMcpBrowserCommandSchema,
  { io: "input", reused: "inline" },
);

const nativeBrowserCuaMcpBrowserCommandProperties: Record<string, Record<string, unknown>> = {
  method: { type: "string", enum: [...NATIVE_BROWSER_CUA_MCP_BROWSER_METHODS] },
};
for (const variant of (
  generatedNativeBrowserCuaMcpBrowserCommandJsonSchema as { oneOf?: BrowserCommandJsonVariant[] }
).oneOf ?? []) {
  for (const [key, property] of Object.entries(variant.properties ?? {})) {
    if (key === "method") continue;
    nativeBrowserCuaMcpBrowserCommandProperties[key] = mergeBrowserCommandProperty(
      nativeBrowserCuaMcpBrowserCommandProperties[key],
      property,
    );
  }
}

// MCP 工具入参顶层必须是 object（客户端按此解析 tools/list）。properties 来自上方同一
// zod 联合的扁平合并，required 只保留 method；逐方法必填字段由校验错误信息精确反馈。
export const nativeBrowserCuaMcpBrowserCommandJsonSchema: {
  type: "object";
  [key: string]: unknown;
} = {
  type: "object",
  properties: nativeBrowserCuaMcpBrowserCommandProperties,
  required: ["method"],
  additionalProperties: false,
};

export const nativeBrowserCuaMcpErrorSchema = z.enum([
  "invalid_request",
  "authentication_failed",
  "backend_unavailable",
]);
export type NativeBrowserCuaMcpError = z.infer<typeof nativeBrowserCuaMcpErrorSchema>;

const absolutePathSchema = z.string().trim().min(1).max(4_096);

export const nativeBrowserCuaMcpRequestSchema = z
  .object({
    id: z.string().uuid(),
    token: z.string().min(32).max(256),
    browserId: z.string().trim().min(1).max(256).optional(),
    browserGeneration: z.number().int().nonnegative().optional(),
    command: browserCommandSchema.superRefine((command, ctx) => {
      if (!nativeBrowserCuaMcpBrowserMethodSchema.safeParse(command.method).success)
        ctx.addIssue({
          code: "custom",
          path: ["method"],
          message: "Browser command method is not exposed by native Browser/CUA MCP",
        });
    }),
  })
  .strict();
export type NativeBrowserCuaMcpRequest = z.infer<typeof nativeBrowserCuaMcpRequestSchema>;

export const nativeBrowserCuaMcpResponseSchema = z.discriminatedUnion("ok", [
  z
    .object({
      id: z.string().uuid(),
      ok: z.literal(true),
      result: browserCommandResultSchema,
    })
    .strict(),
  z
    .object({
      id: z.string().uuid(),
      ok: z.literal(false),
      error: nativeBrowserCuaMcpErrorSchema,
      message: z.string().min(1).max(2_000),
    })
    .strict(),
]);
export type NativeBrowserCuaMcpResponse = z.infer<typeof nativeBrowserCuaMcpResponseSchema>;

export const nativeBrowserCuaMcpStatusSchema = z
  .object({
    browser: z.boolean(),
    cua: z.boolean(),
    cuaReason: z.string().trim().min(1).max(500).optional(),
  })
  .strict();
export type NativeBrowserCuaMcpStatus = z.infer<typeof nativeBrowserCuaMcpStatusSchema>;

export const nativeBrowserCuaMcpDescriptorSchema = z
  .object({
    runtimeInstalled: z.boolean(),
    serviceRunning: z.boolean(),
    executable: absolutePathSchema,
    bridgePath: absolutePathSchema,
    endpoint: absolutePathSchema,
    tokenFile: absolutePathSchema,
    browserAvailable: z.boolean(),
    cuaAvailable: z.boolean(),
    cuaReason: z.string().trim().min(1).max(500).optional(),
  })
  .strict();
export type NativeBrowserCuaMcpDescriptor = z.infer<typeof nativeBrowserCuaMcpDescriptorSchema>;

export const nativeBrowserCuaMcpRuntimeMissingDescriptorSchema = z
  .object({
    runtimeInstalled: z.literal(false),
    serviceRunning: z.literal(false),
    executable: z.string().trim().min(1).max(4_096),
    browserAvailable: z.literal(false),
    cuaAvailable: z.literal(false),
    cuaReason: z.string().trim().min(1).max(500),
  })
  .strict();
export type NativeBrowserCuaMcpRuntimeMissingDescriptor = z.infer<
  typeof nativeBrowserCuaMcpRuntimeMissingDescriptorSchema
>;
export const nativeBrowserCuaMcpDescriptorResultSchema = z.union([
  nativeBrowserCuaMcpDescriptorSchema,
  nativeBrowserCuaMcpRuntimeMissingDescriptorSchema,
]);
export type NativeBrowserCuaMcpDescriptorResult = z.infer<
  typeof nativeBrowserCuaMcpDescriptorResultSchema
>;

export function nativeBrowserCuaMcpEndpointPath(input: {
  platform?: NodeJS.Platform | string;
  flavor?: string;
  userDataPath?: string;
  temporaryDirectory?: string;
}): string {
  const flavor = (input.flavor ?? "").replace(/[^a-z0-9-]/giu, "").toLowerCase() || "default";
  if (input.platform === "win32") {
    return `\\\\.\\pipe\\${CODEZ_NATIVE_BROWSER_CUA_ENDPOINT_PREFIX}-${flavor}`;
  }
  const root = input.temporaryDirectory ?? input.userDataPath ?? "";
  return `${root.replace(/[\\/]$/u, "")}/${CODEZ_NATIVE_BROWSER_CUA_ENDPOINT_PREFIX}-${flavor}.sock`;
}

export function nativeBrowserCuaMcpTokenFilePath(input: {
  flavor?: string;
  userDataPath: string;
  windowId?: number;
}): string {
  if (
    input.windowId !== undefined &&
    (!Number.isSafeInteger(input.windowId) || input.windowId < 0)
  ) {
    throw new Error("Native Browser/CUA window id must be a nonnegative safe integer");
  }
  const flavor = (input.flavor ?? "").replace(/[^a-z0-9-]/giu, "").toLowerCase() || "default";
  const windowId = input.windowId === undefined ? "" : `-${input.windowId}`;
  return `${input.userDataPath.replace(/[\\/]$/u, "")}/${CODEZ_NATIVE_BROWSER_CUA_ENDPOINT_PREFIX}-${flavor}${windowId}.token`;
}

// ---- Remote workspace relay（spec: codex-desktop-native-browser-cua「Remote workspace relay」）----
// 远端 codez server 在本机提供 relay socket，把浏览器命令经既有窗口 RPC 通道转发回桌面
// 窗口 Host；窗口 token 不出桌面进程，远端只用自签发的 remote-local token 保护 bridge→relay 跳。
export const NATIVE_BROWSER_CUA_RELAY_ENDPOINT_PREFIX = "codez-native-browser-cua-relay";
/** 与 Main broker 相同：单请求帧上限 1 MiB。 */
export const NATIVE_BROWSER_CUA_RELAY_REQUEST_MAX_BYTES = 1024 * 1024;
/** 与 bridge MCP 相同：单响应帧上限 32 MiB（截图内联 base64）。 */
export const NATIVE_BROWSER_CUA_RELAY_RESPONSE_MAX_BYTES = 32 * 1024 * 1024;

/** remote → desktop 的中继请求事件载荷；payload 是原始 broker 请求行（不含换行）。 */
export const desktopBrowserCommandRelayRequestSchema = z
  .object({
    requestId: z.string().uuid(),
    payload: z.string().min(1).max(NATIVE_BROWSER_CUA_RELAY_REQUEST_MAX_BYTES),
  })
  .strict();
export type DesktopBrowserCommandRelayRequest = z.infer<
  typeof desktopBrowserCommandRelayRequestSchema
>;

/** desktop → remote 的中继响应载荷；payload 是原始 broker 响应行（不含换行）。 */
export const desktopBrowserCommandRelayResponseSchema = z
  .object({
    requestId: z.string().uuid(),
    payload: z.string().min(1).max(NATIVE_BROWSER_CUA_RELAY_RESPONSE_MAX_BYTES),
  })
  .strict();
export type DesktopBrowserCommandRelayResponse = z.infer<
  typeof desktopBrowserCommandRelayResponseSchema
>;

/** desktop → remote：授予/撤销桌面内置浏览器能力。 */
export const desktopBrowserControlUpdateSchema = z
  .object({
    enabled: z.boolean(),
  })
  .strict();
export type DesktopBrowserControlUpdate = z.infer<typeof desktopBrowserControlUpdateSchema>;

/**
 * relay socket 路径按进程隔离：同一台远端机器可能被多个桌面窗口（甚至多个桌面实例）
 * 同时连接，确定性共享路径会互相顶掉；注册清单按 spawn 从活跃 holder 读取，pid 路径天然一致。
 */
export function nativeBrowserCuaRelayEndpointPath(input: {
  platform?: NodeJS.Platform | string;
  processId: number;
  temporaryDirectory?: string;
}): string {
  if (!Number.isSafeInteger(input.processId) || input.processId < 0) {
    throw new Error("Native Browser/CUA relay process id must be a nonnegative safe integer");
  }
  if (input.platform === "win32") {
    return `\\\\.\\pipe\\${NATIVE_BROWSER_CUA_RELAY_ENDPOINT_PREFIX}-${input.processId}`;
  }
  const root = (input.temporaryDirectory ?? "").replace(/[\\/]$/u, "");
  return `${root}/${NATIVE_BROWSER_CUA_RELAY_ENDPOINT_PREFIX}-${input.processId}.sock`;
}

/** remote-local token 文件路径：位于远端数据目录（0600），不进入任何配置或日志。 */
export function nativeBrowserCuaRelayTokenFilePath(input: {
  dataDirectory: string;
  processId: number;
}): string {
  if (!Number.isSafeInteger(input.processId) || input.processId < 0) {
    throw new Error("Native Browser/CUA relay process id must be a nonnegative safe integer");
  }
  return `${input.dataDirectory.replace(/[\\/]$/u, "")}/${NATIVE_BROWSER_CUA_RELAY_ENDPOINT_PREFIX}-${input.processId}.token`;
}
