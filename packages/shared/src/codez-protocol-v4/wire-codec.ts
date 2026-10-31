// V4 physical wire encoder：按调用方真实 JSON/RPC envelope 计量，logical frame
// 超过物理上限时只在 UTF-8 bytes 层分片，不改变 seq/apply 语义。
import { PROTOCOL_V4_LIMITS, V4_WIRE_PROTOCOL_VERSION } from "./core.js";
import { crc32WireBytes, encodeWireBytesBase64 } from "./wire-binary.js";
import type {
  TopicFrameDeliveryKind,
  TopicWireChecksum,
  TopicWireFrame,
  TopicWireFrameCandidate,
} from "./wire.js";

const CHANNEL_EVENT_RESPONSE_TYPE = 204;
const SOCKET_PROTOCOL_HEADER_BYTES = 13;

function vqlByteLength(value: number): number {
  let bytes = 1;
  for (let remaining = value >>> 7; remaining > 0; remaining >>>= 7) bytes += 1;
  return bytes;
}

// 三层承载的固定信封开销只依赖协议常量（EventFire 类型码、最坏 event id 位数、
// relay 外层字段名与 transportEnvelopeIdMaxChars），与具体帧内容无关。
// 原因：measureTopicNotificationEnvelopeBytes 在分片预算二分与逐帧计量里被高频调用，
// 每次都 JSON.stringify + TextEncoder 一遍 256 字符 id 的 relay 模板属于纯重复开销。
const MAX_EVENT_ID_JSON_BYTES = String(Number.MAX_SAFE_INTEGER).length;
// @codez/rpc serialization：Array tag+length+[EventFire,id]，再加 Object tag+length+JSON。
// ChannelClient 的 id 无 31-bit wrap；超过 signed int 后 serialize 会走 Object JSON
// fallback。因此按 Number.MAX_SAFE_INTEGER 的 16-byte JSON 形态计算最坏 header。
const MAX_EVENT_ID_SERIALIZED_BYTES =
  1 + vqlByteLength(MAX_EVENT_ID_JSON_BYTES) + MAX_EVENT_ID_JSON_BYTES;
/** Channel 事件头（Array tag/length + EventFire + id）的固定字节数。 */
export const CHANNEL_HEADER_BYTES =
  1 +
  vqlByteLength(2) +
  1 +
  vqlByteLength(CHANNEL_EVENT_RESPONSE_TYPE) +
  MAX_EVENT_ID_SERIALIZED_BYTES;
/** mobile relay data 信封在 dataBase64 之外的固定 JSON 字节数（含最坏 id/时间戳宽度）。 */
export const MOBILE_RELAY_FIXED_BYTES = utf8JsonByteLength({
  type: "data",
  payload: {
    codez_type: "rpc-frame",
    bridgeSessionId: "x".repeat(PROTOCOL_V4_LIMITS.transportEnvelopeIdMaxChars),
    bridgeGeneration: Number.MAX_SAFE_INTEGER,
    recoveryId: "x".repeat(PROTOCOL_V4_LIMITS.transportEnvelopeIdMaxChars),
    seq: Number.MAX_SAFE_INTEGER,
    dataBase64: "",
  },
  client_ts: Number.MAX_SAFE_INTEGER,
  server_ts: Number.MAX_SAFE_INTEGER,
});

/**
 * 按当前生产三层真实承载计量 topic notification。mobile relay
 * 会把 Channel binary 再 base64，不能只测 CLI 的 logical JSON。
 */
