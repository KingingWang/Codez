import { afterEach, describe, expect, it, vi } from "vitest";
import {
  isCodezAndroidApp,
  isCodezBrowserExtension,
  isTrustedWebRemoteControlHost,
  resolveWebRemoteControlFetcher,
  resolveWebRemoteControlWebSocketCtor,
} from "../src/webRemoteControlNativeSocket.js";

interface MockBridge {
  open: ReturnType<typeof vi.fn>;
  sendText: ReturnType<typeof vi.fn>;
  sendBinary: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
  fetch: ReturnType<typeof vi.fn>;
}

function installMockBridge(): MockBridge {
  const bridge: MockBridge = {
    open: vi.fn(),
    sendText: vi.fn(() => true),
    sendBinary: vi.fn(() => true),
    close: vi.fn(),
    fetch: vi.fn(),
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
    expect(isCodezAndroidApp()).toBe(false);
    expect(isCodezBrowserExtension()).toBe(false);
    expect(isTrustedWebRemoteControlHost()).toBe(false);
    const Ctor = resolveWebRemoteControlWebSocketCtor();
    expect(Ctor).toBe(globalThis.WebSocket);
  });

  it("检测到浏览器扩展协议或扩展标识时放行受信任宿主检查", () => {
    vi.stubGlobal("window", { location: { protocol: "chrome-extension:" } });
    expect(isCodezBrowserExtension()).toBe(true);
    expect(isTrustedWebRemoteControlHost()).toBe(true);

    vi.stubGlobal("window", {
      location: { protocol: "https:" },
      __CODEZ_BROWSER_EXTENSION__: true,
    });
    expect(isCodezBrowserExtension()).toBe(true);
    expect(isTrustedWebRemoteControlHost()).toBe(true);
  });

  it("检测到 Android 桥时返回适配构造器并实现浏览器 WebSocket 子集", () => {
    const bridge = installMockBridge();
    expect(isCodezAndroidApp()).toBe(true);
    const Ctor = resolveWebRemoteControlWebSocketCtor();
    expect(Ctor.OPEN).toBe(1);
    expect(Ctor.CONNECTING).toBe(0);

    const socket = new Ctor("wss://zcode.z.ai/ws");
    expect(bridge.open).toHaveBeenCalledWith(expect.any(Number), "wss://zcode.z.ai/ws");
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
    socket.addEventListener("message", (event) => messages.push((event as MessageEvent).data));
    let closeDetail: { code: number; reason: string; wasClean: boolean } | undefined;
    socket.addEventListener("close", (event) => {
      const closeEvent = event as CloseEvent;
      closeDetail = {
        code: closeEvent.code,
        reason: closeEvent.reason,
        wasClean: closeEvent.wasClean,
      };
    });

    const sink = (window as unknown as { __codezAndroidSocketEvent: CallableFunction })
      .__codezAndroidSocketEvent;
    expect(typeof sink).toBe("function");

    sink(id, JSON.stringify({ type: "open" }));
    expect(events).toEqual(["open"]);
    expect(socket.readyState).toBe(1);

    sink(id, JSON.stringify({ type: "message", text: "hello" }));
    expect(messages).toEqual(["hello"]);

    sink(id, JSON.stringify({ type: "message", base64: btoa("gzip-bytes") }));
    expect(messages[1]).toBeInstanceOf(ArrayBuffer);
    expect(new TextDecoder().decode(messages[1] as ArrayBuffer)).toBe("gzip-bytes");

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
    const sink = (window as unknown as { __codezAndroidSocketEvent: CallableFunction })
      .__codezAndroidSocketEvent;
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

  it("resolveWebRemoteControlFetcher 经原生桥转发 HTTP 请求并解析响应", async () => {
    const bridge = installMockBridge();
    const fetcher = resolveWebRemoteControlFetcher();
    const promise = fetcher("https://zcode.z.ai/api/v1/remote/token", {
      method: "POST",
      headers: { Authorization: "Bearer jwt", "Content-Type": "application/json" },
      body: JSON.stringify({ role: "terminal" }),
    });
    expect(bridge.fetch).toHaveBeenCalledWith(
      expect.any(Number),
      "https://zcode.z.ai/api/v1/remote/token",
      "POST",
      JSON.stringify({ Authorization: "Bearer jwt", "Content-Type": "application/json" }),
      JSON.stringify({ role: "terminal" }),
    );
    const id = bridge.fetch.mock.calls[0]![0] as number;
    const sink = (window as unknown as { __codezAndroidHttpEvent: CallableFunction })
      .__codezAndroidHttpEvent;
    sink(
      id,
      JSON.stringify({
        type: "response",
        status: 200,
        body: JSON.stringify({ code: 0, msg: "", data: { token: "tok", expires_in: 60 } }),
      }),
    );
    const response = await promise;
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      code: 0,
      msg: "",
      data: { token: "tok", expires_in: 60 },
    });
  });
});

