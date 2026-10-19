import { describe, expect, it } from "vitest";
import {
  WEB_REMOTE_CONTROL_E2EE_RPC_PHYSICAL_BUDGET,
  WEB_REMOTE_CONTROL_RPC_TRANSPORT_LIMITS,
  encodeWebRemoteControlRpcTransportMessage,
} from "@codez/shared";
import {
  createWebRemoteControlE2eeSession,
  generateWebRemoteControlPairingKey,
  WebRemoteControlRelayPayloadSerializer,
} from "../src/webRemoteControlRelayPayloadSerializer.js";

const key = generateWebRemoteControlPairingKey();
const otherKey = generateWebRemoteControlPairingKey();

function pairedSessions() {
  const mobileWire: unknown[] = [];
  const desktopWire: unknown[] = [];
  const mobile = createWebRemoteControlE2eeSession({
    role: "terminal",
    deviceSid: "device-1",
    pairingKey: key,
    send: (payload) => mobileWire.push(payload),
  });
  const desktop = createWebRemoteControlE2eeSession({
    role: "device",
    deviceSid: "device-1",
    pairingKey: key,
    send: (payload) => desktopWire.push(payload),
  });
  mobile.start();
  desktop.accept(mobileWire.shift());
  mobile.accept(desktopWire.shift());
  desktop.accept(mobileWire.shift());
  mobile.accept(desktopWire.shift());
  expect(mobile.isReady()).toBe(true);
  expect(desktop.isReady()).toBe(true);
  return { mobile, desktop, mobileWire, desktopWire };
}

describe("mobile remote E2EE", () => {
  it("uses a distinct QR key to authenticate ephemeral handshake and encrypt both directions", () => {
    expect(key).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(key).not.toBe(otherKey);
    const { mobile, desktop } = pairedSessions();
    const plaintext = {
      zcode_type: "bootstrap-request",
      requestId: "request-1",
      secret: "private conversation",
    };
    const record = mobile.prepare(plaintext);
    expect(JSON.stringify(record)).not.toContain("private conversation");
    expect(desktop.accept(record)).toEqual({ kind: "payload", payload: plaintext });
    const reply = desktop.prepare({ zcode_type: "app-error", error: "secret reply" });
    expect(mobile.accept(reply)).toEqual({
      kind: "payload",
      payload: { zcode_type: "app-error", error: "secret reply" },
    });
  });

  it("rejects a forged proof, modified ciphertext, plaintext and another epoch", () => {
    const mobileWire: unknown[] = [];
    const desktopWire: unknown[] = [];
    const mobile = createWebRemoteControlE2eeSession({
      role: "terminal",
      deviceSid: "device-1",
      pairingKey: key,
      send: (payload) => mobileWire.push(payload),
    });
    const impostor = createWebRemoteControlE2eeSession({
      role: "device",
      deviceSid: "device-1",
      pairingKey: otherKey,
      send: (payload) => desktopWire.push(payload),
    });
    mobile.start();
    impostor.accept(mobileWire.shift());
    expect(() => mobile.accept(desktopWire.shift())).toThrow();
    expect(mobile.isReady()).toBe(false);

    const { mobile: healthyMobile, desktop } = pairedSessions();
    expect(() => desktop.accept({ zcode_type: "bootstrap-request" })).toThrow();
    const record = healthyMobile.prepare({ zcode_type: "bootstrap-request" });
    // 篡改必须确定性地改变密文：原 base64 恰好以 "AA" 结尾时（约 1/4096）
    // slice+拼接会得到原串，accept 不抛错，CI 上曾因此概率性失败。
    const tamperedCiphertext = record.ciphertext.endsWith("AA")
      ? `${record.ciphertext.slice(0, -2)}BB`
      : `${record.ciphertext.slice(0, -2)}AA`;
    expect(() => desktop.accept({ ...record, ciphertext: tamperedCiphertext })).toThrow();
    expect(desktop.accept(record)).toEqual({
      kind: "payload",
      payload: { zcode_type: "bootstrap-request" },
    });
    const { desktop: newDesktop } = pairedSessions();
    expect(() => newDesktop.accept(record)).toThrow();
  });

  it("does not deliver a duplicate business record twice", () => {
    const { mobile, desktop } = pairedSessions();
    const record = mobile.prepare({ zcode_type: "workspace-bridge-open", requestId: "one" });
    expect(desktop.accept(record).kind).toBe("payload");
    expect(desktop.accept(record)).toEqual({ kind: "duplicate" });
    const rpc = mobile.prepare({
      zcode_type: "rpc-frame-ack",
      bridgeSessionId: "bridge-1",
      ackMessageSeq: 1,
    });
    expect(desktop.accept(rpc).kind).toBe("payload");
    expect(desktop.accept(rpc).kind).toBe("duplicate-rpc");
  });

  it("keeps the final encrypted physical relay envelope under 1 MiB", () => {
    const { mobile } = pairedSessions();
    const serializer = new WebRemoteControlRelayPayloadSerializer({
      seal: (wire) => mobile.prepare(wire),
    });
    const frames = encodeWebRemoteControlRpcTransportMessage(new Uint8Array(500_000), {
      bridgeSessionId: "bridge-1",
      firstPhysicalSeq: 1,
      messageSeq: 1,
      maxPhysicalFrameBytes: WEB_REMOTE_CONTROL_E2EE_RPC_PHYSICAL_BUDGET,
    });
    expect(frames.length).toBeGreaterThanOrEqual(1);
    for (const frame of frames) {
      const prepared = serializer.prepare(frame);
      expect(prepared.bytes).toBeLessThanOrEqual(
        WEB_REMOTE_CONTROL_RPC_TRANSPORT_LIMITS.maxPhysicalFrameBytes,
      );
      expect(prepared.bytes).toBe(new TextEncoder().encode(prepared.json).byteLength);
      expect(serializer.prepare(frame).json).toBe(prepared.json);
    }
  });
});
