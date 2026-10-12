import { describe, expect, it } from "vitest";
import {
  WEB_REMOTE_CONTROL_RPC_TRANSPORT_LIMITS,
  encodeWebRemoteControlRpcTransportMessage,
  type WebRemoteControlAppPayload,
} from "@codez/shared";
import { WebRemoteControlRelayPayloadSerializer } from "../src/webRemoteControlRelayPayloadSerializer.js";
import {
  createWebRemoteControlE2eeSession,
  generateWebRemoteControlPairingKey,
} from "../src/webRemoteControlE2ee.js";

describe("WebRemoteControlRelayPayloadSerializer", () => {
  it("meters exactly the immutable encrypted outer JSON, including replay", () => {
    const key = generateWebRemoteControlPairingKey();
    const phonePackets: unknown[] = [];
    const desktopPackets: unknown[] = [];
    const phone = createWebRemoteControlE2eeSession({
      role: "terminal", deviceSid: "sid", pairingKey: key, send: (packet) => phonePackets.push(packet),
    });
    const desktop = createWebRemoteControlE2eeSession({
      role: "device", deviceSid: "sid", pairingKey: key, send: (packet) => desktopPackets.push(packet),
    });
    phone.start();
    desktop.accept(phonePackets.shift());
    phone.accept(desktopPackets.shift());
    desktop.accept(phonePackets.shift());
    phone.accept(desktopPackets.shift());
    const serializer = new WebRemoteControlRelayPayloadSerializer({
      seal: (wire) => phone.prepare(wire),
    });
    const plaintext: WebRemoteControlAppPayload = {
      codez_type: "app-error", reason: "unexpected-error", error: "private",
    };
    const prepared = serializer.prepare(plaintext, 100);
    expect(prepared.json).not.toContain("private");
    expect(prepared.bytes).toBe(new TextEncoder().encode(prepared.json).byteLength);
    expect(serializer.prepare(plaintext, 200)).toBe(prepared);
    expect(desktop.accept(prepared.message.payload)).toMatchObject({
      kind: "payload",
      payload: { zcode_type: "app-error", error: "private" },
    });
  });
  it("emits only the upstream wire discriminator without mutating the internal payload", () => {
    const serializer = new WebRemoteControlRelayPayloadSerializer();
    const payload = Object.freeze({
      codez_type: "bootstrap-response" as const,
      requestId: "bootstrap-upstream",
      success: true as const,
      result: { windowControlSessionId: "sid-1", workspaces: [], tasks: [] },
    });
    const prepared = serializer.prepare(payload, 100);
    expect(JSON.parse(prepared.json)).toEqual({
      type: "data",
      payload: {
        zcode_type: "bootstrap-response",
        requestId: "bootstrap-upstream",
        success: true,
        result: payload.result,
      },
      client_ts: 100,
    });
    expect(payload.codez_type).toBe("bootstrap-response");
    expect(payload).not.toHaveProperty("zcode_type");
    expect(prepared.bytes).toBe(new TextEncoder().encode(prepared.json).byteLength);
    expect(serializer.prepare(payload, 200)).toBe(prepared);
  });

  it("reuses the identical final JSON and byte count for one immutable raw payload", () => {
    const serializer = new WebRemoteControlRelayPayloadSerializer();
    const [payload] = encodeWebRemoteControlRpcTransportMessage(new Uint8Array([1, 2, 3]), {
      bridgeSessionId: "bridge-1",
      firstPhysicalSeq: 1,
      messageSeq: 1,
    });

    const first = serializer.prepare(payload, 100);
    const replay = serializer.prepare(payload, 200);

    expect(replay).toBe(first);
    expect(replay.json).toBe(first.json);
    expect(replay.message.client_ts).toBe(100);
    expect(replay.bytes).toBe(new TextEncoder().encode(replay.json).byteLength);
  });

  it("distinguishes a permanent oversize envelope from a bounded payload", () => {
    const serializer = new WebRemoteControlRelayPayloadSerializer();
    const bounded: WebRemoteControlAppPayload = {
      codez_type: "app-error",
      reason: "unexpected-error",
      error: "中文🙂bounded",
    };
    const oversize: WebRemoteControlAppPayload = {
      codez_type: "app-error",
      reason: "unexpected-error",
      error: "x".repeat(WEB_REMOTE_CONTROL_RPC_TRANSPORT_LIMITS.maxPhysicalFrameBytes),
    };

    const preparedBounded = serializer.prepare(bounded, 1);
    expect(serializer.isOversize(preparedBounded)).toBe(false);
    expect(preparedBounded.bytes).toBe(new TextEncoder().encode(preparedBounded.json).byteLength);
    const preparedOversize = serializer.prepare(oversize, 1);
    expect(serializer.isOversize(preparedOversize)).toBe(true);
    expect(preparedOversize.bytes).toBeGreaterThan(
      WEB_REMOTE_CONTROL_RPC_TRANSPORT_LIMITS.maxPhysicalFrameBytes,
    );
  });
});