export function measureTopicNotificationEnvelopeBytes(wire: TopicWireFrameCandidate): {
  cliNdjsonBytes: number;
  channelSocketBytes: number;
  mobileRelayBytes: number;
  maxBytes: number;
} {
  const cliNdjsonBytes =
    utf8JsonByteLength({
      method: "v4/conversation/frame",
      params: wire,
    }) + 1;

  const wireJsonBytes = utf8JsonByteLength(wire);
  const channelPayloadBytes =
    CHANNEL_HEADER_BYTES + 1 + vqlByteLength(wireJsonBytes) + wireJsonBytes;
  // SocketProtocol/PersistentProtocol 在 Channel payload 外再加固定 13-byte frame header。
  const channelSocketBytes = channelPayloadBytes + SOCKET_PROTOCOL_HEADER_BYTES;
  // topic encoder 继续用 legacy 单片 outer 作为保守 logical budget；production 已不发送该形态，
  // Channel payload 会再经 acknowledged raw adapter 独立分片并按最终 JSON 精确计量。
  // 两层预算分别约束 topic logical frame 与 relay physical frame，不能互相替代。
  const dataBase64Bytes = 4 * Math.ceil(channelPayloadBytes / 3);
  const mobileRelayBytes = MOBILE_RELAY_FIXED_BYTES + dataBase64Bytes;
  return {
    cliNdjsonBytes,
    channelSocketBytes,
    mobileRelayBytes,
    maxBytes: Math.max(cliNdjsonBytes, channelSocketBytes, mobileRelayBytes),
  };
}

export function utf8JsonByteLength(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

function encodeJson(value: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(value));
}

export class TopicWireFrameEncodingError extends Error {
  constructor(readonly reasonCode: string) {
    super(reasonCode);
    this.name = "TopicWireFrameEncodingError";
  }
}

function hardBound(value: number | undefined, maximum: number, name: string): number {
  const resolved = value ?? maximum;
  if (!Number.isFinite(resolved) || resolved <= 0) {
    throw new TopicWireFrameEncodingError(`proto.invalidLimit.${name}`);
  }
  return Math.min(Math.floor(resolved), maximum);
}

export interface EncodeTopicWireFramesOptions<F> {
  deliveryKind: TopicFrameDeliveryKind;
  topic: string;
  subscriptionId: string;
  logicalFrameId: string;
  logicalFrameOrdinal: number;
  maxPhysicalFrameBytes?: number;
  maxAssemblyBytes?: number;
  measurePhysicalFrameBytes(wire: TopicWireFrame<F>): number;
}

export interface EncodedTopicWireFrames<F> {
  frames: TopicWireFrame<F>[];
  /** 与 frames 一一对应的 measurePhysicalFrameBytes 结果（编码时已测，调用方不必再测一遍）。 */
  frameBytes: number[];
  totalBytes: number;
}

function makeFragment<F>(params: {
  options: EncodeTopicWireFramesOptions<F>;
  fragmentIndex: number;
  fragmentCount: number;
  logicalBytes: number;
  checksum: TopicWireChecksum;
  dataBase64: string;
}): TopicWireFrame<F> {
  return {
    wireVersion: V4_WIRE_PROTOCOL_VERSION,
    kind: "fragment",
    deliveryKind: params.options.deliveryKind,
    logicalFrameId: params.options.logicalFrameId,
    logicalFrameOrdinal: params.options.logicalFrameOrdinal,
    topic: params.options.topic,
    subscriptionId: params.options.subscriptionId,
    fragmentIndex: params.fragmentIndex,
    fragmentCount: params.fragmentCount,
    logicalBytes: params.logicalBytes,
    checksum: params.checksum,
    dataBase64: params.dataBase64,
  };
}

function findFragmentByteBudget<F>(params: {
  options: EncodeTopicWireFramesOptions<F>;
  logicalBytes: number;
  checksum: TopicWireChecksum;
  maxPhysicalFrameBytes: number;
}): number {
  let low = 1;
  let high = Math.min(params.logicalBytes, params.maxPhysicalFrameBytes);
  let best = 0;
  // 使用最坏索引位数测量，实际 fragment 的 envelope 只会更小。
  const worstCount = params.logicalBytes;
  while (low <= high) {
    const candidate = Math.floor((low + high) / 2);
    const dataBase64 = "A".repeat(4 * Math.ceil(candidate / 3));
    const wire = makeFragment({
      options: params.options,
      fragmentIndex: Math.max(0, worstCount - 1),
      fragmentCount: worstCount,
      logicalBytes: params.logicalBytes,
      checksum: params.checksum,
      dataBase64,
    });
    if (params.options.measurePhysicalFrameBytes(wire) <= params.maxPhysicalFrameBytes) {
      best = candidate;
      low = candidate + 1;
    } else {
      high = candidate - 1;
    }
  }
  return best;
}