describe("browser extension HTTP bridge", () => {
  it("callback 晚于 Promise<void> 时仍采用真实 HTTP 响应，不回退页面跨域 fetch", async () => {
    vi.stubGlobal("window", {
      location: {
        href: "orion-extension://codez/index.html",
        protocol: "orion-extension:",
      },
    });
    const pageFetch = vi.fn();
    vi.stubGlobal("fetch", pageFetch);
    const sendMessage = vi.fn(
      (_message: unknown, callback?: (response: unknown) => void): Promise<void> => {
        setTimeout(
          () =>
            callback?.({
              status: 200,
              body: JSON.stringify({ code: 0, data: { token: "terminal-token" } }),
            }),
          0,
        );
        return Promise.resolve();
      },
    );
    vi.stubGlobal("chrome", { runtime: { sendMessage } });

    const response = await resolveWebRemoteControlFetcher()(
      "https://zcode.z.ai/api/v1/remote/token",
      { method: "POST", body: JSON.stringify({ role: "terminal" }) },
    );

    expect(response.status).toBe(200);
    expect((await response.json()).data.token).toBe("terminal-token");
    expect(sendMessage).toHaveBeenCalledOnce();
    expect(pageFetch).not.toHaveBeenCalled();
  });

  it("扩展桥没有回执时明确失败，不向被 Origin 拒绝的页面 fetch 退化", async () => {
    vi.useFakeTimers();
    try {
      vi.stubGlobal("window", {
        location: {
          href: "orion-extension://codez/index.html",
          protocol: "orion-extension:",
        },
      });
      const pageFetch = vi.fn();
      vi.stubGlobal("fetch", pageFetch);
      vi.stubGlobal("chrome", {
        runtime: { sendMessage: vi.fn(() => Promise.resolve()) },
      });

      const request = resolveWebRemoteControlFetcher()("https://zcode.z.ai/api/v1/remote/token");
      const failed = expect(request).rejects.toThrow(/extension-http-bridge-unavailable/);
      await vi.advanceTimersByTimeAsync(15_000);
      await failed;
      expect(pageFetch).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("扩展 HTTP 请求取消后立即结束等待，不使用过期桥接结果", async () => {
    vi.stubGlobal("window", {
      location: {
        href: "orion-extension://codez/index.html",
        protocol: "orion-extension:",
      },
    });
    const pageFetch = vi.fn();
    vi.stubGlobal("fetch", pageFetch);
    let reply: ((response: unknown) => void) | undefined;
    vi.stubGlobal("chrome", {
      runtime: {
        sendMessage: vi.fn((_message: unknown, callback?: (response: unknown) => void): void => {
          reply = callback;
        }),
      },
    });

    const controller = new AbortController();
    const request = resolveWebRemoteControlFetcher()("https://zcode.z.ai/api/v1/remote/token", {
      signal: controller.signal,
    });
    controller.abort();
    await expect(request).rejects.toMatchObject({ name: "AbortError" });
    reply?.({ status: 200, body: "{}" });
    expect(pageFetch).not.toHaveBeenCalled();
  });
});

describe("browser extension WebSocket bridge", () => {
  it("iframe 桥先验来源再交付 WS token，URL 不包含一次性凭据", () => {
    const windowListeners = new Map<string, (event: MessageEvent) => void>();
    const postMessage = vi.fn();
    const iframe = {
      src: "",
      style: { display: "" },
      contentWindow: { postMessage },
      remove: vi.fn(),
    };
    vi.stubGlobal("window", {
      location: { protocol: "orion-extension:" },
      addEventListener: vi.fn((type, listener) => windowListeners.set(type, listener)),
    });
    vi.stubGlobal("document", {
      createElement: vi.fn(() => iframe),
      body: { appendChild: vi.fn() },
    });
    vi.stubGlobal("WebSocket", undefined);
    vi.stubGlobal("chrome", {
      runtime: {
        sendMessage: vi.fn(),
        onMessage: { addListener: vi.fn() },
      },
    });
    const url = "wss://zcode.z.ai/api/v1/remote/ws2?token=one-time-token";
    const socket = new (resolveWebRemoteControlWebSocketCtor())(url);
    const bridgeUrl = new URL(iframe.src);
    const id = bridgeUrl.searchParams.get("codez_ws_iframe_id");
    expect(iframe.src).not.toContain("one-time-token");
    expect(bridgeUrl.hash).toBe("");
    expect(id).toMatch(/^[a-f0-9]{32}$/);

    const onWindowMessage = windowListeners.get("message");
    expect(onWindowMessage).toBeDefined();
    onWindowMessage?.({
      data: { type: "codez-bridge-ready", id },
      origin: "https://attacker.example",
      source: iframe.contentWindow,
    } as unknown as MessageEvent);
    onWindowMessage?.({
      data: { type: "codez-bridge-ready", id },
      origin: "https://zcode.z.ai",
      source: null,
    } as unknown as MessageEvent);
    expect(postMessage).not.toHaveBeenCalled();

    onWindowMessage?.({
      data: { type: "codez-bridge-ready", id },
      origin: "https://zcode.z.ai",
      source: iframe.contentWindow,
    } as unknown as MessageEvent);
    expect(postMessage).toHaveBeenCalledExactlyOnceWith(
      { type: "codez-bridge-ws-open", id, url },
      "https://zcode.z.ai",
    );
    onWindowMessage?.({
      data: { type: "codez-extension-ws-event", id, event: { type: "open" } },
      origin: "https://zcode.z.ai",
      source: iframe.contentWindow,
    } as unknown as MessageEvent);
    expect(socket.readyState).toBe(socket.OPEN);
    socket.close();
  });

  it("重新创建连接时使用不复用的字符串 socket ID，隔离旧页面遗留的后台桥", () => {
    vi.stubGlobal("window", {
      location: { protocol: "orion-extension:" },
      addEventListener: vi.fn(),
      postMessage: vi.fn(),
    });
    vi.stubGlobal("WebSocket", undefined);
    const sendMessage = vi.fn();
    vi.stubGlobal("chrome", {
      runtime: {
        sendMessage,
        onMessage: { addListener: vi.fn() },
      },
    });
    const Ctor = resolveWebRemoteControlWebSocketCtor();

    const first = new Ctor("wss://zcode.z.ai/api/v1/remote/ws2?token=first");
    first.close();
    const second = new Ctor("wss://zcode.z.ai/api/v1/remote/ws2?token=second");
    second.close();

    const opens = sendMessage.mock.calls
      .map(([message]) => message as { type: string; id: unknown })
      .filter((message) => message.type === "codez-extension-ws-open");
    expect(opens).toHaveLength(2);
    expect(opens[0]?.id).toMatch(/^[a-f0-9]{32}$/);
    expect(opens[1]?.id).toMatch(/^[a-f0-9]{32}$/);
    expect(opens[1]?.id).not.toBe(opens[0]?.id);
  });

  it("Orion 的 chrome.runtime 只能发送时选用具备双向消息能力的 browser.runtime", async () => {
    vi.resetModules();
    vi.stubGlobal("window", {
      location: { protocol: "orion-extension:" },
      addEventListener: vi.fn(),
    });
    vi.stubGlobal("document", undefined);
    vi.stubGlobal("WebSocket", undefined);
    const chromeSend = vi.fn();
    const browserSend = vi.fn();
    const browserListen = vi.fn();
    vi.stubGlobal("chrome", { runtime: { sendMessage: chromeSend } });
    vi.stubGlobal("browser", {
      runtime: {
        sendMessage: browserSend,
        onMessage: { addListener: browserListen },
      },
    });
    const { resolveWebRemoteControlWebSocketCtor: resolveCtor } =
      await import("../src/webRemoteControlNativeSocket.js");
    const socket = new (resolveCtor())("wss://zcode.z.ai/api/v1/remote/ws2?token=test");
    expect(chromeSend).not.toHaveBeenCalled();
    expect(browserListen).toHaveBeenCalledOnce();
    expect(browserSend).toHaveBeenCalledWith(
      expect.objectContaining({ type: "codez-extension-ws-open" }),
    );
    socket.close();
  });
});
