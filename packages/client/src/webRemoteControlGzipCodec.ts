import {
  WEB_REMOTE_CONTROL_GZIP_MIN_BYTES,
  type WebRemoteControlGzipEnvelope,
} from "@codez/shared";

/**
 * relay-gzip 信封编解码。压缩实现由调用方按平台注入：
 * desktop（Electron main / Node）传 zlib.gzipSync / gunzipSync（同步、零依赖）；
 * 手机 Web 端没有同步原生压缩 API，发送方向不压缩（手机上行本来都是小 payload），
 * 接收方向用 DecompressionStream 异步解码后走同一还原逻辑。
 */

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder("utf-8", { fatal: true });

function encodeBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 8192) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
  }
  return btoa(binary);
}

function decodeBase64(value: string): Uint8Array {
  return Uint8Array.from(atob(value), (character) => character.charCodeAt(0));
}

/**
 * 把内部 app payload 包成 gzip 信封；小于阈值或压缩无收益时返回 null（保持原样发送）。
 * 入参 payload 必须是不可变对象：调用方用 WeakMap 缓存信封，保证 relay ACK 重放时
 * 复用逐字节相同的最终帧（重放语义依赖字节一致）。
 */
export function encodeWebRemoteControlGzipEnvelope(
  payload: object,
  gzip: (bytes: Uint8Array) => Uint8Array,
): WebRemoteControlGzipEnvelope | null {
  const raw = textEncoder.encode(JSON.stringify(payload));
  if (raw.byteLength < WEB_REMOTE_CONTROL_GZIP_MIN_BYTES) return null;
  const compressed = gzip(raw);
  if (compressed.byteLength >= raw.byteLength) return null;
  return { codez_type: "relay-gzip", v: 1, data: encodeBase64(compressed) };
}

/**
 * 还原信封内的 app payload；任何一步失败都返回 null（调用方静默丢帧），
 * 不让畸形信封打断 socket。
 */
export function decodeWebRemoteControlGzipEnvelope(
  envelope: WebRemoteControlGzipEnvelope,
  gunzip: (bytes: Uint8Array) => Uint8Array,
): unknown {
  try {
    const compressed = decodeBase64(envelope.data);
    const raw = gunzip(compressed);
    return JSON.parse(textDecoder.decode(raw)) as unknown;
  } catch {
    return null;
  }
}

/** 异步解码变体：手机 Web 端只有 DecompressionStream（异步流），没有同步原生 gunzip。 */
export async function decodeWebRemoteControlGzipEnvelopeAsync(
  envelope: WebRemoteControlGzipEnvelope,
  gunzip: (bytes: Uint8Array) => Promise<Uint8Array>,
): Promise<unknown> {
  try {
    const compressed = decodeBase64(envelope.data);
    const raw = await gunzip(compressed);
    return JSON.parse(textDecoder.decode(raw)) as unknown;
  } catch {
    return null;
  }
}
