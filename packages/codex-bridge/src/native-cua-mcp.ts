import { createConnection, type Socket } from "node:net";
import { randomUUID } from "node:crypto";
import {
  CODEZ_CUA_BROKER_SOCKET_ENV_KEY,
  CODEZ_NATIVE_BROWSER_CUA_UNAVAILABLE_REASON,
  nativeBrowserCuaMcpCuaCommandJsonSchema,
  NATIVE_BROWSER_CUA_SESSION_ID,
  NATIVE_BROWSER_CUA_WORKSPACE_KEY_PREFIX,
} from "@codez/shared";

const MAX_RESPONSE_BYTES = 32 * 1024 * 1024;
const CUA_BROKER_PROTOCOL_ID = "codez.cua/broker";
const CUA_BROKER_PROTOCOL_VERSION = 1;
const CUA_BROKER_CAPABILITY_ENV_KEY = "CODEZ_CUA_PERMISSION_BROKER_CAPABILITY";
const CUA_PLUGIN_AUTHORITY_ENV_KEY = "CODEZ_CUA_PLUGIN_AUTHORITY";
const CUA_BROKER_GENERATION_ENV_KEY = "CODEZ_CUA_PERMISSION_BROKER_GENERATION";
export const CUA_DEFAULT_TIMEOUT_MS = 10_000;
export const CUA_GET_APP_STATE_TIMEOUT_MS = 30_000;

export interface NativeCuaBrokerCredentials {
  socketPath: string;
  capability: string;
  generation: number;
}

export const cuaCommandTool = {
  name: "cua_command",
  description:
    "Run one validated Computer Use command against local desktop applications. " +
    "Prefer accessibility observation (get_app_state) and element indices before coordinate actions. " +
    "Per-method fields: list_apps(); list_windows(app_ref); " +
    "get_app_state(app_ref[,include_screenshot,disable_diffing,tree_shown_to_model]); " +
    "left_click(target[,mouse_button,click_count,modifiers,strategy,app_ref,return_state]); " +
    "left_click_drag(from_target,to[,modifiers,app_ref,return_state]); " +
    "scroll(target,scroll_direction,scroll_amount[,strategy,app_ref,return_state]); " +
    "type(text[,target,app_ref,strategy,return_state]); " +
    "set_value(target,value[,strategy,app_ref,return_state]); " +
    "select_text(target[,text_range,app_ref,return_state]); " +
    "key(text[,repeat,hold_seconds,app_ref,strategy,return_state]); " +
    "paste(text[,format,app_ref,return_state]); " +
    "perform_action(target,action[,app_ref,return_state]); " +
    "request_access([capabilities]); stop_computer_control([reason]). " +
    "app_ref is {name?,bundle_id?,pid?,window_id?}. " +
    // 修复依据：明确 JSON 字面量，避免调用方把元素 index 或坐标数组编码成字符串。
    'target/from_target/to are JSON values: an integer, [x,y], {"type":"element","index":7}, ' +
    'or {"type":"coordinate","x":40,"y":60} (optional frame_id must come from an observed frame). ' +
    'Examples: {"method":"left_click","target":7}; {"method":"left_click","target":[40,60]}; ' +
    '{"method":"left_click_drag","from_target":7,"to":[40,60]}. ' +
    "Do not quote or JSON-stringify targets. Use only the listed desktop methods; " +
    "browser_command is a separate tool with a different schema.",
  inputSchema: nativeBrowserCuaMcpCuaCommandJsonSchema,
};

export function parseNativeCuaBrokerCredentials(
  env: NodeJS.ProcessEnv = process.env,
): NativeCuaBrokerCredentials | undefined {
  const socketPath = env[CODEZ_CUA_BROKER_SOCKET_ENV_KEY]?.trim();
  const capability =
    env[CUA_BROKER_CAPABILITY_ENV_KEY]?.trim() || env[CUA_PLUGIN_AUTHORITY_ENV_KEY]?.trim();
  const rawGeneration = env[CUA_BROKER_GENERATION_ENV_KEY]?.trim();
  const generation =
    rawGeneration === undefined || rawGeneration === "" ? 0 : Number(rawGeneration);
  if (!socketPath || !capability || !Number.isSafeInteger(generation) || generation < 0) {
    return undefined;
  }
  return { socketPath, capability, generation };
}

export function buildLocalCuaExecutePayload(
  method: string,
  cuaParams: Record<string, unknown>,
): Record<string, unknown> {
  return {
    method,
    input: cuaParams,
    context: {
      workspaceKey: `${NATIVE_BROWSER_CUA_WORKSPACE_KEY_PREFIX}local`,
      sessionId: NATIVE_BROWSER_CUA_SESSION_ID,
      runtimeScope: "main",
    },
  };
}

