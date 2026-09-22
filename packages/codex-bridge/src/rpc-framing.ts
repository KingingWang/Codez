import { CodexTransportError } from "./rpc-errors.js";

export const MAX_FRAME_BYTES = 8 * 1024 * 1024;
export type RpcId = string | number;
export type RpcEnvelope = {
  id?: RpcId;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code: number; message: string };
};

export function validId(value: unknown): value is RpcId {
  return typeof value === "string" || (typeof value === "number" && Number.isSafeInteger(value));
}

function protocolError(): CodexTransportError {
  return new CodexTransportError("PROTOCOL", "Invalid Codex protocol frame");
}

function parseFrame(frame: Buffer): RpcEnvelope {
  let message: unknown;
  try {
    // 必须按完整帧解码，避免跨 chunk 的中文/emoji 被替换；非法 UTF-8 应关闭连接。
    message = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(frame));
  } catch {
    throw protocolError();
  }
  if (!message || typeof message !== "object" || Array.isArray(message)) throw protocolError();
  const value = message as Record<string, unknown>;
  const has = (key: string) => Object.hasOwn(value, key);
  if (has("jsonrpc") && value.jsonrpc !== "2.0") throw protocolError();
  if (has("id") && !validId(value.id)) throw protocolError();
  if (has("method")) {
    if (typeof value.method !== "string" || !value.method || has("result") || has("error")) {
      throw protocolError();
    }
  } else {
    if (!has("id") || has("params") || has("result") === has("error")) throw protocolError();
    if (has("error")) {
      const error = value.error as Record<string, unknown> | null;
      if (!error || !Number.isSafeInteger(error.code) || typeof error.message !== "string") {
        throw protocolError();
      }
    }
  }
  return value as RpcEnvelope;
}

/** Byte limits apply before decoding; retained storage grows geometrically, never past the cap. */
export class RpcFramer {
  private buffer = Buffer.alloc(8192);
  private length = 0;

  push(chunk: Buffer, receive: (message: RpcEnvelope) => boolean): void {
    let offset = 0;
    while (offset < chunk.length) {
      const newline = chunk.indexOf(10, offset);
      const end = newline < 0 ? chunk.length : newline;
      const size = this.length + end - offset;
      if (size > MAX_FRAME_BYTES) {
        throw new CodexTransportError("PROTOCOL", "Codex protocol frame exceeds size limit");
      }
      if (size > this.buffer.length) {
        const grown = Buffer.allocUnsafe(
          Math.min(MAX_FRAME_BYTES, Math.max(size, this.buffer.length * 2)),
        );
        this.buffer.copy(grown, 0, 0, this.length);
        this.buffer = grown;
      }
      chunk.copy(this.buffer, this.length, offset, end);
      this.length = size;
      offset = end + 1;
      if (newline < 0) return;
      const frame = this.buffer.subarray(0, this.length);
      this.length = 0;
      if (frame.length && !receive(parseFrame(frame))) return;
    }
  }

  end(): void {
    if (this.length) throw new CodexTransportError("PROTOCOL", "Truncated Codex protocol frame");
  }
}

export function encodeFrame(message: RpcEnvelope): string {
  let encoded: string;
  try {
    encoded = JSON.stringify(message);
    // JSON.stringify 会静默省略函数或返回 undefined 的 toJSON，不能发送缺失 result 的回复。
    if (Object.hasOwn(message, "result") && !Object.hasOwn(JSON.parse(encoded), "result")) {
      throw new Error("Missing result");
    }
  } catch {
    throw new CodexTransportError("INVALID", "Cannot serialize Codex RPC message");
  }
  if (Buffer.byteLength(encoded) > MAX_FRAME_BYTES) {
    throw new CodexTransportError("LIMIT", "Codex RPC message exceeds size limit");
  }
  return `${encoded}\n`;
}
