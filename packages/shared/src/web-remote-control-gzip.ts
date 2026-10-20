import { z } from "zod";

// ── relay-gzip：E2EE 密文使 WebSocket permessage-deflate 完全失效 ──
//
// 远控 relay 上每个 app payload 先经 xchacha20 加密再 base64 上 WS，密文近乎随机，
// WS 层压缩协商成功也压不动。桌面→手机方向的大 payload（会话快照、workspace-list、
// rpc-frame）只能全量明文体积传输，手机上表现为持续数百 KB/s ~ MB/s 的异常流量。
//
// 方案：应用层「先压缩后加密」。发送方把内部 app payload JSON gzip 后包进
// `relay-gzip` 信封，信封作为普通 app payload 走既有 seal/序列化/ACK 管线；
// 接收方在 schema 校验前拦截信封，gunzip 还原后继续原有路由。
//
// 版本协商：握手 schema 全部 .strict() 不能加字段，因此用 app 级
// `client-capabilities` 消息宣告解码能力。旧版本对未知 codez_type 一律静默丢弃
// （parseWebRemoteControlAppPayload 返回 null 即 drop），新消息对旧端安全。
// 发送方仅在收到对端宣告 `relay-gzip.v1` 后才发送信封，两个方向的版本错配
// （新手机+旧桌面 / 旧手机+新桌面）都退化为现状不压缩。

/** 能力名：本端可以解码 relay-gzip 信封。 */
export const WEB_REMOTE_CONTROL_CAP_RELAY_GZIP_V1 = "relay-gzip.v1";

/** 小于该体积的 JSON 不值得压缩（gzip 头尾开销 + CPU），保持原样发送。 */
export const WEB_REMOTE_CONTROL_GZIP_MIN_BYTES = 1024;

const base64Schema = z
  .string()
  // gzip 后仍可能接近 MB 级（大会话快照），上限对齐 e2ee ciphertext 的 1MB 字符约束，
  // 留足 base64 膨胀空间。
  .max(2 * 1024 * 1024)
  .regex(/^[A-Za-z0-9+/]+={0,2}$/u);

/**
 * relay-gzip 信封（内部形态，上 WS 前 codez_type 会被改名为 zcode_type）。
 * data = base64(gzip(JSON.stringify(内部 app payload)))。
 */
export const webRemoteControlGzipEnvelopeSchema = z
  .object({
    codez_type: z.literal("relay-gzip"),
    v: z.literal(1),
    data: base64Schema,
  })
  .strict();

export type WebRemoteControlGzipEnvelope = z.infer<typeof webRemoteControlGzipEnvelopeSchema>;

/** 能力宣告（内部形态）。 */
export const webRemoteControlClientCapabilitiesSchema = z
  .object({
    codez_type: z.literal("client-capabilities"),
    v: z.literal(1),
    caps: z.array(z.string().max(64)).max(16),
  })
  .strict();

export type WebRemoteControlClientCapabilities = z.infer<
  typeof webRemoteControlClientCapabilitiesSchema
>;

export function parseWebRemoteControlGzipEnvelope(
  input: unknown,
): WebRemoteControlGzipEnvelope | null {
  const parsed = webRemoteControlGzipEnvelopeSchema.safeParse(input);
  return parsed.success ? parsed.data : null;
}

export function parseWebRemoteControlClientCapabilities(
  input: unknown,
): WebRemoteControlClientCapabilities | null {
  const parsed = webRemoteControlClientCapabilitiesSchema.safeParse(input);
  return parsed.success ? parsed.data : null;
}
