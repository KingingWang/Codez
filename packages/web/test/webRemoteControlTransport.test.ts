import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocket, WebSocketServer } from "ws";
import type { AddressInfo } from "node:net";
import {
  createWebRemoteControlE2eeSession,
  generateWebRemoteControlPairingKey,
} from "@codez/client";
import {
  WEB_REMOTE_CONTROL_RPC_TRANSPORT_LIMITS,
  WEB_REMOTE_CONTROL_WORKSPACE_RECONNECT_TIMEOUT_MS,
  encodeWebRemoteControlRpcTransportMessage,
  type WebRemoteControlAppPayload,
  type WebRemoteControlFailure,
} from "@codez/shared";
import {
  WebRemoteControlTerminalTransport,
  createWebRemoteControlAppPayloadRequester,
  createWebRemoteControlRelayRequestRecovery,
  type WebRemoteControlTerminalTransportState,
} from "../src/webRemoteControlTransport.js";

const servers: WebSocketServer[] = [];
const serverSockets = new Map<WebSocketServer, Set<import("ws").WebSocket>>();

function waitUntil(assertion: () => boolean, timeoutMs = 500, label = "assertion"): Promise<void> {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    const tick = () => {
      if (assertion()) {
        resolve();
        return;
      }
      if (Date.now() - startedAt > timeoutMs) {
        reject(new Error(`Timed out waiting for ${label}`));
        return;
      }
      setTimeout(tick, 10);
    };
    tick();
  });
}

function createRelayDataJsonWithExactBytes(targetBytes: number): string {
  const multibytePrefix = "中🙂";
  const createJson = (error: string) =>
    JSON.stringify({
      type: "data",
      payload: {
        codez_type: "app-error",
        reason: "unexpected-error",
        error,
      },
    });
  const empty = createJson(multibytePrefix);
  const paddingBytes = targetBytes - new TextEncoder().encode(empty).byteLength;
  if (paddingBytes < 0) throw new Error("target relay frame is smaller than its fixed envelope");
  const result = createJson(`${multibytePrefix}${"x".repeat(paddingBytes)}`);
  if (new TextEncoder().encode(result).byteLength !== targetBytes) {
    throw new Error("failed to construct exact relay frame bytes");
  }
  return result;
}

async function createRelayServer(
  onMessage: (context: { message: any; socket: import("ws").WebSocket; messages: any[] }) => void,
  options?: { perMessageDeflate?: boolean },
) {
  const server = new WebSocketServer({
    port: 0,
    perMessageDeflate: options?.perMessageDeflate ?? false,
  });
  servers.push(server);
  const sockets = new Set<import("ws").WebSocket>();
  serverSockets.set(server, sockets);
  const messages: any[] = [];
  const rawMessages: string[] = [];
  const clientCompressedFrames: boolean[] = [];
  let requestUrl = "";
  let requestExtensions: string | string[] | undefined;
  let connectionCount = 0;

  let rawBuffer = Buffer.alloc(0);
  function collectClientFrameCompression(chunk: Buffer): void {
    rawBuffer = Buffer.concat([rawBuffer, chunk]);
    while (rawBuffer.length >= 2) {
      const firstByte = rawBuffer[0];
      const secondByte = rawBuffer[1];
      let offset = 2;
      let payloadLength = secondByte & 0x7f;
      if (payloadLength === 126) {
        if (rawBuffer.length < offset + 2) {
          return;
        }
        payloadLength = rawBuffer.readUInt16BE(offset);
        offset += 2;
      } else if (payloadLength === 127) {
        if (rawBuffer.length < offset + 8) {
          return;
        }
        const longLength = rawBuffer.readBigUInt64BE(offset);
        if (longLength > BigInt(Number.MAX_SAFE_INTEGER)) {
          throw new Error("WebSocket frame too large for test parser");
        }
        payloadLength = Number(longLength);
        offset += 8;
      }
      const masked = (secondByte & 0x80) !== 0;
      if (masked) {
        offset += 4;
      }
      const frameLength = offset + payloadLength;
      if (rawBuffer.length < frameLength) {
        return;
      }
      clientCompressedFrames.push((firstByte & 0x40) !== 0);
      rawBuffer = rawBuffer.subarray(frameLength);
    }
  }

  server.on("connection", (socket, request) => {
    sockets.add(socket);
    socket.on("close", () => {
      sockets.delete(socket);
    });
    connectionCount += 1;
    requestUrl = request.url ?? "";
    requestExtensions = request.headers["sec-websocket-extensions"];
    request.socket.on("data", collectClientFrameCompression);
    socket.on("message", (raw) => {
      rawMessages.push(raw.toString());
      const message = JSON.parse(raw.toString());
      messages.push(message);
      onMessage({ message, socket, messages });
    });
  });

  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address() as AddressInfo;
  return {
    messages,
    rawMessages,
    url: `ws://127.0.0.1:${address.port}/ws`,
    getRequestUrl: () => requestUrl,
    getRequestExtensions: () => requestExtensions,
    getClientCompressedFrames: () => [...clientCompressedFrames],
    getConnectionCount: () => connectionCount,
  };
}

afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(
    servers.splice(0).map((server) => {
      const sockets = serverSockets.get(server);
      serverSockets.delete(server);
      for (const socket of sockets ?? []) {
        // Bugfix: 失败的异步断言会跳过 transport.dispose()，只 close server 会等待仍存活的 WS。
        // 测试清理阶段直接终止客户端连接，避免全量单测里 afterEach 因悬挂连接超时。
        socket.terminate();
      }
      return new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    }),
  );
});

