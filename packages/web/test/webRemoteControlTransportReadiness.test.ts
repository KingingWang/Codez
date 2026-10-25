import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocket, WebSocketServer } from "ws";
import type { AddressInfo } from "node:net";
import type { WebRemoteControlAppPayload } from "@codez/shared";
import {
  createWebRemoteControlE2eeSession,
  generateWebRemoteControlPairingKey,
} from "@codez/client";
import {
  WebRemoteControlTerminalTransport,
  createWebRemoteControlAppPayloadRequester,
  createWebRemoteControlRelayRequestRecovery,
} from "#src/web-remote-control/index.js";

type RelayContext = { message: any; socket: import("ws").WebSocket };
type RelayHandler = (context: RelayContext) => void | Promise<void>;

class RelayHarness {
  readonly messages: any[] = [];
  readonly sockets = new Set<import("ws").WebSocket>();
  private connectionCountValue = 0;
  private handler: RelayHandler | undefined;

  constructor(readonly server: WebSocketServer) {}

  static async create(
    handler?: RelayHandler,
    options?: { e2eeKey?: string },
  ): Promise<RelayHarness> {
    const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    const harness = new RelayHarness(server);
    harness.handler = handler;
    await new Promise<void>((resolve) => server.once("listening", resolve));
    const address = server.address() as AddressInfo;
    Object.defineProperty(harness, "url", {
      value: `ws://127.0.0.1:${address.port}/ws`,
    });
    if (options?.e2eeKey) harness.startDesktopE2ee(options.e2eeKey);
    server.on("connection", (socket) => {
      harness.connectionCountValue += 1;
      harness.sockets.add(socket);
      socket.on("close", () => harness.sockets.delete(socket));
      socket.on("message", async (raw) => {
        const message = JSON.parse(raw.toString());
        harness.messages.push(message);
        try {
          await harness.handler?.({ message, socket });
        } catch (error) {
          socket.close();
          harness.server.emit("error", error);
        }
      });
    });
    return harness;
  }

  get url(): string {
    throw new Error("url initialized asynchronously");
  }

  get connectionCount(): number {
    return this.connectionCountValue;
  }

  get e2eeHelloCount(): number {
    return this.messages.filter((message) => message.payload?.zcode_type === "e2ee-hello").length;
  }

  get authCount(): number {
    return this.messages.filter((message) => message.type === "auth_init").length;
  }

  on(handler: RelayHandler): void {
    this.handler = handler;
  }

  startDesktopE2ee(pairingKey: string): void {
    const deviceSession = createWebRemoteControlE2eeSession({
      role: "device",
      deviceSid: "sid-1",
      pairingKey,
      send: (payload) => {
        for (const socket of this.sockets) {
          socket.send(JSON.stringify({ type: "data", payload }));
        }
      },
    });
    const previous = this.handler;
    this.handler = async ({ message, socket }) => {
      // 先等待受控 gate，再交给真实 E2EE session；否则 securing 测试并未暂停握手。
      await previous?.({ message, socket });
      const payload = message.payload;
      if (message.type === "auth_init") {
        socket.send(
          JSON.stringify({ type: "auth_ack", device_sid: "sid-1", pair_status: "matched" }),
        );
        return;
      }
      if (payload?.zcode_type === "e2ee-hello") {
        deviceSession.accept(payload);
        return;
      }
      if (payload?.zcode_type === "e2ee-finish") {
        deviceSession.accept(payload);
      }
    };
  }

  close(): Promise<void> {
    for (const socket of this.sockets) socket.terminate();
    return new Promise((resolve) => this.server.close(() => resolve()));
  }
}

const harnesses: RelayHarness[] = [];

async function createRelay(
  handler?: RelayHandler,
  options?: { e2eeKey?: string },
): Promise<RelayHarness> {
  const harness = await RelayHarness.create(handler, options);
  harnesses.push(harness);
  return harness;
}

