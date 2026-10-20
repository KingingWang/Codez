import { CodexTransportError } from "./rpc-errors.js";

// 32 MiB 覆盖合法的大帧（全量 plugin/list、thread resume 回放的大 patch/输出项），
// 超过上限的帧按 NDJSON 边界丢弃而不是杀死连接；保留缓冲几何增长、永不超过上限。
export const MAX_FRAME_BYTES = 32 * 1024 * 1024;
const DROPPED_FRAME_PREFIX_BYTES = 4096;
export type RpcId = string | number;
export type RpcEnvelope = {
  id?: RpcId;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code: number; message: string };
};

export interface CodexDroppedFrame {
  /** 触发上限时已观察到的字节数；被丢弃帧的真实长度不小于该值。 */
  readonly observedBytes: number;
  /** 帧起始部分的原始前缀（latin1 解码），仅用于提取 id/method；禁止原文记录日志。 */
  readonly prefix: string;
}

/**
 * 只读顶层 JSON 键。正则搜索任意深度会把用户正文里的 id/method 错当成 RPC
 * 身份，导致错误归因甚至给不存在的原生请求发答复。前缀不完整时保守返回已证实字段。
 */
export function frameEnvelopeHint(prefix: string): { id?: RpcId; method?: string } {
  let id: RpcId | undefined;
  let method: string | undefined;
  const whitespace = () => {
    while (/\s/.test(prefix[position] ?? "") && position < prefix.length) position++;
  };
  const stringEnd = (start: number): number => {
    if (prefix[start] !== '"') return -1;
    for (let i = start + 1; i < prefix.length; i++) {
      if (prefix[i] === "\\") {
        i++;
      } else if (prefix[i] === '"') {
        return i + 1;
      }
    }
    return -1;
  };
  let position = 0;
  whitespace();
  if (prefix[position++] !== "{") return {};
  while (position < prefix.length) {
    whitespace();
    if (prefix[position] === "}") break;
    const keyEnd = stringEnd(position);
    if (keyEnd < 0) break;
    let key: unknown;
    try {
      key = JSON.parse(prefix.slice(position, keyEnd));
    } catch {
      break;
    }
    position = keyEnd;
    whitespace();
    if (prefix[position++] !== ":") break;
    whitespace();
    const start = position;
    if (prefix[position] === '"') {
      position = stringEnd(position);
      if (position < 0) break;
    } else if (prefix[position] === "{" || prefix[position] === "[") {
      const stack = [prefix[position] === "{" ? "}" : "]"];
      position++;
      while (position < prefix.length && stack.length) {
        const char = prefix[position];
        if (char === '"') {
          position = stringEnd(position);
          if (position < 0) break;
          continue;
        }
        if (char === "{" || char === "[") stack.push(char === "{" ? "}" : "]");
        else if (char === stack[stack.length - 1]) stack.pop();
        position++;
      }
      if (stack.length) break;
    } else {
      while (position < prefix.length && prefix[position] !== "," && prefix[position] !== "}")
        position++;
      // 截断在数字中间时不能把不完整的 id 当成真实请求身份。
      if (position === prefix.length) break;
    }
    try {
      const value: unknown = JSON.parse(prefix.slice(start, position));
      if (key === "id" && validId(value)) id = value;
      if (key === "method" && typeof value === "string" && value) method = value;
    } catch {
      break;
    }
    whitespace();
    if (prefix[position] === "}") break;
    if (prefix[position++] !== ",") break;
  }
  return { ...(id !== undefined ? { id } : {}), ...(method ? { method } : {}) };
}

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
  private skipping = false;

  push(
    chunk: Buffer,
    receive: (message: RpcEnvelope) => boolean,
    onFrameDropped?: (frame: CodexDroppedFrame) => void,
  ): void {
    let offset = 0;
    while (offset < chunk.length) {
      const newline = chunk.indexOf(10, offset);
      const end = newline < 0 ? chunk.length : newline;
      if (this.skipping) {
        // 丢弃模式：NDJSON 帧内不可能出现裸换行（JSON 字符串中的换行必然转义），
        // 因此扫描到下一个换行即可安全重新对齐，期间不保留任何字节。
        offset = end + 1;
        if (newline < 0) return;
        this.skipping = false;
        continue;
      }
      const size = this.length + end - offset;
      if (size > MAX_FRAME_BYTES) {
        // 超大帧是「显式失败但可恢复」：上报归属前缀供请求失败归因与诊断，
        // 然后进入丢弃模式；连接保持存活，内存占用与帧真实长度无关。
        const bufferedPrefix = this.buffer.toString(
          "latin1",
          0,
          Math.min(this.length, DROPPED_FRAME_PREFIX_BYTES),
        );
        const missing = DROPPED_FRAME_PREFIX_BYTES - bufferedPrefix.length;
        const prefix =
          missing > 0
            ? bufferedPrefix +
              chunk.toString("latin1", offset, offset + Math.min(end - offset, missing))
            : bufferedPrefix;
        this.length = 0;
        this.buffer = Buffer.alloc(8192);
        this.skipping = newline < 0;
        offset = end + 1;
        onFrameDropped?.({
          observedBytes: size,
          prefix,
        });
        continue;
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
    // 丢弃中的帧已在越界时上报；流在帧中间结束不重复报错。
    if (this.skipping) return;
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
