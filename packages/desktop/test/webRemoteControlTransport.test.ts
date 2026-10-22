import { setTimeout as delay } from "node:timers/promises";
import { EventEmitter, once } from "node:events";
import { gunzipSync } from "node:zlib";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createFakeRelayV2 } from "@codez/shared/testing/fake-relay-v2";
import {
  createWebRemoteControlE2eeSession,
  decodeWebRemoteControlGzipEnvelope,
  generateWebRemoteControlPairingKey,
  WebRemoteControlRelayPayloadSerializer,
} from "@codez/client";
import {
  WEB_REMOTE_CONTROL_CAP_RELAY_GZIP_V1,
  normalizeWebRemoteControlWirePayload,
  parseWebRemoteControlGzipEnvelope,
} from "@codez/shared";
import {
  createWebRemoteControlV2Http,
  WebRemoteControlDeviceTransport,
} from "#src/main/web-remote-relay/index.js";
import { WebSocket } from "ws";

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

async function fixture(
  options: Parameters<typeof createFakeRelayV2>[0] = { users: { jwt: "user" } },
) {
  const relay = await createFakeRelayV2(options);
  cleanups.push(() => relay.close());
  const request = async (path: string, body: unknown) => {
    const response = await fetch(`${relay.httpUrl}/api/v1/remote/${path}`, {
      method: "POST",
      headers: { Authorization: "Bearer jwt", "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    return await response.json();
  };
  const { data: device } = await request("device", { device_mid: "mid-1" });
  const states: string[] = [];
  const stateEvents = new EventEmitter();
  const errors: Error[] = [];
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const transport = new WebRemoteControlDeviceTransport({
    relayWsUrl: relay.wsUrl,
    deviceMid: "mid-1",
    getToken: (signal) => createWebRemoteControlV2Http(relay.httpUrl).token("jwt", signal),
    resolveDeviceSid: async () => device.device_sid,
    meta: { name: "My desktop", platform: "darwin", version: "3.13.0" },
    logger,
    onStateChange: (state) => {
      states.push(state);
      stateEvents.emit(`state:${state}`);
    },
    onError: (error) => errors.push(error),
    onPayload: vi.fn(),
  });
  cleanups.push(() => transport.dispose());
  // 真实 HTTP/WebSocket 不随 fake clock 完成；等状态事件，避免固定延时在负载下抢跑。
  const waitForState = async (state: string) => {
    if (states.at(-1) !== state)
      await once(stateEvents, `state:${state}`, { signal: AbortSignal.timeout(5000) });
  };
  return { relay, transport, states, errors, logger, device, request, waitForState };
}

async function settle() {
  await delay(30);
}

describe("desktop relay V2 transport", () => {
  it("用一次性 token 认证，auth_init 仅发送 V2 字段与秒级时间戳", async () => {
    const { relay, transport, states, device } = await fixture();
    transport.start();
    await vi.waitFor(() => expect(states.at(-1)).toBe("waiting_terminal"));
    expect(relay.messages[0]?.message).toEqual({
      type: "auth_init",
      device_sid: device.device_sid,
      meta: { name: "My desktop", platform: "darwin", version: "3.13.0" },
      client_ts: expect.any(Number),
    });
    expect((relay.messages[0]!.message as { client_ts: number }).client_ts).toBeLessThan(1e11);
    expect(relay.httpCalls.filter((call) => call.path.endsWith("/token"))).toHaveLength(1);
  });
  it("每轮4~6秒心跳不带SID，15秒无ACK独立重连并重新申请token", async () => {
    const { relay, transport, states, waitForState } = await fixture({
      users: { jwt: "user" },
      onMessage: ({ message }) =>
        (message as { type: string }).type === "pair_status_query" ? { drop: true } : undefined,
    });
    transport.start();
    await vi.waitFor(() => expect(states.at(-1)).toBe("waiting_terminal"));
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    // 当前连接的计时器先通过重连在 fake clock 下建立。
    relay.disconnect({ role: "device" });
    await waitForState("connecting");
    await vi.advanceTimersByTimeAsync(1200);
    await waitForState("waiting_terminal");
    expect(states.at(-1)).toBe("waiting_terminal");
    const before = relay.messages.length;
    await vi.advanceTimersByTimeAsync(3999);
    await settle();
    expect(relay.messages).toHaveLength(before);
    await vi.advanceTimersByTimeAsync(2001);
    await settle();
    const query = relay.messages.at(-1)?.message;
    expect(query).toEqual({ type: "pair_status_query", client_ts: expect.any(Number) });
    await vi.advanceTimersByTimeAsync(9000);
    expect(states.at(-1)).toBe("connecting");
    await vi.advanceTimersByTimeAsync(1200);
    await waitForState("waiting_terminal");
    expect(relay.httpCalls.filter((call) => call.path.endsWith("/token"))).toHaveLength(3);
    expect(states.at(-1)).toBe("waiting_terminal");
  });

  it("KICKED首次2~5秒恢复，60秒内再次停止", async () => {
    const { relay, transport, states, waitForState } = await fixture();
    transport.start();
    await vi.waitFor(() => expect(states.at(-1)).toBe("waiting_terminal"));
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    relay.sendError({ role: "device" }, "KICKED");
    await waitForState("connecting");
    await vi.advanceTimersByTimeAsync(1999);
    expect(relay.httpCalls.filter((call) => call.path.endsWith("/token"))).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(3001);
    await waitForState("waiting_terminal");
    expect(states.at(-1)).toBe("waiting_terminal");
    relay.sendError({ role: "device" }, "KICKED");
    await waitForState("kicked");
    expect(states.at(-1)).toBe("kicked");
    await vi.advanceTimersByTimeAsync(120000);
    await settle();
    expect(relay.httpCalls.filter((call) => call.path.endsWith("/token"))).toHaveLength(2);
  });

  it("token网络与5xx指数退避到30秒，auth_ack后重置", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    let failure: "network" | "server" | undefined = "server";
    const f = await fixture({
      users: { jwt: "user" },
      onHttp: (call) => {
        if (call.path.endsWith("/token") && failure)
          return failure === "network" ? { networkError: true } : { status: 503 };
      },
    });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    f.transport.start();
    await settle();
    let count = 1;
    const tokenCalls = () =>
      f.relay.httpCalls.filter((call) => call.path.endsWith("/token")).length;
    for (const ms of [1000, 2000, 4000, 8000, 16000, 30000, 30000]) {
      expect(tokenCalls()).toBe(count);
      await vi.advanceTimersByTimeAsync(ms - 1);
      await settle();
      expect(tokenCalls()).toBe(count);
      await vi.advanceTimersByTimeAsync(1);
      await settle();
      count++;
    }
    failure = undefined;
    await vi.advanceTimersByTimeAsync(30000);
    await f.waitForState("waiting_terminal");
    expect(f.states.at(-1)).toBe("waiting_terminal");
    failure = "network";
    f.relay.disconnect({ role: "device" });
    await settle();
    const before = tokenCalls();
    await vi.advanceTimersByTimeAsync(1000);
    await settle();
    expect(tokenCalls()).toBe(before + 1);
    expect(f.states.at(-1)).toBe("connecting");
  });

  it.each([401, 403, 429])("token HTTP %s 是终止错误且不会自动重连", async (status) => {
    const f = await fixture({
      users: { jwt: "user" },
      onHttp: (call) => (call.path.endsWith("/token") ? { status } : undefined),
    });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    f.transport.start();
    await f.waitForState("error");
    expect(f.states.at(-1)).toBe("error");
    expect(f.errors[0]).toMatchObject({
      reason: status === 401 ? "auth-required" : "relay-unavailable",
    });
    await vi.advanceTimersByTimeAsync(60000);
    expect(f.relay.httpCalls.filter((call) => call.path.endsWith("/token"))).toHaveLength(1);
  });

  it("超过60秒的KICKED重新允许一次恢复", async () => {
    // retry policy 在构造时捕获随机源，必须先注入；否则 3500ms 可能短于真实的随机退避。
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    const f = await fixture();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    f.transport.start();
    await f.waitForState("waiting_terminal");
    f.relay.sendError({ role: "device" }, "KICKED");
    await f.waitForState("connecting");
    await vi.advanceTimersByTimeAsync(3500);
    await f.waitForState("waiting_terminal");
    // 跳过墙钟但不补发心跳，模拟两次KICKED间隔超过窗口。
    vi.setSystemTime(Date.now() + 60000);
    f.relay.sendError({ role: "device" }, "KICKED");
    await f.waitForState("connecting");
    expect(f.states.at(-1)).toBe("connecting");
    await vi.advanceTimersByTimeAsync(3500);
    await f.waitForState("waiting_terminal");
    expect(f.states.at(-1)).toBe("waiting_terminal");
  });

  it("V2配对允许双向payload，terminal断开立即暂停发送并等待再次配对", async () => {
    const f = await fixture();
    f.transport.start();
    await vi.waitFor(() => expect(f.states.at(-1)).toBe("waiting_terminal"));
    expect(f.transport.sendPayload({ codez_type: "bootstrap-request", requestId: "before" })).toBe(
      false,
    );
    const { data } = await f.request("token", { role: "terminal" });
    const terminal = new WebSocket(`${f.relay.wsUrl}?token=${data.token}&mid=mid-1`);
    cleanups.push(() => {
      terminal.close();
    });
    const received: unknown[] = [];
    terminal.on("message", (raw) => received.push(JSON.parse(raw.toString())));
    await new Promise<void>((resolve) => terminal.once("open", resolve));
    terminal.send(JSON.stringify({ type: "auth_init", device_sid: f.device.device_sid }));
    await vi.waitFor(() => expect(f.states.at(-1)).toBe("paired"));
    expect(f.transport.sendPayload({ codez_type: "bootstrap-request", requestId: "paired" })).toBe(
      true,
    );
    await vi.waitFor(() =>
      expect(received).toContainEqual(
        expect.objectContaining({
          type: "data",
          payload: { zcode_type: "bootstrap-request", requestId: "paired" },
        }),
      ),
    );
    terminal.close();
    await vi.waitFor(() => expect(f.states.at(-1)).toBe("waiting_terminal"));
    expect(f.transport.sendPayload({ codez_type: "bootstrap-request", requestId: "after" })).toBe(
      false,
    );
    f.transport.dispose();
    expect(f.logger.info).toHaveBeenCalledWith(
      "[web-remote-control] relay traffic",
      expect.objectContaining({
        direction: "device-to-terminal",
        frameCount: 1,
        gzipFrameCount: 0,
        logicalAppBytes: expect.any(Number),
        outerRelayBytes: expect.any(Number),
      }),
    );
  });

  it("逐轮重采样心跳jitter，4秒下界与6秒上界均可观察", async () => {
    const random = vi.spyOn(Math, "random").mockReturnValue(0);
    const f = await fixture();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    f.transport.start();
    await f.waitForState("waiting_terminal");
    const queries = () =>
      f.relay.messages.filter(
        ({ message }) => (message as { type: string }).type === "pair_status_query",
      );
    await vi.advanceTimersByTimeAsync(3999);
    await settle();
    expect(queries()).toHaveLength(0);
    random.mockReturnValue(0.999999);
    await vi.advanceTimersByTimeAsync(1);
    await settle();
    expect(queries()).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(5999);
    await settle();
    expect(queries()).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    await settle();
    expect(queries()).toHaveLength(2);
  });

  it("握手无ACK在15秒deadline后申请新token", async () => {
    const f = await fixture({ users: { jwt: "user" }, onMessage: () => ({ drop: true }) });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    f.transport.start();
    await f.waitForState("authenticating");
    expect(f.states.at(-1)).toBe("authenticating");
    await vi.advanceTimersByTimeAsync(14999);
    expect(f.states.at(-1)).toBe("authenticating");
    await vi.advanceTimersByTimeAsync(1);
    expect(f.states.at(-1)).toBe("connecting");
    await vi.advanceTimersByTimeAsync(1200);
    await settle();
    expect(f.relay.httpCalls.filter((call) => call.path.endsWith("/token"))).toHaveLength(2);
  });

  it("配置 e2eeKey 时在 V2 matched 后先进入 securing 双向证明握手，再传输加密 payload 与 rpc-frame", async () => {
    const relay = await createFakeRelayV2({ users: { jwt: "user" } });
    cleanups.push(() => relay.close());
    const e2eeKey = generateWebRemoteControlPairingKey();
    const response = await fetch(`${relay.httpUrl}/api/v1/remote/device`, {
      method: "POST",
      headers: { Authorization: "Bearer jwt", "Content-Type": "application/json" },
      body: JSON.stringify({ device_mid: "mid-e2ee" }),
    });
    const { data: device } = await response.json();
    const states: string[] = [];
    const payloads: unknown[] = [];
    const rawPayloads: unknown[] = [];
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const transport = new WebRemoteControlDeviceTransport({
      relayWsUrl: relay.wsUrl,
      deviceMid: "mid-e2ee",
      e2eeKey,
      getToken: (signal) => createWebRemoteControlV2Http(relay.httpUrl).token("jwt", signal),
      resolveDeviceSid: async () => device.device_sid,
      meta: { name: "Encrypted desktop", platform: "darwin", version: "3.16.1" },
      logger,
      onStateChange: (state) => states.push(state),
      onError: vi.fn(),
      onPayload: (payload) => payloads.push(payload),
      onRawTransportPayload: (payload) => {
        rawPayloads.push(payload);
        return true;
      },
    });
    cleanups.push(() => transport.dispose());
    transport.start();
    await vi.waitFor(() => expect(states.at(-1)).toBe("waiting_terminal"));

    const tokenRes = await fetch(`${relay.httpUrl}/api/v1/remote/token`, {
      method: "POST",
      headers: { Authorization: "Bearer jwt", "Content-Type": "application/json" },
      body: JSON.stringify({ role: "terminal" }),
    });
    const { data: tokenData } = await tokenRes.json();
    const terminal = new WebSocket(`${relay.wsUrl}?token=${tokenData.token}&mid=mid-e2ee`);
    cleanups.push(() => terminal.close());
    const decryptedByPhone: unknown[] = [];
    const phoneSession = createWebRemoteControlE2eeSession({
      role: "terminal",
      deviceSid: device.device_sid,
      pairingKey: e2eeKey,
      send: (wire) => {
        terminal.send(JSON.stringify({ type: "data", payload: wire, client_ts: 1 }));
      },
    });
    terminal.on("message", (raw) => {
      const message = JSON.parse(raw.toString()) as {
        type: string;
        payload?: unknown;
        pair_status?: string;
      };
      if (message.type === "auth_ack" && message.pair_status === "matched") {
        phoneSession.start();
      } else if (message.type === "data" && message.payload) {
        const wire = message.payload as { zcode_type?: string };
        if (wire.zcode_type === "e2ee-rekey") return;
        const accepted = phoneSession.accept(message.payload);
        if (accepted.kind === "payload") decryptedByPhone.push(accepted.payload);
      }
    });
    await new Promise<void>((resolve) => terminal.once("open", resolve));
    terminal.send(JSON.stringify({ type: "auth_init", device_sid: device.device_sid }));
    await vi.waitFor(() => expect(states).toContain("securing"));
    await vi.waitFor(() => expect(states.at(-1)).toBe("paired"));
    await vi.waitFor(() => expect(phoneSession.isReady()).toBe(true));

    const phoneSerializer = new WebRemoteControlRelayPayloadSerializer({
      seal: (wire) => phoneSession.prepare(wire),
    });
    terminal.send(
      phoneSerializer.prepare({
        codez_type: "client-capabilities",
        v: 1,
        caps: [WEB_REMOTE_CONTROL_CAP_RELAY_GZIP_V1],
      }).json,
    );
    terminal.send(
      phoneSerializer.prepare({ codez_type: "bootstrap-request", requestId: "e2ee-req" }).json,
    );
    await vi.waitFor(() =>
      expect(payloads).toContainEqual({
        codez_type: "bootstrap-request",
        requestId: "e2ee-req",
      }),
    );

    terminal.send(
      phoneSerializer.prepare({
        codez_type: "rpc-frame-ack",
        bridgeSessionId: "b1",
        ackMessageSeq: 1,
      }).json,
    );
    await vi.waitFor(() =>
      expect(rawPayloads).toContainEqual({
        codez_type: "rpc-frame-ack",
        bridgeSessionId: "b1",
        ackMessageSeq: 1,
      }),
    );

    const largePayload = {
      codez_type: "bootstrap-response" as const,
      requestId: "e2ee-gzip",
      success: true as const,
      result: { windowControlSessionId: device.device_sid, text: "x".repeat(8_000) },
    };
    expect(transport.sendPayload(largePayload)).toBe(true);
    await vi.waitFor(() =>
      expect(
        decryptedByPhone
          .map(normalizeWebRemoteControlWirePayload)
          .map(parseWebRemoteControlGzipEnvelope)
          .some((envelope) => envelope !== null),
      ).toBe(true),
    );
    const gzipEnvelope = decryptedByPhone
      .map(normalizeWebRemoteControlWirePayload)
      .map(parseWebRemoteControlGzipEnvelope)
      .find((envelope) => envelope !== null);
    expect(gzipEnvelope).not.toBeNull();
    expect(decodeWebRemoteControlGzipEnvelope(gzipEnvelope!, (bytes) => gunzipSync(bytes))).toEqual(
      largePayload,
    );

    transport.dispose();
    expect(logger.info).toHaveBeenCalledWith(
      "[web-remote-control] relay traffic",
      expect.objectContaining({
        frameCount: 1,
        gzipFrameCount: 1,
      }),
    );
  });
});