/**
 * 编码并顺带返回每个物理帧的计量结果。
 * 原因：调用方（subscriptions 的 staged byte 记账）以前在 encodeTopicWireFrames 之外
 * 对同一批帧再跑一次 JSON.stringify + TextEncoder，等于把最大的那段 snapshot 序列化两遍。
 */
export function encodeTopicWireFramesWithBytes<F>(
  frame: F,
  options: EncodeTopicWireFramesOptions<F>,
): EncodedTopicWireFrames<F> {
  const maxPhysicalFrameBytes = hardBound(
    options.maxPhysicalFrameBytes,
    PROTOCOL_V4_LIMITS.maxFrameBytes,
    "maxPhysicalFrameBytes",
  );
  const maxAssemblyBytes = hardBound(
    options.maxAssemblyBytes,
    PROTOCOL_V4_LIMITS.logicalFrameAssemblyMaxBytes,
    "maxAssemblyBytes",
  );
  const logical = encodeJson(frame);
  if (logical.byteLength > maxAssemblyBytes) {
    throw new TopicWireFrameEncodingError("proto.frameAssemblyTooLarge");
  }

  const complete: TopicWireFrame<F> = {
    wireVersion: V4_WIRE_PROTOCOL_VERSION,
    kind: "complete",
    deliveryKind: options.deliveryKind,
    logicalFrameId: options.logicalFrameId,
    logicalFrameOrdinal: options.logicalFrameOrdinal,
    topic: options.topic,
    subscriptionId: options.subscriptionId,
    frame,
  };
  const completeBytes = options.measurePhysicalFrameBytes(complete);
  if (completeBytes <= maxPhysicalFrameBytes) {
    return { frames: [complete], frameBytes: [completeBytes], totalBytes: completeBytes };
  }

  const checksum: TopicWireChecksum = {
    algorithm: "crc32",
    value: crc32WireBytes(logical),
  };
  const chunkBytes = findFragmentByteBudget({
    options,
    logicalBytes: logical.byteLength,
    checksum,
    maxPhysicalFrameBytes,
  });
  if (chunkBytes < 1) {
    throw new TopicWireFrameEncodingError("proto.frameEnvelopeTooLarge");
  }
  const fragmentCount = Math.ceil(logical.byteLength / chunkBytes);
  if (fragmentCount > PROTOCOL_V4_LIMITS.logicalFrameAssemblyMaxFragments) {
    throw new TopicWireFrameEncodingError("proto.frameFragmentCountExceeded");
  }

  const frames: TopicWireFrame<F>[] = [];
  const frameBytes: number[] = [];
  let totalBytes = 0;
  for (let fragmentIndex = 0; fragmentIndex < fragmentCount; fragmentIndex += 1) {
    const start = fragmentIndex * chunkBytes;
    const end = Math.min(start + chunkBytes, logical.byteLength);
    const wire = makeFragment({
      options,
      fragmentIndex,
      fragmentCount,
      logicalBytes: logical.byteLength,
      checksum,
      dataBase64: encodeWireBytesBase64(logical.subarray(start, end)),
    });
    const measured = options.measurePhysicalFrameBytes(wire);
    if (measured > maxPhysicalFrameBytes) {
      // physical 上限包含调用方真实 envelope；任何估算漂移都必须
      // fail closed，不能把超限 frame 交给下游再静默截断。
      throw new TopicWireFrameEncodingError("proto.frameEnvelopeTooLarge");
    }
    frames.push(wire);
    frameBytes.push(measured);
    totalBytes += measured;
  }
  return { frames, frameBytes, totalBytes };
}

export function encodeTopicWireFrames<F>(
  frame: F,
  options: EncodeTopicWireFramesOptions<F>,
): TopicWireFrame<F>[] {
  return encodeTopicWireFramesWithBytes(frame, options).frames;
}
