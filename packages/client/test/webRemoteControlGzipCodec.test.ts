import { gunzipSync, gzipSync } from "node:zlib";
import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  decodeWebRemoteControlGzipEnvelope,
  decodeWebRemoteControlGzipEnvelopeAsync,
  encodeWebRemoteControlGzipEnvelope,
} from "../src/webRemoteControlRelayPayloadSerializer.js";
import { WEB_REMOTE_CONTROL_GZIP_MIN_BYTES } from "@codez/shared";

const gzip = (bytes: Uint8Array) => gzipSync(bytes);
const gunzip = (bytes: Uint8Array) => gunzipSync(bytes);

describe("webRemoteControlGzipCodec", () => {
  it("大 payload 压缩后往返还原，且体积显著下降", () => {
    const payload = {
      codez_type: "app-error",
      reason: "unexpected-error",
      error: "x".repeat(8192),
    };
    const envelope = encodeWebRemoteControlGzipEnvelope(payload, gzip);
    expect(envelope).not.toBeNull();
    expect(envelope!.codez_type).toBe("relay-gzip");
    expect(envelope!.v).toBe(1);
    // base64 后仍远小于原始 JSON（8192 个重复字符高度可压缩）。
    expect(envelope!.data.length).toBeLessThan(1024);
    const decoded = decodeWebRemoteControlGzipEnvelope(envelope!, gunzip);
    expect(decoded).toEqual(payload);
  });

  it("小 payload 不压缩（低于阈值）", () => {
    const payload = { codez_type: "app-error", reason: "unexpected-error", error: "x" };
    expect(encodeWebRemoteControlGzipEnvelope(payload, gzip)).toBeNull();
  });

  it("压缩无收益时不包信封", () => {
    // base64 噪声对 Huffman 仍有收益（64 符号字母表），用恒等压缩桩直接命中守卫分支。
    const payload = {
      codez_type: "app-error",
      reason: "unexpected-error",
      error: Buffer.from(randomBytes(WEB_REMOTE_CONTROL_GZIP_MIN_BYTES * 2)).toString("base64"),
    };
    const rawBytes = new TextEncoder().encode(JSON.stringify(payload)).byteLength;
    expect(rawBytes).toBeGreaterThan(WEB_REMOTE_CONTROL_GZIP_MIN_BYTES);
    expect(encodeWebRemoteControlGzipEnvelope(payload, (bytes) => bytes)).toBeNull();
  });

  it("畸形信封解码返回 null 而不是抛错", () => {
    expect(
      decodeWebRemoteControlGzipEnvelope(
        { codez_type: "relay-gzip", v: 1, data: "aGVsbG8=" }, // 合法 base64 但不是 gzip
        gunzip,
      ),
    ).toBeNull();
    expect(
      decodeWebRemoteControlGzipEnvelope({ codez_type: "relay-gzip", v: 1, data: "####" }, gunzip),
    ).toBeNull();
  });

  it("异步变体（DecompressionStream 路径）同样往返一致", async () => {
    const payload = {
      codez_type: "rpc-frame",
      bridgeSessionId: "b1",
      messageSeq: 7,
      data: "y".repeat(4096),
    };
    const envelope = encodeWebRemoteControlGzipEnvelope(payload, gzip);
    expect(envelope).not.toBeNull();
    const decoded = await decodeWebRemoteControlGzipEnvelopeAsync(envelope!, async (bytes) =>
      gunzip(bytes),
    );
    expect(decoded).toEqual(payload);
  });
});