function waitUntil(assertion: () => boolean, label: string, timeoutMs = 2_000): Promise<void> {
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

function createTransport(
  relay: RelayHarness,
  overrides: Partial<ConstructorParameters<typeof WebRemoteControlTerminalTransport>[0]> = {},
) {
  const states: string[] = [];
  const tokens: string[] = [];
  const transport = new WebRemoteControlTerminalTransport({
    relayWsUrl: relay.url,
    deviceSid: "sid-1",
    deviceMid: "mid-1",
    WebSocketCtor: WebSocket as unknown as typeof globalThis.WebSocket,
    heartbeatIntervalMs: 60_000,
    getToken: async () => {
      const token = `token-${tokens.length + 1}`;
      tokens.push(token);
      return token;
    },
    onPayload: () => {},
    onStateChange: (state) => states.push(state),
    onFailure: () => {},
    onError: () => {},
    reloadPage: () => {},
    ...overrides,
  });
  return { transport, states, tokens };
}

afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(harnesses.splice(0).map((harness) => harness.close()));
});

describe("WebRemoteControlTerminalTransport.ensureConnectionReady", () => {
  it("健康连接直接复用，不新增 token、auth、socket 或 E2EE hello", async () => {
    const e2eeKey = generateWebRemoteControlPairingKey();
    const relay = await createRelay(undefined, { e2eeKey });
    const { transport, states } = createTransport(relay, { e2eeKey });

    try {
      transport.start();
      await waitUntil(() => states.at(-1) === "paired", "initial encrypted pairing");
      const tokens = relay.messages.filter((message) => message.type === "auth_init").length;
      await Promise.all([
        transport.ensureConnectionReady(),
        transport.ensureConnectionReady(),
        transport.ensureConnectionReady(),
      ]);

      expect(relay.connectionCount).toBe(1);
      expect(relay.authCount).toBe(tokens);
      expect(relay.e2eeHelloCount).toBe(1);
    } finally {
      transport.dispose();
    }
  });

  it("securing 在途握手只等待原 flight，不新增 auth/socket/hello", async () => {
    const e2eeKey = generateWebRemoteControlPairingKey();
    let releaseHello!: (value: void) => void;
    const helloGate = new Promise<void>((resolve) => {
      releaseHello = resolve;
    });
    const relay = await createRelay(
      async ({ message }) => {
        if (message.payload?.zcode_type === "e2ee-hello") await helloGate;
      },
      { e2eeKey },
    );
    const { transport, states } = createTransport(relay, { e2eeKey });

    try {
      transport.start();
      await waitUntil(
        () => states.includes("securing") && relay.e2eeHelloCount === 1,
        "gated securing state",
      );
      const before = {
        auth: relay.authCount,
        sockets: relay.connectionCount,
        hello: relay.e2eeHelloCount,
      };
      const ready = Promise.all([
        transport.ensureConnectionReady({ timeoutMs: 1_000 }),
        transport.ensureConnectionReady({ timeoutMs: 2_000 }),
      ]);
      releaseHello();
      await ready;

      expect(relay.authCount).toBe(before.auth);
      expect(relay.connectionCount).toBe(before.sockets);
      expect(relay.e2eeHelloCount).toBe(before.hello);
    } finally {
      transport.dispose();
    }
  });

  it("suspended 健康连接沿原 socket 探测复用，坏连接才重建", async () => {
    let healthy = false;
    const relay = await createRelay(({ message, socket }) => {
      if (message.type === "auth_init") {
        socket.send(
          JSON.stringify({ type: "auth_ack", device_sid: "sid-1", pair_status: "matched" }),
        );
      }
      if (message.type === "pair_status_query" && healthy) {
        socket.send(JSON.stringify({ type: "pair_status_ack", pair_status: "matched" }));
      }
    });
    const { transport, states } = createTransport(relay, { healthCheckTimeoutMs: 50 });

    try {
      transport.start();
      await waitUntil(() => states.at(-1) === "paired", "paired before suspension");
      transport.suspend();
      healthy = true;
      await transport.ensureConnectionReady({ timeoutMs: 2_000 });
      expect(relay.connectionCount).toBe(1);

      transport.suspend();
      healthy = false;
      relay.on(({ message, socket }) => {
        if (message.type === "auth_init") {
          socket.send(
            JSON.stringify({ type: "auth_ack", device_sid: "sid-1", pair_status: "matched" }),
          );
        }
        if (message.type === "pair_status_query") healthy = true;
      });
      await transport.ensureConnectionReady({ timeoutMs: 2_000 });
      expect(relay.connectionCount).toBe(2);
    } finally {
      transport.dispose();
    }
  });

  it("并发等待超时后只强制恢复一次，且旧 generation 不再 resolve", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const relay = await createRelay();
    const { transport, states } = createTransport(relay, { healthCheckTimeoutMs: 30 });

    try {
      transport.start();
      await vi.advanceTimersByTimeAsync(1);
      transport.suspend();
      const weak = transport
        .ensureConnectionReady({
          timeoutMs: 20,
          failureReason: "relay-unavailable",
        })
        .then(
          () => "resolved",
          (error: Error) => error.message,
        );
      const strong = transport
        .ensureConnectionReady({
          timeoutMs: 20,
          failureReason: "relay-unavailable",
        })
        .then(
          () => "resolved",
          (error: Error) => error.message,
        );
      await vi.advanceTimersByTimeAsync(19);
      relay.on(({ message, socket }) => {
        if (message.type === "auth_init") {
          socket.send(
            JSON.stringify({ type: "auth_ack", device_sid: "sid-1", pair_status: "matched" }),
          );
        }
      });
      await vi.advanceTimersByTimeAsync(1);
      await vi.advanceTimersByTimeAsync(0);
      await Promise.all([weak, strong]);

      expect(await weak).toBe("resolved");
      expect(await strong).toBe("resolved");
      expect(relay.connectionCount).toBe(2);
      expect(states).toContain("reconnecting");
    } finally {
      transport.dispose();
    }
  });

  it.each(["idle", "error", "kicked"] as const)("终态 %s 拒绝 ensure", async (state) => {
    const relay = await createRelay();
    const { transport } = createTransport(relay);
    (transport as unknown as { state: string }).state = state;
    if (state === "error") {
      (transport as unknown as { intentionallyClosed: boolean }).intentionallyClosed = true;
    }
    await expect(transport.ensureConnectionReady()).rejects.toThrow(/stopped|terminal/i);
    transport.dispose();
  });
});