describe("WebRemoteControlTerminalTransport", () => {
  it("fails closed and keeps retrying when relay matches but never forwards the authenticated handshake", async () => {
    const states: WebRemoteControlTerminalTransportState[] = [];
    const failures: WebRemoteControlFailure[] = [];
    const relay = await createRelayServer(({ message, socket }) => {
      if (message.type === "auth_init") {
        socket.send(JSON.stringify({ type: "auth_challenge", nonce: "nonce-1" }));
      } else if (message.type === "auth_response") {
        socket.send(
          JSON.stringify({
            type: "auth_ack",
            device_sid: "sid-1",
            pair_status: "matched",
          }),
        );
      }
    });
    const transport = new WebRemoteControlTerminalTransport({
      relayWsUrl: relay.url,
      deviceSid: "sid-1",
      passHash: "relay-known",
      e2eeKey: generateWebRemoteControlPairingKey(),
      e2eeHandshakeTimeoutMs: 100,
      WebSocketCtor: WebSocket as unknown as typeof globalThis.WebSocket,
      authProvider: { calculateProof: async () => "proof" },
      onPayload: () => {
        throw new Error("unauthenticated payload reached app");
      },
      onStateChange: (state) => states.push(state),
      onFailure: (failure) => failures.push(failure),
      onError: () => {},
      reloadPage: () => {},
    });
    try {
      transport.start();
      await waitUntil(() => states.includes("securing"), 3_000);
      expect(() =>
        transport.measurePayloadBytes({
          codez_type: "app-error",
          reason: "unexpected-error",
          error: "not-yet-authenticated",
        }),
      ).toThrow("e2ee.notReady");
      // Bugfix: 握手超时不再进失败页，而是重建 socket 无限重试；业务入口保持关闭。
      await waitUntil(() => relay.getConnectionCount() >= 2, 3_000);
      expect(failures).toHaveLength(0);
      expect(states).not.toContain("paired");
      expect(
        transport.sendPayload({
          codez_type: "app-error",
          reason: "unexpected-error",
          error: "blocked",
        }),
      ).toBe(false);
    } finally {
      transport.dispose();
    }
  });
  it("authenticates the desktop before accepting app data and never sends plaintext business payload", async () => {
    const key = generateWebRemoteControlPairingKey();
    const states: WebRemoteControlTerminalTransportState[] = [];
    const received: WebRemoteControlAppPayload[] = [];
    const peerReceived: unknown[] = [];
    const failures: unknown[] = [];
    let peerEpoch = 0;
    let resetCount = 0;
    let peer: ReturnType<typeof createWebRemoteControlE2eeSession>;
    let peerSocket: WebSocket;
    const makePeer = () => {
      peerEpoch += 1;
      peer = createWebRemoteControlE2eeSession({
        role: "device",
        deviceSid: "sid-1",
        pairingKey: key,
        send: (payload) => peerSocket.send(JSON.stringify({ type: "data", payload })),
      });
      peer.start();
    };
    const relay = await createRelayServer(({ message, socket }) => {
      peerSocket = socket;
      if (message.type === "auth_init") {
        socket.send(JSON.stringify({ type: "auth_challenge", nonce: "nonce-1" }));
      } else if (message.type === "auth_response") {
        makePeer();
        socket.send(
          JSON.stringify({
            type: "auth_ack",
            device_sid: "sid-1",
            pair_status: "matched",
          }),
        );
      } else if (message.type === "data") {
        const result = peer.accept(message.payload);
        if (result.kind === "ready") {
          socket.send(
            JSON.stringify({
              type: "data",
              payload: peer.prepare({
                zcode_type: "app-error",
                reason: "unexpected-error",
                error: peerEpoch === 1 ? "encrypted desktop" : "new encrypted epoch",
              }),
            }),
          );
        }
        if (result.kind === "payload") peerReceived.push(result.payload);
      }
    });
    const transport = new WebRemoteControlTerminalTransport({
      relayWsUrl: relay.url,
      deviceSid: "sid-1",
      passHash: "relay-known",
      e2eeKey: key,
      WebSocketCtor: WebSocket as unknown as typeof globalThis.WebSocket,
      authProvider: { calculateProof: async () => "proof" },
      onPayload: (payload) => received.push(payload),
      onStateChange: (state) => states.push(state),
      onFailure: (failure) => failures.push(failure),
      onE2eeReset: () => {
        resetCount += 1;
      },
      onError: () => {},
      reloadPage: () => {},
    });
    try {
      transport.start();
      await waitUntil(() => states.includes("paired") && received.length === 1, 3_000);
      expect(states).toContain("securing");
      expect(received[0]).toMatchObject({
        codez_type: "app-error",
        error: "encrypted desktop",
      });
      expect(
        transport.sendPayload({
          codez_type: "app-error",
          reason: "unexpected-error",
          error: "private phone",
        }),
      ).toBe(true);
      await waitUntil(() => peerReceived.length === 1, 3_000);
      expect(peerReceived[0]).toMatchObject({
        zcode_type: "app-error",
        error: "private phone",
      });
      expect(JSON.stringify(relay.messages)).not.toContain("private phone");
      makePeer();
      peerSocket!.send(
        JSON.stringify({
          type: "data",
          payload: {
            zcode_type: "e2ee-rekey",
            v: 1,
            sid: "sid-1",
            nonce: "A".repeat(22),
          },
        }),
      );
      await waitUntil(() => received.length === 2, 3_000);
      expect(states.filter((state) => state === "paired")).toHaveLength(2);
      expect(received[1]).toMatchObject({
        codez_type: "app-error",
        error: "new encrypted epoch",
      });
      expect(resetCount).toBe(1);
      peerSocket!.send(
        JSON.stringify({
          type: "data",
          payload: {
            zcode_type: "app-error",
            reason: "unexpected-error",
            error: "untrusted plaintext",
          },
        }),
      );
      // Bugfix: 明文注入/坏帧不再进失败页；手机废弃当前会话并重建 socket，
      // 重新握手后链路恢复（每轮 ready 后 peer 都会再发一条 app-error）。
      await waitUntil(() => received.length === 3, 3_000);
      expect(failures).toHaveLength(0);
      expect(received[2]).toMatchObject({
        codez_type: "app-error",
        error: "new encrypted epoch",
      });
    } finally {
      transport.dispose();
    }
  });
  it("drops stale epoch records without reconnecting or failing", async () => {
    const key = generateWebRemoteControlPairingKey();
    const states: WebRemoteControlTerminalTransportState[] = [];
    const received: WebRemoteControlAppPayload[] = [];
    const failures: WebRemoteControlFailure[] = [];
    let peer: ReturnType<typeof createWebRemoteControlE2eeSession>;
    let peerSocket: WebSocket;
    let peerEpoch = 0;
    const makePeer = () => {
      peerEpoch += 1;
      peer = createWebRemoteControlE2eeSession({
        role: "device",
        deviceSid: "sid-1",
        pairingKey: key,
        send: (payload) => peerSocket.send(JSON.stringify({ type: "data", payload })),
      });
      peer.start();
    };
    const relay = await createRelayServer(({ message, socket }) => {
      peerSocket = socket;
      if (message.type === "auth_init") {
        socket.send(JSON.stringify({ type: "auth_challenge", nonce: "nonce-1" }));
      } else if (message.type === "auth_response") {
        makePeer();
        socket.send(
          JSON.stringify({
            type: "auth_ack",
            device_sid: "sid-1",
            pair_status: "matched",
          }),
        );
      } else if (message.type === "data") {
        try {
          const result = peer.accept(message.payload);
          if (result.kind === "ready") {
            socket.send(
              JSON.stringify({
                type: "data",
                payload: peer.prepare({
                  zcode_type: "app-error",
                  reason: "unexpected-error",
                  error: `epoch-${peerEpoch}`,
                }),
              }),
            );
          }
        } catch {
          // 测试替身只驱动协议流；手机重置会话后桌面侧抛错可忽略。
        }
      }
    });
    const transport = new WebRemoteControlTerminalTransport({
      relayWsUrl: relay.url,
      deviceSid: "sid-1",
      passHash: "relay-known",
      e2eeKey: key,
      WebSocketCtor: WebSocket as unknown as typeof globalThis.WebSocket,
      authProvider: { calculateProof: async () => "proof" },
      onPayload: (payload) => received.push(payload),
      onStateChange: (state) => states.push(state),
      onFailure: (failure) => failures.push(failure),
      onError: () => {},
      reloadPage: () => {},
    });
    try {
      transport.start();
      await waitUntil(() => states.includes("paired") && received.length === 1, 3_000);
      // 第一轮 epoch 的密文，先扣住不发。
      const staleRecord = peer.prepare({
        zcode_type: "app-error",
        reason: "unexpected-error",
        error: "stale epoch",
      });
      // 桌面 socket 换代 → rekey → 手机重新握手进入新 epoch。
      makePeer();
      peerSocket!.send(
        JSON.stringify({
          type: "data",
          payload: {
            zcode_type: "e2ee-rekey",
            v: 1,
            sid: "sid-1",
            nonce: "A".repeat(22),
          },
        }),
      );
      await waitUntil(() => received.length === 2, 3_000);
      // 旧轮次迟到帧必须被丢弃且不触发重连/失败；紧跟新轮次密文验证链路仍可用。
      peerSocket!.send(JSON.stringify({ type: "data", payload: staleRecord }));
      peerSocket!.send(
        JSON.stringify({
          type: "data",
          payload: peer.prepare({
            zcode_type: "app-error",
            reason: "unexpected-error",
            error: "fresh epoch",
          }),
        }),
      );
      await waitUntil(() => received.length === 3, 3_000);
      expect(received.map((payload) => (payload as { error?: string }).error)).toEqual([
        "epoch-1",
        "epoch-2",
        "fresh epoch",
      ]);
      expect(failures).toHaveLength(0);
      expect(relay.getConnectionCount()).toBe(1);
      expect(states).not.toContain("error");
    } finally {
      transport.dispose();
    }
  });
  it("recovers from an unexpected e2ee handshake frame without a terminal failure", async () => {
    const key = generateWebRemoteControlPairingKey();
    const states: WebRemoteControlTerminalTransportState[] = [];
    const received: WebRemoteControlAppPayload[] = [];
    const failures: WebRemoteControlFailure[] = [];
    let peer: ReturnType<typeof createWebRemoteControlE2eeSession>;
    let peerSocket: WebSocket;
    let peerEpoch = 0;
    const makePeer = () => {
      peerEpoch += 1;
      peer = createWebRemoteControlE2eeSession({
        role: "device",
        deviceSid: "sid-1",
        pairingKey: key,
        send: (payload) => peerSocket.send(JSON.stringify({ type: "data", payload })),
      });
      peer.start();
    };
    const relay = await createRelayServer(({ message, socket }) => {
      peerSocket = socket;
      if (message.type === "auth_init") {
        socket.send(JSON.stringify({ type: "auth_challenge", nonce: "nonce-1" }));
      } else if (message.type === "auth_response") {
        makePeer();
        socket.send(
          JSON.stringify({
            type: "auth_ack",
            device_sid: "sid-1",
            pair_status: "matched",
          }),
        );
      } else if (message.type === "data") {
        try {
          const result = peer.accept(message.payload);
          if (result.kind === "ready") {
            socket.send(
              JSON.stringify({
                type: "data",
                payload: peer.prepare({
                  zcode_type: "app-error",
                  reason: "unexpected-error",
                  error: `epoch-${peerEpoch}`,
                }),
              }),
            );
          }
        } catch {
          // 测试替身只驱动协议流。
        }
      }
    });
    const transport = new WebRemoteControlTerminalTransport({
      relayWsUrl: relay.url,
      deviceSid: "sid-1",
      passHash: "relay-known",
      e2eeKey: key,
      WebSocketCtor: WebSocket as unknown as typeof globalThis.WebSocket,
      authProvider: { calculateProof: async () => "proof" },
      onPayload: (payload) => received.push(payload),
      onStateChange: (state) => states.push(state),
      onFailure: (failure) => failures.push(failure),
      onError: () => {},
      reloadPage: () => {},
    });
    try {
      transport.start();
      await waitUntil(() => states.includes("paired") && received.length === 1, 3_000);
      // 合法 schema 但阶段错误的握手帧（手机已 ready）→ 废弃会话并重建 socket 恢复，
      // 不再进失败页。
      peerSocket!.send(
        JSON.stringify({
          type: "data",
          payload: {
            zcode_type: "e2ee-response",
            v: 1,
            sid: "sid-1",
            publicKey: "A".repeat(43),
            nonce: "A".repeat(22),
            proof: "A".repeat(43),
          },
        }),
      );
      await waitUntil(() => received.length === 2, 3_000);
      expect(received[1]).toMatchObject({
        codez_type: "app-error",
        error: "epoch-2",
      });
      expect(failures).toHaveLength(0);
      expect(relay.getConnectionCount()).toBe(2);
      expect(states).toContain("reconnecting");
      expect(states).not.toContain("error");
    } finally {
      transport.dispose();
    }
  });
  it("ignores e2ee-rekey while a handshake is in flight and completes pairing", async () => {
    // 回归：桌面 matched 后必发 rekey，与手机 hello 交叉到达。若握手中段响应 rekey
    // 重置会话，手机收到的 response 将对应已废弃的 hello，proof 必失败并触发重建，
    // 与桌面 waiting→matched 的 rekey 形成无限活锁（扫码后无限失败重试）。
    const key = generateWebRemoteControlPairingKey();
    const states: WebRemoteControlTerminalTransportState[] = [];
    const received: WebRemoteControlAppPayload[] = [];
    const failures: WebRemoteControlFailure[] = [];
    let peer: ReturnType<typeof createWebRemoteControlE2eeSession>;
    let resetCount = 0;
    let helloCount = 0;
    const relay = await createRelayServer(({ message, socket }) => {
      if (message.type === "auth_init") {
        socket.send(JSON.stringify({ type: "auth_challenge", nonce: "nonce-1" }));
      } else if (message.type === "auth_response") {
        peer = createWebRemoteControlE2eeSession({
          role: "device",
          deviceSid: "sid-1",
          pairingKey: key,
          send: (payload) => socket.send(JSON.stringify({ type: "data", payload })),
        });
        peer.start();
        socket.send(
          JSON.stringify({ type: "auth_ack", device_sid: "sid-1", pair_status: "matched" }),
        );
        // 模拟桌面 matched 后紧随的 rekey，与手机 hello 交叉。
        socket.send(
          JSON.stringify({
            type: "data",
            payload: { zcode_type: "e2ee-rekey", v: 1, sid: "sid-1", nonce: "A".repeat(22) },
          }),
        );
      } else if (message.type === "data") {
        const wire = message.payload;
        if (wire?.zcode_type === "e2ee-hello") helloCount += 1;
        try {
          const result = peer.accept(wire);
          if (result.kind === "ready") {
            socket.send(
              JSON.stringify({
                type: "data",
                payload: peer.prepare({
                  zcode_type: "app-error",
                  reason: "unexpected-error",
                  error: "paired",
                }),
              }),
            );
          }
        } catch {
          // 测试替身只驱动协议流。
        }
      }
    });
    const transport = new WebRemoteControlTerminalTransport({
      relayWsUrl: relay.url,
      deviceSid: "sid-1",
      passHash: "relay-known",
      e2eeKey: key,
      WebSocketCtor: WebSocket as unknown as typeof globalThis.WebSocket,
      authProvider: { calculateProof: async () => "proof" },
      onPayload: (payload) => received.push(payload),
      onStateChange: (state) => states.push(state),
      onFailure: (failure) => failures.push(failure),
      onE2eeReset: () => {
        resetCount += 1;
      },
      onError: () => {},
      reloadPage: () => {},
    });
    try {
      transport.start();
      await waitUntil(() => states.includes("paired") && received.length === 1, 3_000);
      // 握手中段的 rekey 被忽略：全程只发一次 hello、不重置会话、不失败。
      expect(helloCount).toBe(1);
      expect(resetCount).toBe(0);
      expect(failures).toHaveLength(0);
      expect(relay.getConnectionCount()).toBe(1);
    } finally {
      transport.dispose();
    }
  });
  it("uses the measured final JSON verbatim for initial send and replay", async () => {
    const states: WebRemoteControlTerminalTransportState[] = [];
    const relay = await createRelayServer(({ message, socket }) => {
      if (message.type === "auth_init") {
        socket.send(JSON.stringify({ type: "auth_challenge", nonce: "nonce-1" }));
      }
      if (message.type === "auth_response") {
        socket.send(
          JSON.stringify({
            type: "auth_ack",
            device_sid: "sid-1",
            pair_status: "matched",
          }),
        );
      }
    });
    const transport = new WebRemoteControlTerminalTransport({
      relayWsUrl: relay.url,
      deviceSid: "sid-1",
      passHash: "hash-1",
      deviceMid: "mid-1",
      WebSocketCtor: WebSocket as unknown as typeof globalThis.WebSocket,
      authProvider: { calculateProof: async () => "proof" },
      onPayload: () => {},
      onStateChange: (state) => states.push(state),
      onFailure: () => {},
      onError: () => {},
      reloadPage: () => {},
    });

    try {
      transport.start();
      await waitUntil(() => states.includes("paired"), 2_000);
      const [frame] = encodeWebRemoteControlRpcTransportMessage(new Uint8Array([1, 2, 3]), {
        bridgeSessionId: "bridge-1",
        firstPhysicalSeq: 1,
        messageSeq: 1,
      });
      const measuredBytes = transport.measurePayloadBytes(frame);

      expect(transport.sendPayloadResult(frame)).toMatchObject({
        kind: "sent",
        bytes: measuredBytes,
      });
      expect(transport.sendPayloadResult(frame)).toMatchObject({
        kind: "sent",
        bytes: measuredBytes,
      });
      await waitUntil(
        () => relay.messages.filter((message) => message.type === "data").length === 2,
        2_000,
      );

      const dataJson = relay.rawMessages.filter(
        (raw) => (JSON.parse(raw) as { type?: string }).type === "data",
      );
      expect(dataJson).toHaveLength(2);
      expect(dataJson[1]).toBe(dataJson[0]);
      expect(new TextEncoder().encode(dataJson[0]).byteLength).toBe(measuredBytes);
    } finally {
      transport.dispose();
    }
  });

  it("accepts exactly 1MiB inbound JSON and faults 1MiB+1 before app routing", async () => {
    const payloads: WebRemoteControlAppPayload[] = [];
    const rawFaults: string[] = [];
    const exact = createRelayDataJsonWithExactBytes(
      WEB_REMOTE_CONTROL_RPC_TRANSPORT_LIMITS.maxPhysicalFrameBytes,
    );
    const oversize = createRelayDataJsonWithExactBytes(
      WEB_REMOTE_CONTROL_RPC_TRANSPORT_LIMITS.maxPhysicalFrameBytes + 1,
    );
    const relay = await createRelayServer(({ message, socket }) => {
      if (message.type === "auth_init") {
        socket.send(JSON.stringify({ type: "auth_challenge", nonce: "nonce-1" }));
      }
      if (message.type === "auth_response") {
        socket.send(
          JSON.stringify({
            type: "auth_ack",
            device_sid: "sid-1",
            pair_status: "matched",
          }),
        );
        socket.send(exact);
        socket.send(oversize);
      }
    });
    const transport = new WebRemoteControlTerminalTransport({
      relayWsUrl: relay.url,
      deviceSid: "sid-1",
      passHash: "hash-1",
      deviceMid: "mid-1",
      WebSocketCtor: WebSocket as unknown as typeof globalThis.WebSocket,
      authProvider: { calculateProof: async () => "proof" },
      onPayload: (payload) => payloads.push(payload),
      onRawTransportFault: (reasonCode) => rawFaults.push(reasonCode),
      onStateChange: () => {},
      onFailure: () => {},
      onError: () => {},
      reloadPage: () => {},
    });

    try {
      transport.start();
      await waitUntil(() => payloads.length === 1 && rawFaults.length === 1, 5_000);

      expect(payloads[0]).toMatchObject({
        codez_type: "app-error",
        reason: "unexpected-error",
      });
      expect(rawFaults).toEqual(["remote.rpcFrame.envelopeTooLarge"]);
    } finally {
      transport.dispose();
    }
  });

  it("distinguishes temporary unavailability from permanent envelope oversize", () => {
    const transport = new WebRemoteControlTerminalTransport({
      relayWsUrl: "ws://127.0.0.1:1/ws",
      deviceSid: "sid-1",
      passHash: "hash-1",
      WebSocketCtor: WebSocket as unknown as typeof globalThis.WebSocket,
      authProvider: { calculateProof: async () => "proof" },
      onPayload: () => {},
      onStateChange: () => {},
      onFailure: () => {},
      onError: () => {},
      reloadPage: () => {},
    });

    expect(
      transport.sendPayloadResult({
        codez_type: "app-error",
        reason: "unexpected-error",
        error: "bounded",
      }),
    ).toEqual({ kind: "unavailable" });
    expect(
      transport.sendPayloadResult({
        codez_type: "app-error",
        reason: "unexpected-error",
        error: "x".repeat(WEB_REMOTE_CONTROL_RPC_TRANSPORT_LIMITS.maxPhysicalFrameBytes),
      }),
    ).toMatchObject({ kind: "oversize" });
  });

  it("negotiates permessage-deflate with relay and reports compressed outbound frames", async () => {
    const diagnostics: Array<Record<string, unknown>> = [];
    const states: WebRemoteControlTerminalTransportState[] = [];
    const relay = await createRelayServer(
      ({ message, socket }) => {
        if (message.type === "auth_init") {
          socket.send(JSON.stringify({ type: "auth_challenge", nonce: "nonce-1" }));
        }
        if (message.type === "auth_response") {
          socket.send(
            JSON.stringify({
              type: "auth_ack",
              device_sid: "sid-1",
              pair_status: "matched",
            }),
          );
        }
      },
      { perMessageDeflate: true },
    );

    const transport = new WebRemoteControlTerminalTransport({
      relayWsUrl: relay.url,
      deviceSid: "sid-1",
      passHash: "hash-1",
      deviceMid: "mid-1",
      WebSocketCtor: WebSocket as unknown as typeof globalThis.WebSocket,
      heartbeatIntervalMs: 20,
      authProvider: { calculateProof: async () => "proof" },
      onPayload: () => {},
      onStateChange: (state) => states.push(state),
      onFailure: () => {},
      onError: () => {},
      onDiagnostic: (diagnostic) =>
        diagnostics.push(diagnostic as unknown as Record<string, unknown>),
      reloadPage: () => {},
    });

    transport.start();
    // Bugfix: permessage-deflate 握手和大 payload 压缩都走真实 ws/socket，CI 全量并发时
    // event loop 可能被其它用例挤压；这里放宽等待并标注阶段，避免 500ms 抖动误报且便于定位。
    await waitUntil(
      () => relay.messages.some((message) => message.type === "auth_response"),
      2_000,
      "compressed relay auth response",
    );
    await waitUntil(
      () => diagnostics.some((diagnostic) => diagnostic.type === "socket-extensions"),
      2_000,
      "compressed relay socket extensions",
    );
    await waitUntil(() => states.includes("paired"), 2_000, "compressed relay paired state");

    transport.sendPayload({
      codez_type: "workspace-list-request",
      requestId: "req-compressed",
      padding: "x".repeat(4096),
    } as WebRemoteControlAppPayload);
    await waitUntil(
      () => relay.messages.some((message) => message.type === "data"),
      2_000,
      "compressed relay outbound data",
    );

    expect(String(relay.getRequestExtensions())).toContain("permessage-deflate");
    expect(diagnostics.find((diagnostic) => diagnostic.type === "socket-extensions")).toMatchObject(
      {
        perMessageDeflate: true,
      },
    );
    expect(relay.getClientCompressedFrames()).toContain(true);
    transport.dispose();
  });

  it("authenticates as terminal with mid query and heartbeats after pairing", async () => {
    const states: WebRemoteControlTerminalTransportState[] = [];
    const relay = await createRelayServer(({ message, socket }) => {
      if (message.type === "auth_init") {
        socket.send(JSON.stringify({ type: "auth_challenge", nonce: "nonce-1" }));
      }
      if (message.type === "auth_response") {
        socket.send(
          JSON.stringify({
            type: "auth_ack",
            device_sid: "sid-1",
            pair_status: "matched",
          }),
        );
      }
    });

    const transport = new WebRemoteControlTerminalTransport({
      relayWsUrl: relay.url,
      deviceSid: "sid-1",
      passHash: "hash-1",
      deviceMid: "mid-1",
      WebSocketCtor: WebSocket as unknown as typeof globalThis.WebSocket,
      heartbeatIntervalMs: 20,
      authProvider: {
        calculateProof: async (_passHash, nonce, role, deviceSid) =>
          `${nonce}:${role}:${deviceSid}:proof`,
      },
      onPayload: () => {},
      onStateChange: (state) => states.push(state),
      onFailure: () => {},
      onError: () => {},
      reloadPage: () => {},
    });

    transport.start();
    await waitUntil(() => relay.messages.some((message) => message.type === "pair_status_query"));

    expect(relay.getRequestUrl()).toBe("/ws?mid=mid-1");
    expect(relay.messages[0]).toMatchObject({
      type: "auth_init",
      role: "terminal",
      device_sid: "sid-1",
    });
    expect(relay.messages.find((message) => message.type === "auth_response")).toMatchObject({
      proof: "nonce-1:terminal:sid-1:proof",
    });
    expect(states).toContain("paired");
    transport.dispose();
  });

  it("notifies send readiness when a stale waiting heartbeat recovers to matched", async () => {
    let heartbeatCount = 0;
    const sendReady = vi.fn();
    const relay = await createRelayServer(({ message, socket }) => {
      if (message.type === "auth_init") {
        socket.send(JSON.stringify({ type: "auth_challenge", nonce: "nonce-1" }));
      }
      if (message.type === "auth_response") {
        socket.send(
          JSON.stringify({
            type: "auth_ack",
            device_sid: "sid-1",
            pair_status: "matched",
          }),
        );
      }
      if (message.type === "pair_status_query") {
        heartbeatCount += 1;
        socket.send(
          JSON.stringify({
            type: "pair_status_ack",
            device_sid: "sid-1",
            pair_status: heartbeatCount === 1 ? "waiting" : "matched",
          }),
        );
      }
    });

    const transport = new WebRemoteControlTerminalTransport({
      relayWsUrl: relay.url,
      deviceSid: "sid-1",
      passHash: "hash-1",
      deviceMid: "mid-1",
      WebSocketCtor: WebSocket as unknown as typeof globalThis.WebSocket,
      heartbeatIntervalMs: 100,
      authProvider: { calculateProof: async () => "proof" },
      onPayload: () => {},
      onStateChange: () => {},
      onFailure: () => {},
      onError: () => {},
      onSendReady: sendReady,
      reloadPage: () => {},
    });

    transport.start();
    // Bugfix: 服务端收到第 2 次 heartbeat 不代表客户端已经处理 matched ACK。
    // 这里直接等待 onSendReady，避免全量并发测试时断言抢在 WebSocket message 回调前执行。
    await waitUntil(() => sendReady.mock.calls.length === 1, 2_000);

    expect(sendReady).toHaveBeenCalledOnce();
    expect(sendReady).toHaveBeenCalledWith({ kind: "same-socket" });
    transport.dispose();
  });

  it("keeps retrying pair status on the same socket when a paired session returns waiting", async () => {
    let heartbeatCount = 0;
    let authResponseCount = 0;
    const failures: string[] = [];
    const states: WebRemoteControlTerminalTransportState[] = [];
    const relay = await createRelayServer(({ message, socket }) => {
      if (message.type === "auth_init") {
        socket.send(JSON.stringify({ type: "auth_challenge", nonce: "nonce-1" }));
      }
      if (message.type === "auth_response") {
        authResponseCount += 1;
        socket.send(
          JSON.stringify({
            type: "auth_ack",
            device_sid: "sid-1",
            pair_status: "matched",
          }),
        );
      }
      if (message.type === "pair_status_query") {
        heartbeatCount += 1;
        socket.send(
          JSON.stringify({
            type: "pair_status_ack",
            device_sid: "sid-1",
            pair_status: heartbeatCount === 1 ? "waiting" : "matched",
          }),
        );
      }
    });

    const transport = new WebRemoteControlTerminalTransport({
      relayWsUrl: relay.url,
      deviceSid: "sid-1",
      passHash: "hash-1",
      deviceMid: "mid-1",
      WebSocketCtor: WebSocket as unknown as typeof globalThis.WebSocket,
      heartbeatIntervalMs: 50,
      staleWaitingRecoveryMs: 80,
      authProvider: { calculateProof: async () => "proof" },
      onPayload: () => {},
      onStateChange: (state) => states.push(state),
      onFailure: (failure) => failures.push(failure.reason),
      onError: () => {},
      reloadPage: () => {},
    });

    transport.start();
    await waitUntil(() => heartbeatCount >= 2, 5_000, "second pair status heartbeat");
    await waitUntil(
      () => states.at(-1) === "paired",
      5_000,
      "paired again after waiting heartbeat",
    );

    expect(failures).toEqual([]);
    expect(states).toContain("waiting");
    expect(authResponseCount).toBe(1);
    expect(relay.getConnectionCount()).toBe(1);
    transport.dispose();
  });

  it("stays on the same terminal socket when a paired heartbeat returns waiting", async () => {
    const states: WebRemoteControlTerminalTransportState[] = [];
    const relay = await createRelayServer(({ message, socket }) => {
      if (message.type === "auth_init") {
        socket.send(JSON.stringify({ type: "auth_challenge", nonce: "nonce-1" }));
      }
      if (message.type === "auth_response") {
        socket.send(
          JSON.stringify({
            type: "auth_ack",
            device_sid: "sid-1",
            pair_status: "matched",
          }),
        );
      }
      if (message.type === "pair_status_query") {
        socket.send(
          JSON.stringify({
            type: "pair_status_ack",
            device_sid: "sid-1",
            pair_status: "waiting",
          }),
        );
      }
    });

    const transport = new WebRemoteControlTerminalTransport({
      relayWsUrl: relay.url,
      deviceSid: "sid-1",
      passHash: "hash-1",
      deviceMid: "mid-1",
      WebSocketCtor: WebSocket as unknown as typeof globalThis.WebSocket,
      heartbeatIntervalMs: 20,
      authProvider: { calculateProof: async () => "proof" },
      onPayload: () => {},
      onStateChange: (state) => states.push(state),
      onFailure: () => {},
      onError: () => {},
      reloadPage: () => {},
    });

    transport.start();
    await waitUntil(() => relay.messages.some((message) => message.type === "pair_status_query"));
    await waitUntil(() => states.includes("waiting"), 2_000);
    await new Promise((resolve) => setTimeout(resolve, 80));

    expect(relay.getConnectionCount()).toBe(1);

    transport.dispose();
  });

  it("emits pair status diagnostics only when the summary changes", async () => {
    const diagnostics: string[] = [];
    let heartbeatCount = 0;
    const relay = await createRelayServer(({ message, socket }) => {
      if (message.type === "auth_init") {
        socket.send(JSON.stringify({ type: "auth_challenge", nonce: "nonce-1" }));
      }
      if (message.type === "auth_response") {
        socket.send(
          JSON.stringify({
            type: "auth_ack",
            device_sid: "sid-1",
            pair_status: "matched",
          }),
        );
      }
      if (message.type === "pair_status_query") {
        heartbeatCount += 1;
        socket.send(
          JSON.stringify({
            type: "pair_status_ack",
            device_sid: "sid-1",
            pair_status: heartbeatCount < 3 ? "waiting" : "matched",
          }),
        );
      }
    });

    const transport = new WebRemoteControlTerminalTransport({
      relayWsUrl: relay.url,
      deviceSid: "sid-1",
      passHash: "hash-1",
      deviceMid: "mid-1",
      WebSocketCtor: WebSocket as unknown as typeof globalThis.WebSocket,
      heartbeatIntervalMs: 20,
      authProvider: { calculateProof: async () => "proof" },
      onPayload: () => {},
      onStateChange: () => {},
      onFailure: () => {},
      onError: () => {},
      onDiagnostic: (diagnostic) => {
        if (diagnostic.type === "pair-status") {
          diagnostics.push(`${diagnostic.state}:${diagnostic.pairStatus}`);
        }
      },
      reloadPage: () => {},
    });

    transport.start();
    await waitUntil(() => heartbeatCount >= 3, 2_000);

    expect(diagnostics.filter((diagnostic) => diagnostic === "paired:waiting")).toHaveLength(1);
    expect(relay.getConnectionCount()).toBe(1);
    transport.dispose();
  });

  it("can recover the terminal socket and wait for a fresh pairing", async () => {
    const states: WebRemoteControlTerminalTransportState[] = [];
    const relay = await createRelayServer(({ message, socket }) => {
      if (message.type === "auth_init") {
        socket.send(JSON.stringify({ type: "auth_challenge", nonce: "nonce-1" }));
      }
      if (message.type === "auth_response") {
        socket.send(
          JSON.stringify({
            type: "auth_ack",
            device_sid: "sid-1",
            pair_status: "matched",
          }),
        );
      }
    });

    const transport = new WebRemoteControlTerminalTransport({
      relayWsUrl: relay.url,
      deviceSid: "sid-1",
      passHash: "hash-1",
      deviceMid: "mid-1",
      WebSocketCtor: WebSocket as unknown as typeof globalThis.WebSocket,
      authProvider: { calculateProof: async () => "proof" },
      onPayload: () => {},
      onStateChange: (state) => states.push(state),
      onFailure: () => {},
      onError: () => {},
      reloadPage: () => {},
    });

    transport.start();
    await waitUntil(() => states.includes("paired"));

    await transport.recoverConnection();

    expect(relay.getConnectionCount()).toBeGreaterThan(1);
    expect(states.filter((state) => state === "paired")).toHaveLength(2);
    transport.dispose();
  });

  it("reconnects instead of reloading when a paired terminal socket closes", async () => {
    const states: WebRemoteControlTerminalTransportState[] = [];
    const reloadPage = vi.fn();
    const sendReady = vi.fn();
    let closedFirstPairedSocket = false;
    const relay = await createRelayServer(({ message, socket }) => {
      if (message.type === "auth_init") {
        socket.send(JSON.stringify({ type: "auth_challenge", nonce: "nonce-1" }));
      }
      if (message.type === "auth_response") {
        socket.send(
          JSON.stringify({
            type: "auth_ack",
            device_sid: "sid-1",
            pair_status: "matched",
          }),
        );
        if (!closedFirstPairedSocket) {
          closedFirstPairedSocket = true;
          socket.close(1001);
        }
      }
    });

    const transport = new WebRemoteControlTerminalTransport({
      relayWsUrl: relay.url,
      deviceSid: "sid-1",
      passHash: "hash-1",
      deviceMid: "mid-1",
      WebSocketCtor: WebSocket as unknown as typeof globalThis.WebSocket,
      authProvider: { calculateProof: async () => "proof" },
      onPayload: () => {},
      onStateChange: (state) => states.push(state),
      onFailure: () => {},
      onError: () => {},
      onSendReady: sendReady,
      reloadPage,
    });

    transport.start();
    await waitUntil(() => relay.getConnectionCount() > 1, 2_000);
    await waitUntil(() => states.filter((state) => state === "paired").length === 2, 2_000);

    expect(states).toContain("reconnecting");
    expect(reloadPage).not.toHaveBeenCalled();
    expect(sendReady).toHaveBeenCalledOnce();
    expect(sendReady).toHaveBeenCalledWith({ kind: "reconnected-socket" });
    transport.dispose();
  });

  it("recovers from INTERNAL relay errors without surfacing terminal failure", async () => {
    const states: WebRemoteControlTerminalTransportState[] = [];
    const failures: string[] = [];
    let shouldReturnInternal = true;
    const relay = await createRelayServer(({ message, socket }) => {
      if (message.type === "auth_init" && shouldReturnInternal) {
        shouldReturnInternal = false;
        socket.send(
          JSON.stringify({
            type: "error",
            code: "INTERNAL",
            message: "relay internal bounce",
          }),
        );
        socket.close();
        return;
      }
      if (message.type === "auth_init") {
        socket.send(JSON.stringify({ type: "auth_challenge", nonce: "nonce-1" }));
      }
      if (message.type === "auth_response") {
        socket.send(
          JSON.stringify({
            type: "auth_ack",
            device_sid: "sid-1",
            pair_status: "matched",
          }),
        );
      }
    });

    const transport = new WebRemoteControlTerminalTransport({
      relayWsUrl: relay.url,
      deviceSid: "sid-1",
      passHash: "hash-1",
      WebSocketCtor: WebSocket as unknown as typeof globalThis.WebSocket,
      authProvider: { calculateProof: async () => "proof" },
      onPayload: () => {},
      onStateChange: (state) => states.push(state),
      onFailure: (failure) => failures.push(failure.reason),
      onError: () => {},
      reloadPage: () => {},
    });

    transport.start();
    await waitUntil(() => relay.getConnectionCount() > 1, 2_000);
    await waitUntil(() => states.includes("paired"), 2_000);

    expect(failures).toEqual([]);
    transport.dispose();
  });

  it("keeps the paired terminal socket open for no-pair INTERNAL errors", async () => {
    const errors: string[] = [];
    const states: WebRemoteControlTerminalTransportState[] = [];
    const relay = await createRelayServer(({ message, socket }) => {
      if (message.type === "auth_init") {
        socket.send(JSON.stringify({ type: "auth_challenge", nonce: "nonce-1" }));
      }
      if (message.type === "auth_response") {
        socket.send(
          JSON.stringify({
            type: "auth_ack",
            device_sid: "sid-1",
            pair_status: "matched",
          }),
        );
      }
      if (message.type === "data") {
        socket.send(
          JSON.stringify({
            type: "error",
            code: "INTERNAL",
            message: "no such pair",
          }),
        );
      }
      if (message.type === "pair_status_query") {
        socket.send(
          JSON.stringify({
            type: "pair_status_ack",
            device_sid: "sid-1",
            pair_status: "waiting",
          }),
        );
      }
    });

    const transport = new WebRemoteControlTerminalTransport({
      relayWsUrl: relay.url,
      deviceSid: "sid-1",
      passHash: "hash-1",
      deviceMid: "mid-1",
      WebSocketCtor: WebSocket as unknown as typeof globalThis.WebSocket,
      heartbeatIntervalMs: 20,
      authProvider: { calculateProof: async () => "proof" },
      onPayload: () => {},
      onStateChange: (state) => states.push(state),
      onFailure: () => {},
      onError: (error) => errors.push(error.message),
      reloadPage: () => {},
    });

    transport.start();
    await waitUntil(() => states.includes("paired"));
    const sent = transport.sendPayload({
      codez_type: "bootstrap-request",
      requestId: "req-1",
    });

    await waitUntil(() => states.includes("waiting"));
    await new Promise((resolve) => setTimeout(resolve, 80));

    expect(sent).toBe(true);
    expect(errors).toEqual(["no such pair"]);
    expect(relay.getConnectionCount()).toBe(1);
    transport.dispose();
  });

  it("keeps a hidden paired session suspended until explicit recovery", async () => {
    const states: WebRemoteControlTerminalTransportState[] = [];
    const relay = await createRelayServer(({ message, socket }) => {
      if (message.type === "auth_init") {
        socket.send(JSON.stringify({ type: "auth_challenge", nonce: "nonce-1" }));
      }
      if (message.type === "auth_response") {
        socket.send(
          JSON.stringify({
            type: "auth_ack",
            device_sid: "sid-1",
            pair_status: "matched",
          }),
        );
      }
    });

    const transport = new WebRemoteControlTerminalTransport({
      relayWsUrl: relay.url,
      deviceSid: "sid-1",
      passHash: "hash-1",
      deviceMid: "mid-1",
      WebSocketCtor: WebSocket as unknown as typeof globalThis.WebSocket,
      authProvider: { calculateProof: async () => "proof" },
      onPayload: () => {},
      onStateChange: (state) => states.push(state),
      onFailure: () => {},
      onError: () => {},
      reloadPage: () => {},
    });

    transport.start();
    await waitUntil(() => states.includes("paired"));

    transport.suspend();
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(states).toContain("suspended");
    expect(relay.getConnectionCount()).toBe(1);

    await transport.recoverConnection();

    expect(relay.getConnectionCount()).toBeGreaterThan(1);
    expect(states.filter((state) => state === "paired")).toHaveLength(2);
    transport.dispose();
  });

  it("checks a suspended open socket before creating a fresh connection", async () => {
    const states: WebRemoteControlTerminalTransportState[] = [];
    let heartbeatCount = 0;
    const relay = await createRelayServer(({ message, socket }) => {
      if (message.type === "auth_init") {
        socket.send(JSON.stringify({ type: "auth_challenge", nonce: "nonce-1" }));
      }
      if (message.type === "auth_response") {
        socket.send(
          JSON.stringify({
            type: "auth_ack",
            device_sid: "sid-1",
            pair_status: "matched",
          }),
        );
      }
      if (message.type === "pair_status_query") {
        heartbeatCount += 1;
        socket.send(
          JSON.stringify({
            type: "pair_status_ack",
            device_sid: "sid-1",
            pair_status: "matched",
          }),
        );
      }
    });

    const transport = new WebRemoteControlTerminalTransport({
      relayWsUrl: relay.url,
      deviceSid: "sid-1",
      passHash: "hash-1",
      deviceMid: "mid-1",
      WebSocketCtor: WebSocket as unknown as typeof globalThis.WebSocket,
      heartbeatIntervalMs: 1_000,
      authProvider: { calculateProof: async () => "proof" },
      onPayload: () => {},
      onStateChange: (state) => states.push(state),
      onFailure: () => {},
      onError: () => {},
      reloadPage: () => {},
    });

    transport.start();
    await waitUntil(() => states.includes("paired"));

    transport.suspend();
    await transport.recoverConnection();

    expect(relay.getConnectionCount()).toBe(1);
    expect(heartbeatCount).toBeGreaterThan(0);
    expect(states.filter((state) => state === "paired")).toHaveLength(2);
    transport.dispose();
  });

  it("reconnects when paired heartbeats stop receiving acknowledgements", async () => {
    const relay = await createRelayServer(({ message, socket }) => {
      if (message.type === "auth_init") {
        socket.send(JSON.stringify({ type: "auth_challenge", nonce: "nonce-1" }));
      }
      if (message.type === "auth_response") {
        socket.send(
          JSON.stringify({
            type: "auth_ack",
            device_sid: "sid-1",
            pair_status: "matched",
          }),
        );
      }
    });

    const transport = new WebRemoteControlTerminalTransport({
      relayWsUrl: relay.url,
      deviceSid: "sid-1",
      passHash: "hash-1",
      deviceMid: "mid-1",
      WebSocketCtor: WebSocket as unknown as typeof globalThis.WebSocket,
      heartbeatIntervalMs: 20,
      heartbeatAckTimeoutMs: 50,
      authProvider: { calculateProof: async () => "proof" },
      onPayload: () => {},
      onStateChange: () => {},
      onFailure: () => {},
      onError: () => {},
      reloadPage: () => {},
    });

    transport.start();
    await waitUntil(() => relay.messages.some((message) => message.type === "pair_status_query"));
    await waitUntil(() => relay.getConnectionCount() > 1, 2_000);

    transport.dispose();
  });

  it("uses the ACK deadline independently from the next jittered heartbeat", async () => {
    const relay = await createRelayServer(({ message, socket }) => {
      if (message.type === "auth_init") {
        socket.send(JSON.stringify({ type: "auth_challenge", nonce: "nonce-1" }));
      }
      if (message.type === "auth_response") {
        socket.send(
          JSON.stringify({
            type: "auth_ack",
            device_sid: "sid-1",
            pair_status: "matched",
          }),
        );
      }
    });

    const transport = new WebRemoteControlTerminalTransport({
      relayWsUrl: relay.url,
      deviceSid: "sid-1",
      passHash: "hash-1",
      deviceMid: "mid-1",
      WebSocketCtor: WebSocket as unknown as typeof globalThis.WebSocket,
      heartbeatIntervalMs: 5_000,
      heartbeatJitterMs: 0,
      heartbeatAckTimeoutMs: 50,
      reconnectJitterMs: 0,
      authProvider: { calculateProof: async () => "proof" },
      onPayload: () => {},
      onStateChange: () => {},
      onFailure: () => {},
      onError: () => {},
      reloadPage: () => {},
    });

    try {
      transport.start();
      await waitUntil(() => relay.getConnectionCount() > 1, 2_000);
    } finally {
      transport.dispose();
    }
  });

  it("times out a stale waiting state without reloading", async () => {
    const failures: string[] = [];
    const reloadPage = vi.fn();
    const relay = await createRelayServer(({ message, socket }) => {
      if (message.type === "auth_init") {
        socket.send(
          JSON.stringify({
            type: "auth_ack",
            device_sid: "sid-1",
            pair_status: "waiting",
          }),
        );
      }
    });
    const transport = new WebRemoteControlTerminalTransport({
      relayWsUrl: relay.url,
      deviceSid: "sid-1",
      passHash: "hash-1",
      WebSocketCtor: WebSocket as unknown as typeof globalThis.WebSocket,
      waitingTimeoutMs: 20,
      authProvider: { calculateProof: async () => "proof" },
      onPayload: () => {},
      onStateChange: () => {},
      onFailure: (failure) => failures.push(failure.reason),
      onError: () => {},
      reloadPage,
    });

    transport.start();
    await waitUntil(() => failures.length === 1);

    expect(failures).toEqual(["invalid-mobile-connection"]);
    expect(reloadPage).not.toHaveBeenCalled();
    transport.dispose();
  });

  it("retries DEVICE_OFFLINE relay errors before showing desktop disconnected", async () => {
    const failures: string[] = [];
    const states: WebRemoteControlTerminalTransportState[] = [];
    const relay = await createRelayServer(({ message, socket }) => {
      if (message.type === "auth_init") {
        socket.send(
          JSON.stringify({
            type: "error",
            code: "DEVICE_OFFLINE",
            message: "Desktop device is offline.",
          }),
        );
      }
    });
    const transport = new WebRemoteControlTerminalTransport({
      relayWsUrl: relay.url,
      deviceSid: "sid-1",
      passHash: "hash-1",
      WebSocketCtor: WebSocket as unknown as typeof globalThis.WebSocket,
      desktopOfflineGraceMs: 60,
      authProvider: { calculateProof: async () => "proof" },
      onPayload: () => {},
      onStateChange: (state) => states.push(state),
      onFailure: (failure) => failures.push(failure.reason),
      onError: () => {},
      reloadPage: () => {},
    });

    transport.start();
    await waitUntil(() => states.includes("reconnecting"));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(failures).toEqual([]);

    await waitUntil(() => failures.length === 1);

    expect(failures).toEqual(["desktop-disconnected"]);
    transport.dispose();
  });

  it("keeps KICKED relay errors scoped to mobile session conflicts", async () => {
    const failures: string[] = [];
    const relay = await createRelayServer(({ message, socket }) => {
      if (message.type === "auth_init") {
        socket.send(
          JSON.stringify({
            type: "error",
            code: "KICKED",
            message: "Another mobile controller replaced this one.",
          }),
        );
      }
    });
    const transport = new WebRemoteControlTerminalTransport({
      relayWsUrl: relay.url,
      deviceSid: "sid-1",
      passHash: "hash-1",
      WebSocketCtor: WebSocket as unknown as typeof globalThis.WebSocket,
      authProvider: { calculateProof: async () => "proof" },
      onPayload: () => {},
      onStateChange: () => {},
      onFailure: (failure) => failures.push(failure.reason),
      onError: () => {},
      reloadPage: () => {},
    });

    transport.start();
    await waitUntil(() => failures.length === 1);

    expect(failures).toEqual(["session-conflict"]);
    transport.dispose();
  });

  it("maps relay WRONG_PARAM errors to invalid mobile connection failures", async () => {
    const failures: string[] = [];
    const relay = await createRelayServer(({ message, socket }) => {
      if (message.type === "auth_init") {
        socket.send(
          JSON.stringify({
            type: "error",
            code: "WRONG_PARAM",
            message: "bad request",
          }),
        );
      }
    });
    const transport = new WebRemoteControlTerminalTransport({
      relayWsUrl: relay.url,
      deviceSid: "sid-1",
      passHash: "hash-1",
      WebSocketCtor: WebSocket as unknown as typeof globalThis.WebSocket,
      authProvider: { calculateProof: async () => "proof" },
      onPayload: () => {},
      onStateChange: () => {},
      onFailure: (failure) => failures.push(failure.reason),
      onError: () => {},
      reloadPage: () => {},
    });

    transport.start();
    await waitUntil(() => failures.length === 1);

    expect(failures).toEqual(["invalid-mobile-connection"]);
    transport.dispose();
  });

  it.each(["codez_type", "zcode_type"])(
    "drops invalid %s data and forwards parsed payloads only",
    async (discriminator) => {
      const payloads: WebRemoteControlAppPayload[] = [];
      const onRawTransportPayload = vi.fn(() => false);
      const [validFrame] = encodeWebRemoteControlRpcTransportMessage(new Uint8Array([1, 2, 3]), {
        bridgeSessionId: "bridge-1",
        firstPhysicalSeq: 1,
        messageSeq: 1,
      });
      const { codez_type, ...frameFields } = validFrame;
      const wireFrame = { [discriminator]: codez_type, ...frameFields };
      const relay = await createRelayServer(({ message, socket }) => {
        if (message.type === "auth_init") {
          socket.send(
            JSON.stringify({
              type: "auth_ack",
              device_sid: "sid-1",
              pair_status: "matched",
            }),
          );
          socket.send(
            JSON.stringify({
              type: "data",
              payload: { ...wireFrame, seq: -1 },
            }),
          );
          socket.send(
            JSON.stringify({
              type: "data",
              payload: wireFrame,
            }),
          );
        }
      });

      const transport = new WebRemoteControlTerminalTransport({
        relayWsUrl: relay.url,
        deviceSid: "sid-1",
        passHash: "hash-1",
        WebSocketCtor: WebSocket as unknown as typeof globalThis.WebSocket,
        authProvider: { calculateProof: async () => "proof" },
        onPayload: (payload) => payloads.push(payload),
        onRawTransportPayload,
        onStateChange: () => {},
        onFailure: () => {},
        onError: () => {},
        reloadPage: () => {},
      });

      transport.start();
      await waitUntil(() => payloads.length === 1);

      expect(payloads[0]).toMatchObject({ codez_type: "rpc-frame", seq: 1 });
      expect(onRawTransportPayload).toHaveBeenCalledWith(validFrame);
      transport.dispose();
    },
  );

  it("rejects matching pending requests on app errors only", async () => {
    const sent: WebRemoteControlAppPayload[] = [];
    const requester = createWebRemoteControlAppPayloadRequester({
      sendPayload: (payload) => {
        sent.push(payload);
        return true;
      },
      timeoutMs: 100,
    });
    const promise = requester.requestAppPayload(
      { codez_type: "bootstrap-request", requestId: "req-1" },
      (
        payload,
      ): payload is WebRemoteControlAppPayload & {
        codez_type: "bootstrap-response";
      } => payload.codez_type === "bootstrap-response" && payload.requestId === "req-1",
    );

    requester.acceptPayload({
      codez_type: "app-error",
      requestId: "other",
      reason: "unexpected-error",
      error: "unrelated",
    });
    requester.acceptPayload({
      codez_type: "app-error",
      requestId: "req-1",
      reason: "desktop-disconnected",
      error: "closed",
    });

    await expect(promise).rejects.toMatchObject({
      reason: "desktop-disconnected",
    });
    expect(sent).toEqual([{ codez_type: "bootstrap-request", requestId: "req-1" }]);
  });

  it("does not consume unmatched workspace bridge errors", () => {
    const requester = createWebRemoteControlAppPayloadRequester({
      sendPayload: () => true,
      timeoutMs: 100,
    });

    expect(
      requester.acceptPayload({
        codez_type: "workspace-bridge-error",
        requestId: "remote-session-closed:remote-1",
        bridgeSessionId: "bridge-1",
        reason: "desktop-disconnected",
        error: "remote session closed",
      }),
    ).toBe(false);
  });

  it("rejects a pending request immediately when the transport cannot send it", async () => {
    const requester = createWebRemoteControlAppPayloadRequester({
      sendPayload: () => false,
      timeoutMs: 100,
    });

    const promise = requester.requestAppPayload(
      { codez_type: "bootstrap-request", requestId: "req-unsent" },
      (
        payload,
      ): payload is WebRemoteControlAppPayload & {
        codez_type: "bootstrap-response";
      } => payload.codez_type === "bootstrap-response" && payload.requestId === "req-unsent",
    );

    await expect(promise).rejects.toMatchObject({
      reason: "relay-unavailable",
    });
  });

  it("shares one relay recovery across concurrent unavailable requests and retries each once", async () => {
    let recoverCount = 0;
    const attemptsByRequest = new Map<string, number>();
    const requestWithRelayRecovery = createWebRemoteControlRelayRequestRecovery(async () => {
      recoverCount += 1;
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    const request = async (requestId: string) => {
      const attempts = attemptsByRequest.get(requestId) ?? 0;
      attemptsByRequest.set(requestId, attempts + 1);
      if (attempts === 0) {
        throw { reason: "relay-unavailable" };
      }
      return requestId;
    };

    await expect(
      Promise.all([
        requestWithRelayRecovery(() => request("one")),
        requestWithRelayRecovery(() => request("two")),
      ]),
    ).resolves.toEqual(["one", "two"]);

    expect(recoverCount).toBe(1);
    expect(attemptsByRequest).toEqual(
      new Map([
        ["one", 2],
        ["two", 2],
      ]),
    );
  });

  it("allows long-running workspace reconnect requests to override the default timeout", async () => {
    vi.useFakeTimers();
    const sent: WebRemoteControlAppPayload[] = [];
    const requester = createWebRemoteControlAppPayloadRequester({
      sendPayload: (payload) => {
        sent.push(payload);
        return true;
      },
      timeoutMs: 10,
    });
    const promise = requester.requestAppPayload(
      {
        codez_type: "workspace-reconnect-request",
        requestId: "reconnect-1",
        workspaceKey: "remote:docker:demo:/root",
      },
      (
        payload,
      ): payload is Extract<
        WebRemoteControlAppPayload,
        { codez_type: "workspace-reconnect-response" }
      > =>
        payload.codez_type === "workspace-reconnect-response" &&
        payload.requestId === "reconnect-1" &&
        payload.workspaceKey === "remote:docker:demo:/root",
      { timeoutMs: WEB_REMOTE_CONTROL_WORKSPACE_RECONNECT_TIMEOUT_MS },
    );

    await vi.advanceTimersByTimeAsync(11);
    requester.acceptPayload({
      codez_type: "workspace-reconnect-response",
      requestId: "reconnect-1",
      workspaceKey: "remote:docker:demo:/root",
      success: true,
    });

    await expect(promise).resolves.toMatchObject({ success: true });
    expect(sent).toHaveLength(1);
  });
});
