import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveWebRemoteControlWebSocketCtor } from "../src/webRemoteControlNativeSocket.js";

interface MockBridge {
  open: ReturnType<typeof vi.fn>;
  sendText: ReturnType<typeof vi.fn>;
  sendBinary: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
}

function installMockBridge(): MockBridge {
  const bridge: MockBridge = {
    open: vi.fn(),
    sendText: vi.fn(() => true),
    sendBinary: vi.fn(() => true),
    close: vi.fn(),
  };
  vi.stubGlobal("window", { CodezAndroidSocket: bridge });
  return bridge;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("resolveWebRemoteControlWebSocketCtor", () => {
  it("无原生桥时回退到全局 WebSocket", () => {
    vi.stubGlobal("window", {});
    const Ctor = resolveWebRemoteControlWebSocketCtor();
    expect(Ctor).toBe(globalThis.WebSocket);
  });

  it("检测到 Android 桥时返回适配构造器并实现浏览器 WebSocket 子集", () => {
    const bridge = installMockBridge();
    const Ctor = resolveWebRemoteControlWebSocketCtor();
    expect(Ctor.OPEN).toBe(1);
    expect(Ctor.CONNECTING).toBe(0);

    const socket = new Ctor("wss://zcode.z.ai/ws");
    expect(bridge.open).toHaveBeenCalledWith(
      expect.any(Number),
      "wss://zcode.z.ai/ws",
    );
    expect(socket.readyState).toBe(0);
    expect(socket.extensions).toBe("");
    expect(() => socket.send("x")).toThrow();
  });

  it("open/message/close 事件经原生回派并按浏览器语义驱动 readyState", () => {
    const bridge = installMockBridge();
    const Ctor = resolveWebRemoteControlWebSocketCtor();
    const socket = new Ctor("wss://zcode.z.ai/ws");
    const id = bridge.open.mock.calls[0][0] as number;

    const events: string[] = [];
    const messages: unknown[] = [];
    socket.addEventListener("open", () => events.push("open"));
    socket.addEventListener("message", (event) =>
      messages.push((event as MessageEvent).data),
    );
    let closeDetail:
      | { code: number; reason: string; wasClean: boolean }
      | undefined;
    socket.addEventListener("close", (event) => {
      const closeEvent = event as CloseEvent;
      closeDetail = {
        code: closeEvent.code,
        reason: closeEvent.reason,
        wasClean: closeEvent.wasClean,
      };
    });

    const sink = (
      window as unknown as { __codezAndroidSocketEvent: CallableFunction }
    ).__codezAndroidSocketEvent;
    expect(typeof sink).toBe("function");

    sink(id, JSON.stringify({ type: "open" }));
    expect(events).toEqual(["open"]);
    expect(socket.readyState).toBe(1);

    sink(id, JSON.stringify({ type: "message", text: "hello" }));
    expect(messages).toEqual(["hello"]);

    sink(id, JSON.stringify({ type: "message", base64: btoa("gzip-bytes") }));
    expect(messages[1]).toBeInstanceOf(ArrayBuffer);
    expect(new TextDecoder().decode(messages[1] as ArrayBuffer)).toBe(
      "gzip-bytes",
    );

    sink(
      id,
      JSON.stringify({
        type: "close",
        code: 1006,
        reason: "lost",
        wasClean: false,
      }),
    );
    expect(socket.readyState).toBe(3);
    expect(closeDetail).toEqual({
      code: 1006,
      reason: "lost",
      wasClean: false,
    });
  });

  it("send 文本原样透传，二进制以 base64 上抛；close 幂等且转发关闭码", () => {
    const bridge = installMockBridge();
    const Ctor = resolveWebRemoteControlWebSocketCtor();
    const socket = new Ctor("wss://zcode.z.ai/ws");
    const id = bridge.open.mock.calls[0][0] as number;
    const sink = (
      window as unknown as { __codezAndroidSocketEvent: CallableFunction }
    ).__codezAndroidSocketEvent;
    sink(id, JSON.stringify({ type: "open" }));

    socket.send("ping");
    expect(bridge.sendText).toHaveBeenCalledWith(id, "ping");

    socket.send(new TextEncoder().encode("bin").buffer as ArrayBuffer);
    expect(bridge.sendBinary).toHaveBeenCalledWith(id, btoa("bin"));

    socket.close(4000, "bye");
    expect(bridge.close).toHaveBeenCalledWith(id, 4000, "bye");
    socket.close(4001, "again");
    expect(bridge.close).toHaveBeenCalledTimes(1);
  });
});