describe("payload requester recovery contracts", () => {
  it("恢复回调收到真实失败 reason，兼容旧无参回调", async () => {
    const reasons: (string | undefined)[] = [];
    const recover = vi.fn(async (...args: []) => {
      reasons.push(args[0]);
    });
    const recovery = createWebRemoteControlRelayRequestRecovery(recover);
    await expect(
      recovery(() => Promise.reject({ reason: "relay-unavailable" }), {
        recoverUnavailable: true,
      }),
    ).rejects.toEqual({ reason: "relay-unavailable" });
    await expect(
      recovery(() => Promise.reject({ reason: "desktop-bootstrap-timeout" }), {
        recoverTimeout: true,
      }),
    ).rejects.toEqual({ reason: "desktop-bootstrap-timeout" });
    expect(reasons).toEqual(["relay-unavailable", "desktop-bootstrap-timeout"]);
  });

  it("recoverUnavailable=false 保留一次请求重试但不执行 generic 恢复", async () => {
    const recover = vi.fn(async () => {});
    const recovery = createWebRemoteControlRelayRequestRecovery(recover);
    const request = vi.fn(async () => "sent");
    await expect(
      recovery(request, { recoverUnavailable: false, recoverTimeout: true }),
    ).resolves.toBe("sent");
    expect(request).toHaveBeenCalledTimes(1);
    expect(recover).not.toHaveBeenCalled();
  });

  it("requestAppPayload 支持 AbortSignal，abort 清 pending/timer 且不被恢复重试", async () => {
    vi.useFakeTimers();
    const sent: WebRemoteControlAppPayload[] = [];
    const requester = createWebRemoteControlAppPayloadRequester({
      sendPayload: (payload) => {
        sent.push(payload);
        return true;
      },
      timeoutMs: 1_000,
    });
    const controller = new AbortController();
    const request = requester.requestAppPayload(
      { codez_type: "bootstrap-request", requestId: "abort-1" },
      (payload): payload is WebRemoteControlAppPayload =>
        payload.codez_type === "bootstrap-response" && payload.requestId === "abort-1",
      { signal: controller.signal },
    );
    const recover = vi.fn(async () => {});
    const recovery = createWebRemoteControlRelayRequestRecovery(recover);
    const guarded = recovery(() => request, { recoverUnavailable: true });
    controller.abort();
    await expect(guarded).rejects.toMatchObject({ name: "AbortError" });
    expect(sent).toHaveLength(1);
    expect(recover).not.toHaveBeenCalled();
    expect(
      requester.acceptPayload({
        codez_type: "bootstrap-response",
        requestId: "abort-1",
        success: true,
      } as unknown as WebRemoteControlAppPayload),
    ).toBe(false);
  });
});
