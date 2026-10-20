import { z } from "zod";

const token = (bytes: number) =>
  z
    .string()
    .length(Math.ceil((bytes * 8) / 6))
    .regex(/^[A-Za-z0-9_-]+$/u);
const sid = z.string().trim().min(1).max(256);

export const WEB_REMOTE_CONTROL_E2EE_VERSION = 1 as const;
export const WEB_REMOTE_CONTROL_E2EE_HANDSHAKE_TIMEOUT_MS = 15_000;
// 密文封套多一层 base64；原始 RPC 的分片预算必须留足这部分开销。
export const WEB_REMOTE_CONTROL_E2EE_RPC_PHYSICAL_BUDGET = 700 * 1024;

const helloSchema = z
  .object({
    zcode_type: z.literal("e2ee-hello"),
    v: z.literal(WEB_REMOTE_CONTROL_E2EE_VERSION),
    sid,
    publicKey: token(32),
    nonce: token(16),
  })
  .strict();
const responseSchema = z
  .object({
    zcode_type: z.literal("e2ee-response"),
    v: z.literal(WEB_REMOTE_CONTROL_E2EE_VERSION),
    sid,
    publicKey: token(32),
    nonce: token(16),
    proof: token(32),
  })
  .strict();
const finishSchema = z
  .object({
    zcode_type: z.literal("e2ee-finish"),
    v: z.literal(WEB_REMOTE_CONTROL_E2EE_VERSION),
    sid,
    proof: token(32),
  })
  .strict();
const rekeySchema = z
  .object({
    zcode_type: z.literal("e2ee-rekey"),
    v: z.literal(WEB_REMOTE_CONTROL_E2EE_VERSION),
    sid,
    nonce: token(16),
  })
  .strict();
const recordSchema = z
  .object({
    zcode_type: z.literal("e2ee-record"),
    v: z.literal(WEB_REMOTE_CONTROL_E2EE_VERSION),
    epoch: token(16),
    n: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    ciphertext: z
      .string()
      .min(24)
      .max(1024 * 1024)
      .regex(/^[A-Za-z0-9+/]+={0,2}$/u),
  })
  .strict();

export const webRemoteControlE2eeWireSchema = z.discriminatedUnion("zcode_type", [
  helloSchema,
  responseSchema,
  finishSchema,
  rekeySchema,
  recordSchema,
]);
export type WebRemoteControlE2eeWirePayload = z.infer<typeof webRemoteControlE2eeWireSchema>;
export type WebRemoteControlE2eeRecord = z.infer<typeof recordSchema>;

export function parseWebRemoteControlE2eeWirePayload(
  input: unknown,
): WebRemoteControlE2eeWirePayload | null {
  const parsed = webRemoteControlE2eeWireSchema.safeParse(input);
  return parsed.success ? parsed.data : null;
}
