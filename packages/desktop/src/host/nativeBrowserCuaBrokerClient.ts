import { randomUUID } from "node:crypto";
import { createConnection } from "node:net";
import { readFile } from "node:fs/promises";
import {
  NATIVE_BROWSER_CUA_RELAY_RESPONSE_MAX_BYTES,
  type NativeBrowserCuaMcpResponse,
} from "@codez/shared";
import type { NativeBrowserCuaBrokerRequestInput } from "./native-browser-control/contract.js";

/**
 * Host→Main broker 客户端（spec: codex-desktop-native-browser-cua「Remote workspace relay」）。
 *
 * 远程 relay 的每条请求在这里换成当前窗口 token 后打给 Main broker；
 * broker 是唯一校验与执行权威，本客户端不复制 schema 校验。
 */

const DEFAULT_BROKER_TIMEOUT_MS = 90_000;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

function requestIdFromPayload(payload: unknown): string | undefined {
  if (!payload || typeof payload !== "object") return undefined;
  const id = (payload as { id?: unknown }).id;
  return typeof id === "string" && UUID_PATTERN.test(id) ? id : undefined;
}

function failureLine(id: string, message: string): string {
  const response: NativeBrowserCuaMcpResponse = {
    id,
    ok: false,
    error: "backend_unavailable",
    message,
  };
  return JSON.stringify(response);
}

/** 无 broker 目标（开关关闭/能力未授予）时的失败帧合成；id 尽量取自原始载荷。 */
export function synthesizeNativeBrowserCuaFailureLine(payload: string, message: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload) as unknown;
  } catch {
    return failureLine(randomUUID(), message);
  }
  return failureLine(requestIdFromPayload(parsed) ?? randomUUID(), message);
}

/**
 * 执行一条原始 broker 请求行并返回原始响应行。
 * 任何本地失败都合成为 backend_unavailable 帧，保证远端 bridge 拿到正常工具错误而不是悬挂。
 */
export async function executeNativeBrowserCuaBrokerRequest(
  input: NativeBrowserCuaBrokerRequestInput,
): Promise<string> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(input.payload) as unknown;
  } catch {
    return failureLine(randomUUID(), "relay payload is not valid JSON");
  }
  const requestId = requestIdFromPayload(parsed) ?? randomUUID();
  let token: string;
  try {
    const readToken = input.readTokenFile ?? ((path: string) => readFile(path, "utf8"));
    token = (await readToken(input.target.tokenFile)).trim();
    if (!token) throw new Error("empty token file");
  } catch {
    return failureLine(requestId, "Native Browser/CUA window credential is unavailable");
  }
  // 换入窗口 token：远端 relay 的 remote-local token 只在远端机器有效，Main broker 只认窗口 token。
  const outbound = JSON.stringify({
    ...(parsed as Record<string, unknown>),
    token,
  });
  const connect = input.connect ?? createConnection;
  const timeoutMs = input.timeoutMs ?? DEFAULT_BROKER_TIMEOUT_MS;
  return await new Promise<string>((resolve) => {
    const socket = connect(input.target.endpoint);
    // 修复原因：逐 chunk UTF-8 解码会把跨片中文/emoji 静默替换为 U+FFFD，
    // 且反复扫描累计字符串为 O(n²)；按原始字节累计，只在完整换行帧后解码。
    const chunks: Buffer[] = [];
    let receivedBytes = 0;
    let settled = false;
    const finish = (line: string) => {
      if (settled) return;
      settled = true;
      chunks.length = 0;
      clearTimeout(timer);
      socket.destroy();
      resolve(line);
    };
    const timer = setTimeout(() => {
      finish(failureLine(requestId, "Native Browser/CUA broker request timed out"));
    }, timeoutMs);
    socket.on("data", (chunk: Buffer) => {
      if (settled) return;
      receivedBytes += chunk.length;
      if (receivedBytes > NATIVE_BROWSER_CUA_RELAY_RESPONSE_MAX_BYTES) {
        finish(
          failureLine(requestId, "Native Browser/CUA broker response exceeded the 32 MiB limit"),
        );
        return;
      }
      chunks.push(chunk);
      const newline = chunk.indexOf(0x0a);
      if (newline < 0) return;
      // ASCII 换行不可能出现在 UTF-8 续字节中；原始接收字节仍保持 32 MiB fail-closed。
      const frame = Buffer.concat(chunks, receivedBytes)
        .subarray(0, receivedBytes - chunk.length + newline)
        .toString("utf8");
      finish(frame);
    });
    socket.once("error", () => {
      finish(failureLine(requestId, "Native Browser/CUA broker is unreachable"));
    });
    socket.once("close", () => {
      finish(failureLine(requestId, "Native Browser/CUA broker closed the connection"));
    });
    socket.once("connect", () => {
      socket.write(`${outbound}\n`);
    });
  });
}