export function unavailableCuaStatusToolResult(
  reason = CODEZ_NATIVE_BROWSER_CUA_UNAVAILABLE_REASON,
) {
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify({
          available: false,
          reason,
        }),
      },
    ],
  };
}

export async function sendNativeCuaBrokerRequest(input: {
  cuaBroker: NativeCuaBrokerCredentials;
  method: "permission_status" | "execute";
  params: Record<string, unknown>;
  signal: AbortSignal;
  timeoutMs: number;
  active: Set<Socket>;
  connect?: (endpoint: string) => Socket;
}): Promise<unknown> {
  const requestId = randomUUID();
  const wire = `${JSON.stringify({
    id: requestId,
    protocol: CUA_BROKER_PROTOCOL_ID,
    version: CUA_BROKER_PROTOCOL_VERSION,
    capability: input.cuaBroker.capability,
    generation: input.cuaBroker.generation,
    method: input.method,
    params: input.params,
  })}\n`;
  const socket =
    input.connect?.(input.cuaBroker.socketPath) ?? createConnection(input.cuaBroker.socketPath);
  input.active.add(socket);
  return await new Promise((resolve, reject) => {
    let buffer = "";
    let settled = false;
    const timer = setTimeout(() => {
      finish(new Error("Computer Use broker request timed out"));
    }, input.timeoutMs);
    const finish = (error?: unknown, value?: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      input.signal.removeEventListener("abort", onAbort);
      input.active.delete(socket);
      socket.destroy();
      if (error) reject(error);
      else resolve(value);
    };
    const onAbort = () => finish(input.signal.reason ?? new DOMException("aborted", "AbortError"));
    input.signal.addEventListener("abort", onAbort, { once: true });
    socket.once("connect", () => socket.write(wire));
    socket.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      if (Buffer.byteLength(buffer) > MAX_RESPONSE_BYTES) {
        finish(new Error("Computer Use broker response exceeded the 32 MiB limit"));
        return;
      }
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      try {
        const parsed = JSON.parse(buffer.slice(0, newline)) as {
          id?: unknown;
          ok?: unknown;
          result?: unknown;
          error?: {
            code?: unknown;
            message?: unknown;
            details?: unknown;
            possibly_sent?: unknown;
            retryable?: unknown;
          };
        };
        if (parsed.id !== requestId || typeof parsed.ok !== "boolean") {
          throw new Error("Computer Use broker returned an invalid response envelope");
        }
        if (!parsed.ok) {
          const envelope = {
            code: typeof parsed.error?.code === "string" ? parsed.error.code : "internal",
            message:
              typeof parsed.error?.message === "string"
                ? parsed.error.message
                : "Computer Use broker request failed",
            ...(parsed.error?.details === undefined ? {} : { details: parsed.error.details }),
            action_sent: parsed.error?.possibly_sent === true,
            dispatch_status: parsed.error?.possibly_sent === true ? "possibly_sent" : "not_sent",
            retryable: parsed.error?.retryable === true,
          };
          throw new Error(JSON.stringify(envelope));
        }
        finish(undefined, parsed.result);
      } catch (error) {
        finish(error);
      }
    });
    socket.once("error", finish);
    socket.once("close", () => {
      if (!settled) finish(new Error("Computer Use broker closed before returning a response"));
    });
    if (input.signal.aborted) onAbort();
  });
}

export function normalizeCuaCallToolResult(value: unknown): {
  content: Array<
    { type: "text"; text: string } | { type: "image"; data: string; mimeType: string }
  >;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
} {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    if (Array.isArray(record.content)) {
      const content: Array<
        { type: "text"; text: string } | { type: "image"; data: string; mimeType: string }
      > = [];
      for (const item of record.content) {
        if (!item || typeof item !== "object") continue;
        const block = item as Record<string, unknown>;
        if (block.type === "text" && typeof block.text === "string") {
          content.push({ type: "text", text: block.text });
        } else if (
          block.type === "image" &&
          typeof block.data === "string" &&
          typeof block.mimeType === "string"
        ) {
          content.push({ type: "image", data: block.data, mimeType: block.mimeType });
        }
      }
      const structuredContent =
        record.structuredContent &&
        typeof record.structuredContent === "object" &&
        !Array.isArray(record.structuredContent)
          ? (record.structuredContent as Record<string, unknown>)
          : undefined;
      if (
        structuredContent &&
        !content.some((block) => block.type === "text" && block.text.includes("state_id"))
      ) {
        content.push({ type: "text", text: JSON.stringify(structuredContent) });
      }
      return {
        content: content.length > 0 ? content : [{ type: "text", text: JSON.stringify(value) }],
        ...(structuredContent ? { structuredContent } : {}),
        ...(record.isError === true ? { isError: true } : {}),
      };
    }
  }
  return {
    content: [{ type: "text", text: JSON.stringify(value ?? null) }],
  };
}
