/**
 * Android 壳原生 WebSocket 桥。
 *
 * 背景：远控 relay 按握手 `Origin` 头做来源白名单，fork 发布页
 * （kingingwang.github.io）不在白名单内时浏览器/WebView 的 WebSocket 会被 403。
 * Origin 由渲染进程自动附加、页面无法改写，因此 Android 壳用 OkHttp（不带 Origin）
 * 代发 WebSocket，并通过 `window.CodezAndroidSocket` JavascriptInterface 暴露给页面。
 *
 * 本模块提供一个实现浏览器 WebSocket 子集的适配类，覆盖
 * `WebRemoteControlTerminalTransport` 实际用到的 API 面
 * （constructor/addEventListener/send/close/readyState/extensions/binaryType）。
 * E2EE、配对与 RPC 协议仍全部在 JS 侧完成，桥只搬运字节。
 */

/** 原生桥 JavascriptInterface 的方法签名（与 NativeSocketBridge.kt 保持一致）。 */
interface CodezAndroidSocketBridge {
  open(id: number, url: string): void;
  sendText(id: number, text: string): boolean;
  sendBinary(id: number, base64: string): boolean;
  close(id: number, code: number, reason: string): void;
  fetch?(id: number, url: string, method: string, headersJson: string, body: string): void;
}

type NativeSocketEvent =
  | { type: "open"; extensions?: string }
  | { type: "message"; text?: string; base64?: string }
  | { type: "error" }
  | { type: "close"; code: number; reason: string; wasClean: boolean };

type NativeHttpEvent =
  | { type: "response"; status: number; body: string }
  | { type: "error"; message?: string };

declare global {
  interface Window {
    CodezAndroidSocket?: CodezAndroidSocketBridge;
    __codezExtensionFetch?: (request: {
      url: string;
      method: string;
      headers: Record<string, string>;
      body: string;
    }) => Promise<{ status: number; body: string; error?: string }>;
    __CODEZ_BROWSER_EXTENSION__?: boolean;
    __codezAndroidSocketEvent?: (id: number, eventJson: string) => void;
    __codezAndroidHttpEvent?: (id: number, eventJson: string) => void;
  }
}

const BASE64_CHUNK_SIZE = 0x8000;
const EXTENSION_ORIGIN_PROTOCOLS = new Set([
  "chrome-extension:",
  "moz-extension:",
  "safari-web-extension:",
  "orion-extension:",
]);

export function isBrowserExtensionProtocol(protocol: string | undefined): boolean {
  return typeof protocol === "string" && EXTENSION_ORIGIN_PROTOCOLS.has(protocol);
}

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += BASE64_CHUNK_SIZE) {
    binary += String.fromCharCode(
      ...bytes.subarray(offset, offset + BASE64_CHUNK_SIZE),
    );
  }
  return btoa(binary);
}

function base64ToArrayBuffer(base64: string): ArrayBuffer {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes.buffer;
}

type SocketListener = (event: Event) => void;

/**
 * 浏览器 WebSocket 子集适配类。事件目标用最小实现而不是 EventTarget，
 * 避免依赖 WebView 对构造器子类化的支持差异。
 */
class CodezAndroidWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  readonly CONNECTING = 0;
  readonly OPEN = 1;
  readonly CLOSING = 2;
  readonly CLOSED = 3;

  readonly url: string;
  readonly extensions = "";
  readonly protocol = "";
  readonly bufferedAmount = 0;
  binaryType: BinaryType = "arraybuffer";
  readyState: number = CodezAndroidWebSocket.CONNECTING;

  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;

  private readonly id: number;
  private readonly listeners = new Map<string, Set<SocketListener>>();

  constructor(url: string) {
    this.url = url;
    const bridge = window.CodezAndroidSocket;
    if (!bridge) {
      throw new Error("CodezAndroidSocket bridge is not available");
    }
    this.id = nextSocketId();
    registerSocket(this.id, this);
    try {
      bridge.open(this.id, url);
    } catch (error) {
      unregisterSocket(this.id);
      throw error;
    }
  }

  addEventListener(type: string, listener: SocketListener): void {
    let bucket = this.listeners.get(type);
    if (!bucket) {
      bucket = new Set();
      this.listeners.set(type, bucket);
    }
    bucket.add(listener);
  }

  removeEventListener(type: string, listener: SocketListener): void {
    this.listeners.get(type)?.delete(listener);
  }

  send(data: string | ArrayBuffer | ArrayBufferView): void {
    if (this.readyState !== CodezAndroidWebSocket.OPEN) {
      // 与浏览器行为一致：非 OPEN 状态发送抛错。
      throw new Error("WebSocket is not open");
    }
    const bridge = window.CodezAndroidSocket;
    if (!bridge) {
      return;
    }
    if (typeof data === "string") {
      bridge.sendText(this.id, data);
      return;
    }
    const buffer =
      data instanceof ArrayBuffer
        ? data
        : data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
    bridge.sendBinary(this.id, arrayBufferToBase64(buffer as ArrayBuffer));
  }

  close(code = 1000, reason = ""): void {
    if (
      this.readyState === CodezAndroidWebSocket.CLOSING ||
      this.readyState === CodezAndroidWebSocket.CLOSED
    ) {
      return;
    }
    this.readyState = CodezAndroidWebSocket.CLOSING;
    window.CodezAndroidSocket?.close(this.id, code, reason);
  }

  /** 由原生事件回派调用，不在页面业务代码里直接使用。 */
  dispatchNativeEvent(event: NativeSocketEvent): void {
    switch (event.type) {
      case "open":
        if (this.readyState !== CodezAndroidWebSocket.CONNECTING) return;
        this.readyState = CodezAndroidWebSocket.OPEN;
        this.emit("open", new Event("open"));
        break;
      case "message": {
        if (this.readyState !== CodezAndroidWebSocket.OPEN) return;
        const data =
          typeof event.text === "string"
            ? event.text
            : base64ToArrayBuffer(event.base64 ?? "");
        // 不用 MessageEvent 构造器：旧 System WebView 与 Node 测试环境不一定提供。
        this.emit("message", Object.assign(new Event("message"), { data }));
        break;
      }
      case "error":
        if (this.readyState >= CodezAndroidWebSocket.CLOSING) return;
        this.emit("error", new Event("error"));
        break;
      case "close": {
        if (this.readyState === CodezAndroidWebSocket.CLOSED) return;
        this.readyState = CodezAndroidWebSocket.CLOSED;
        unregisterSocket(this.id);
        // 同上：CloseEvent 构造器并非全环境可用，事件对象只要形状匹配即可。
        const closeEvent = Object.assign(new Event("close"), {
          code: event.code,
          reason: event.reason,
          wasClean: event.wasClean,
        });
        this.emit("close", closeEvent);
        break;
      }
    }
  }

  private emit(type: string, event: Event): void {
    const handler =
      type === "open"
        ? this.onopen
        : type === "message"
          ? (this.onmessage as ((event: Event) => void) | null)
          : type === "error"
            ? this.onerror
            : (this.onclose as ((event: Event) => void) | null);
    handler?.call(this, event);
    this.listeners.get(type)?.forEach((listener) => {
      try {
        listener.call(this, event);
      } catch {
        // 单个监听器异常不应阻断其余监听器（浏览器 EventTarget 语义）。
      }
    });
  }
}

const socketRegistry = new Map<number, CodezAndroidWebSocket>();
let socketIdSeed = 0;
let preferExtensionBridgeWebSocket = false;
const extensionSocketRegistry = new Map<number, CodezExtensionWebSocket>();
let extensionRuntimeListenerInstalled = false;

type ExtensionRuntimeApi = {
  runtime?: {
    sendMessage?: (
      message: unknown,
      callback?: (response: unknown) => void,
    ) => Promise<unknown> | void;
    onMessage?: {
      addListener?: (
        listener: (message: unknown, sender?: unknown, sendResponse?: unknown) => void,
      ) => void;
    };
  };
};

function getExtensionRuntimeApi(): ExtensionRuntimeApi["runtime"] | undefined {
  const g = globalThis as unknown as {
    chrome?: ExtensionRuntimeApi;
    browser?: ExtensionRuntimeApi;
  };
  return g.chrome?.runtime ?? g.browser?.runtime;
}

function sendExtensionRuntimeMessage(message: unknown): void {
  const runtime = getExtensionRuntimeApi();
  if (typeof runtime?.sendMessage === "function") {
    try {
      const maybePromise = runtime.sendMessage(message);
      if (maybePromise && typeof maybePromise.then === "function") {
        maybePromise.catch(() => {});
      }
      return;
    } catch {
      // fallback to window.postMessage
    }
  }
  if (typeof window !== "undefined" && typeof window.postMessage === "function") {
    window.postMessage(
      {
        type: "codez-extension-ws-cmd-bridge",
        payload: message,
      },
      "*",
    );
  }
}

function ensureExtensionSocketEventSinkInstalled(): void {
  if (extensionRuntimeListenerInstalled) {
    return;
  }
  extensionRuntimeListenerInstalled = true;
  const runtime = getExtensionRuntimeApi();
  if (typeof runtime?.onMessage?.addListener === "function") {
    runtime.onMessage.addListener((message: unknown) => {
      if (!message || typeof message !== "object") return;
      const msg = message as {
        type?: string;
        id?: number;
        event?: NativeSocketEvent;
      };
      if (msg.type !== "codez-extension-ws-event" || typeof msg.id !== "number" || !msg.event) {
        return;
      }
      extensionSocketRegistry.get(msg.id)?.dispatchExtensionEvent(msg.event);
    });
  }
  if (typeof window !== "undefined" && typeof window.addEventListener === "function") {
    window.addEventListener("message", (event: MessageEvent) => {
      if (event.data?.type !== "codez-extension-ws-event") {
        return;
      }
      const id = event.data.id;
      const ev = event.data.event as NativeSocketEvent | undefined;
      if (typeof id === "number" && ev) {
        extensionSocketRegistry.get(id)?.dispatchExtensionEvent(ev);
      }
    });
  }
}

/**
 * 浏览器扩展自适应 WebSocket：
 * 1. 默认先尝试直接建立原生 WebSocket（桌面 Chrome/Edge 下由 declarativeNetRequest 自动注入 Origin: https://zcode.z.ai）；
 * 2. 若浏览器（如 iPad Orion）的 declarativeNetRequest 未对 WebSocket 握手改写 Origin 导致握手阶段（OPEN 之前）直接失败，
 *    自动无缝切换至扩展后台同源桥接通道（在 https://zcode.z.ai/favicon.ico 的隔离 Content Script 内代发 WebSocket），
 *    后续重连也直接走扩展桥接通道，确保移动端与桌面端浏览器扩展都能稳定连接。
 */
class CodezExtensionWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  readonly CONNECTING = 0;
  readonly OPEN = 1;
  readonly CLOSING = 2;
  readonly CLOSED = 3;

  readonly url: string;
  extensions = "";
  readonly protocol = "";
  readonly bufferedAmount = 0;
  binaryType: BinaryType = "arraybuffer";
  readyState: number = CodezExtensionWebSocket.CONNECTING;

  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;

  private readonly id: number;
  private readonly listeners = new Map<string, Set<SocketListener>>();
  private nativeSocket: WebSocket | null = null;
  private usingExtensionBridge = false;
  private bridgeIframeEl: HTMLIFrameElement | null = null;
  private bridgeConnectTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(url: string) {
    this.url = url;
    this.id = nextSocketId();
    if (preferExtensionBridgeWebSocket || typeof globalThis.WebSocket !== "function") {
      this.startExtensionBridge();
      return;
    }
    try {
      const ws = new globalThis.WebSocket(url);
      ws.binaryType = "arraybuffer";
      this.nativeSocket = ws;
      let opened = false;
      ws.addEventListener("open", () => {
        if (this.usingExtensionBridge || this.readyState !== CodezExtensionWebSocket.CONNECTING) return;
        opened = true;
        this.extensions = typeof ws.extensions === "string" ? ws.extensions : "";
        this.readyState = CodezExtensionWebSocket.OPEN;
        this.emit("open", new Event("open"));
      });
      ws.addEventListener("message", (event) => {
        if (this.usingExtensionBridge || this.readyState !== CodezExtensionWebSocket.OPEN) return;
        this.emit("message", Object.assign(new Event("message"), { data: event.data }));
      });
      ws.addEventListener("error", () => {
        if (this.usingExtensionBridge) return;
        if (!opened && this.readyState === CodezExtensionWebSocket.CONNECTING) {
          // 原生 WebSocket 在握手完成前报错（如 iPad Orion 未对 WS 注入 Origin 触发 403），立即无缝切换到扩展同源桥接通道。
          preferExtensionBridgeWebSocket = true;
          this.nativeSocket = null;
          try { ws.close(); } catch { /* ignore */ }
          this.startExtensionBridge();
          return;
        }
        if (this.readyState < CodezExtensionWebSocket.CLOSING) this.emit("error", new Event("error"));
      });
      ws.addEventListener("close", (event) => {
        if (this.usingExtensionBridge) return;
        if (!opened && this.readyState === CodezExtensionWebSocket.CONNECTING) {
          preferExtensionBridgeWebSocket = true;
          this.nativeSocket = null;
          this.startExtensionBridge();
          return;
        }
        if (this.readyState === CodezExtensionWebSocket.CLOSED) return;
        this.readyState = CodezExtensionWebSocket.CLOSED;
        this.emit("close", Object.assign(new Event("close"), { code: event.code, reason: event.reason, wasClean: event.wasClean }));
      });
    } catch {
      preferExtensionBridgeWebSocket = true;
      this.startExtensionBridge();
    }
  }

  private startExtensionBridge(): void {
    this.usingExtensionBridge = true;
    if (typeof document !== "undefined" && typeof document.createElement === "function") {
      try {
        extensionSocketRegistry.set(this.id, this);
        ensureExtensionSocketEventSinkInstalled();
        const iframe = document.createElement("iframe");
        iframe.style.display = "none";
        iframe.src = `https://zcode.z.ai/robots.txt?codez_ws_iframe_id=${this.id}#${encodeURIComponent(this.url)}`;
        this.bridgeIframeEl = iframe;
        (document.body ?? document.documentElement)?.appendChild(iframe);
        this.clearBridgeConnectTimer();
        this.bridgeConnectTimer = setTimeout(() => {
          if (this.readyState === CodezExtensionWebSocket.CONNECTING) {
            try { iframe.remove(); } catch { /* ignore */ }
            this.bridgeIframeEl = null;
            this.startRuntimeExtensionBridge();
          }
        }, 2_500);
        return;
      } catch {
        // fallback to runtime extension bridge
      }
    }
    this.startRuntimeExtensionBridge();
  }

  private startRuntimeExtensionBridge(): void {
    extensionSocketRegistry.set(this.id, this);
    ensureExtensionSocketEventSinkInstalled();
    this.clearBridgeConnectTimer();
    this.bridgeConnectTimer = setTimeout(() => {
      if (this.readyState === CodezExtensionWebSocket.CONNECTING) {
        this.dispatchExtensionEvent({ type: "error" });
        this.dispatchExtensionEvent({ type: "close", code: 1006, reason: "Extension bridge connect timeout", wasClean: false });
      }
    }, 6_000);
    sendExtensionRuntimeMessage({ type: "codez-extension-ws-open", id: this.id, url: this.url });
  }

  private clearBridgeConnectTimer(): void {
    if (this.bridgeConnectTimer !== null) {
      clearTimeout(this.bridgeConnectTimer);
      this.bridgeConnectTimer = null;
    }
  }

  addEventListener(type: string, listener: SocketListener): void {
    let bucket = this.listeners.get(type);
    if (!bucket) {
      bucket = new Set();
      this.listeners.set(type, bucket);
    }
    bucket.add(listener);
  }

  removeEventListener(type: string, listener: SocketListener): void {
    this.listeners.get(type)?.delete(listener);
  }

  send(data: string | ArrayBuffer | ArrayBufferView<ArrayBuffer>): void {
    if (this.readyState !== CodezExtensionWebSocket.OPEN) throw new Error("WebSocket is not open");
    if (!this.usingExtensionBridge && this.nativeSocket) {
      this.nativeSocket.send(data);
      return;
    }
    if (typeof data === "string") {
      if (this.bridgeIframeEl?.contentWindow) {
        try { this.bridgeIframeEl.contentWindow.postMessage({ type: "codez-bridge-ws-send", id: this.id, text: data }, "https://zcode.z.ai"); } catch { /* ignore */ }
      }
      sendExtensionRuntimeMessage({ type: "codez-extension-ws-send", id: this.id, text: data });
      return;
    }
    const buffer = data instanceof ArrayBuffer ? data : data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
    const base64 = arrayBufferToBase64(buffer as ArrayBuffer);
    if (this.bridgeIframeEl?.contentWindow) {
      try { this.bridgeIframeEl.contentWindow.postMessage({ type: "codez-bridge-ws-send", id: this.id, base64 }, "https://zcode.z.ai"); } catch { /* ignore */ }
    }
    sendExtensionRuntimeMessage({ type: "codez-extension-ws-send", id: this.id, base64 });
  }

  close(code = 1000, reason = ""): void {
    if (this.readyState === CodezExtensionWebSocket.CLOSING || this.readyState === CodezExtensionWebSocket.CLOSED) return;
    this.clearBridgeConnectTimer();
    this.readyState = CodezExtensionWebSocket.CLOSING;
    if (!this.usingExtensionBridge && this.nativeSocket) {
      this.nativeSocket.close(code, reason);
      return;
    }
    sendExtensionRuntimeMessage({ type: "codez-extension-ws-close", id: this.id, code, reason });
    if (this.bridgeIframeEl) {
      const el = this.bridgeIframeEl;
      this.bridgeIframeEl = null;
      try { el.contentWindow?.postMessage({ type: "codez-bridge-ws-close", id: this.id, code, reason }, "https://zcode.z.ai"); } catch { /* ignore */ }
      setTimeout(() => { try { el.remove(); } catch { /* ignore */ } }, 200);
    }
  }

  dispatchExtensionEvent(event: NativeSocketEvent): void {
    switch (event.type) {
      case "open":
        if (this.readyState !== CodezExtensionWebSocket.CONNECTING) return;
        this.clearBridgeConnectTimer();
        this.extensions = event.extensions ?? "";
        this.readyState = CodezExtensionWebSocket.OPEN;
        this.emit("open", new Event("open"));
        break;
      case "message": {
        if (this.readyState !== CodezExtensionWebSocket.OPEN) return;
        const data = typeof event.text === "string" ? event.text : base64ToArrayBuffer(event.base64 ?? "");
        this.emit("message", Object.assign(new Event("message"), { data }));
        break;
      }
      case "error":
        if (this.bridgeIframeEl && this.readyState === CodezExtensionWebSocket.CONNECTING) return;
        if (this.readyState >= CodezExtensionWebSocket.CLOSING) return;
        this.emit("error", new Event("error"));
        break;
      case "close": {
        if (this.bridgeIframeEl && this.readyState === CodezExtensionWebSocket.CONNECTING) {
          const el = this.bridgeIframeEl;
          this.bridgeIframeEl = null;
          try { el.remove(); } catch { /* ignore */ }
          this.startRuntimeExtensionBridge();
          return;
        }
        if (this.readyState === CodezExtensionWebSocket.CLOSED) return;
        this.clearBridgeConnectTimer();
        this.readyState = CodezExtensionWebSocket.CLOSED;
        extensionSocketRegistry.delete(this.id);
        this.emit("close", Object.assign(new Event("close"), { code: event.code, reason: event.reason, wasClean: event.wasClean }));
        break;
      }
    }
  }

  private emit(type: string, event: Event): void {
    const handler =
      type === "open"
        ? this.onopen
        : type === "message"
          ? (this.onmessage as ((event: Event) => void) | null)
          : type === "error"
            ? this.onerror
            : (this.onclose as ((event: Event) => void) | null);
    handler?.call(this, event);
    this.listeners.get(type)?.forEach((listener) => {
      try { listener.call(this, event); } catch { /* ignore */ }
    });
  }
}

function nextSocketId(): number {
  socketIdSeed += 1;
  return socketIdSeed;
}

function registerSocket(id: number, socket: CodezAndroidWebSocket): void {
  socketRegistry.set(id, socket);
  ensureEventSinkInstalled();
}

function unregisterSocket(id: number): void {
  socketRegistry.delete(id);
}

function ensureEventSinkInstalled(): void {
  if (window.__codezAndroidSocketEvent) {
    return;
  }
  window.__codezAndroidSocketEvent = (id, eventJson) => {
    const socket = socketRegistry.get(id);
    if (!socket) {
      return;
    }
    let event: NativeSocketEvent;
    try {
      event = JSON.parse(eventJson) as NativeSocketEvent;
    } catch {
      return;
    }
    socket.dispatchNativeEvent(event);
  };
}

/**
 * Android 壳内返回原生桥适配类，其余环境回退到浏览器原生 WebSocket。
 * 返回值同时满足 `typeof globalThis.WebSocket` 的构造签名要求。
 */
export function resolveWebRemoteControlWebSocketCtor(): typeof globalThis.WebSocket {
  if (typeof window !== "undefined" && window.CodezAndroidSocket) {
    return CodezAndroidWebSocket as unknown as typeof globalThis.WebSocket;
  }
  if (isCodezBrowserExtension() && Boolean(getExtensionRuntimeApi()?.sendMessage)) {
    return CodezExtensionWebSocket as unknown as typeof globalThis.WebSocket;
  }
  return globalThis.WebSocket;
}

/** 判断当前页面是否运行在 Codez Android App 原生壳内。 */
export function isCodezAndroidApp(): boolean {
  return typeof window !== "undefined" && Boolean(window.CodezAndroidSocket);
}

/** 判断当前页面是否运行在 Codez 浏览器扩展内（或已注入扩展标记）。 */
export function isCodezBrowserExtension(): boolean {
  if (typeof window === "undefined") {
    return false;
  }
  if (isBrowserExtensionProtocol(window.location?.protocol)) {
    return true;
  }
  return (
    window.__CODEZ_BROWSER_EXTENSION__ === true ||
    (typeof document !== "undefined" &&
      typeof document.documentElement?.hasAttribute === "function" &&
      document.documentElement?.hasAttribute("data-codez-browser-extension") === true)
  );
}

/** 判断当前页面是否运行在受信任的远控壳层（Android App 或浏览器扩展）。 */
export function isTrustedWebRemoteControlHost(): boolean {
  return isCodezAndroidApp() || isCodezBrowserExtension();
}

const httpRegistry = new Map<
  number,
  {
    resolve(response: Response): void;
    reject(error: Error): void;
    cleanup(): void;
  }
>();
let httpIdSeed = 0;

function ensureHttpEventSinkInstalled(): void {
  if (typeof window === "undefined" || window.__codezAndroidHttpEvent) {
    return;
  }
  window.__codezAndroidHttpEvent = (id, eventJson) => {
    const pending = httpRegistry.get(id);
    if (!pending) return;
    httpRegistry.delete(id);
    pending.cleanup();
    let event: NativeHttpEvent;
    try {
      event = JSON.parse(eventJson) as NativeHttpEvent;
    } catch {
      pending.reject(new Error("Invalid native HTTP event"));
      return;
    }
    if (event.type === "error") {
      pending.reject(new Error(event.message || "Native HTTP request failed"));
      return;
    }
    pending.resolve(
      new Response(event.body, {
        status: event.status,
        headers: { "Content-Type": "application/json" },
      }),
    );
  };
}

function serializeHeaders(headers?: HeadersInit): Record<string, string> {
  if (!headers) return {};
  if (headers instanceof Headers) {
    const record: Record<string, string> = {};
    headers.forEach((value, key) => {
      record[key] = value;
    });
    return record;
  }
  if (Array.isArray(headers)) {
    return Object.fromEntries(headers);
  }
  return { ...headers };
}

/**
 * Android 壳内通过原生 OkHttp（不带浏览器 Origin 头）代发 Relay V2 与 OAuth 请求，
 * 或在安装了浏览器扩展的受信任页面内通过扩展后台 Service Worker 代发，
 * 避免可信静态站点（kingingwang.github.io）或本地扩展页面跨域请求 zcode.z.ai 时被 CORS / WAF 403 拦截。
 */
export function resolveWebRemoteControlFetcher(): typeof fetch {
  return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const bridge = typeof window !== "undefined" ? window.CodezAndroidSocket : undefined;
    const extensionFetch =
      typeof window !== "undefined" && typeof window.__codezExtensionFetch === "function"
        ? window.__codezExtensionFetch
        : undefined;
    const runtimeSendMessage = (
      globalThis as unknown as {
        chrome?: {
          runtime?: {
            sendMessage?: (
              message: unknown,
              callback?: (response: unknown) => void,
            ) => Promise<unknown> | void;
          };
        };
        browser?: {
          runtime?: {
            sendMessage?: (
              message: unknown,
              callback?: (response: unknown) => void,
            ) => Promise<unknown> | void;
          };
        };
      }
    ).chrome?.runtime?.sendMessage ??
    (
      globalThis as unknown as {
        browser?: {
          runtime?: {
            sendMessage?: (
              message: unknown,
              callback?: (response: unknown) => void,
            ) => Promise<unknown> | void;
          };
        };
      }
    ).browser?.runtime?.sendMessage;
    const isExtensionMarkedPage =
      typeof window !== "undefined" &&
      typeof window.postMessage === "function" &&
      isCodezBrowserExtension();

    if (!bridge || typeof bridge.fetch !== "function") {
      if (extensionFetch || typeof runtimeSendMessage === "function" || isExtensionMarkedPage) {
        const signal = init?.signal;
        if (signal?.aborted) {
          throw new DOMException("The operation was aborted.", "AbortError");
        }
        const rawUrl =
          typeof input === "string"
            ? input
            : input instanceof URL
              ? input.toString()
              : input.url;
        const resolvedUrl = new URL(
          rawUrl,
          typeof window !== "undefined" && window.location?.href
            ? window.location.href
            : "https://zcode.z.ai",
        ).toString();
        if (resolvedUrl.startsWith("https://zcode.z.ai/api/")) {
          const method = (init?.method ?? "GET").toUpperCase();
          const headers = serializeHeaders(init?.headers);
          const body = typeof init?.body === "string" ? init.body : "";
          const result = extensionFetch
            ? await extensionFetch({ url: resolvedUrl, method, headers, body })
            : typeof runtimeSendMessage === "function"
              ? await new Promise<{ status: number; body: string; error?: string } | null>(
                  (resolve) => {
                  let settled = false;
                  const finish = (
                    val: { status: number; body: string; error?: string } | null,
                  ) => {
                    if (settled) return;
                    settled = true;
                    clearTimeout(timer);
                    resolve(val);
                  };
                  const timer = setTimeout(() => finish(null), 12_000);
                    try {
                      const maybePromise = runtimeSendMessage(
                        {
                          type: "codez-extension-http-fetch",
                          url: resolvedUrl,
                          method,
                          headers,
                          body,
                        },
                        (resp) => {
                        if (resp && typeof resp === "object" && "status" in resp) {
                          finish(resp as { status: number; body: string; error?: string });
                        } else if (!maybePromise || typeof maybePromise.then !== "function") {
                          finish(null);
                        }
                        },
                      );
                      if (maybePromise && typeof maybePromise.then === "function") {
                        maybePromise
                          .then((resp) => {
                            if (resp && typeof resp === "object" && "status" in resp) {
                            finish(resp as { status: number; body: string; error?: string });
                          } else {
                            finish(null);
                            }
                          })
                        .catch(() => finish(null));
                      }
                    } catch {
                    finish(null);
                    }
                  },
                )
              : await new Promise<{ status: number; body: string; error?: string } | null>(
                  (resolve) => {
                    if (typeof window.addEventListener !== "function") {
                      resolve(null);
                      return;
                    }
                    const reqId = ++httpIdSeed;
                    const timer = setTimeout(() => {
                      window.removeEventListener("message", onMessage);
                      resolve(null);
                    }, 3_000);
                    const onMessage = (event: MessageEvent) => {
                      if (
                        event.source !== window ||
                        event.data?.type !== "codez-extension-http-fetch-res" ||
                        event.data?.id !== reqId
                      ) {
                        return;
                      }
                      clearTimeout(timer);
                      window.removeEventListener("message", onMessage);
                      resolve(
                        event.data.response as { status: number; body: string; error?: string },
                      );
                    };
                    window.addEventListener("message", onMessage);
                    window.postMessage(
                      {
                        type: "codez-extension-http-fetch-req",
                        id: reqId,
                        url: resolvedUrl,
                        method,
                        headers,
                        body,
                      },
                      "*",
                    );
                  },
                );
          if (result) {
            if (result.error) {
              throw new Error(result.error);
            }
            return new Response(result.body, {
              status: result.status,
              headers: { "Content-Type": "application/json" },
            });
          }
        }
      }
      return globalThis.fetch(input, init);
    }
    const signal = init?.signal;
    if (signal?.aborted) {
      throw new DOMException("The operation was aborted.", "AbortError");
    }
    const rawUrl =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;
    const resolvedUrl = new URL(
      rawUrl,
      typeof window !== "undefined" && window.location?.href
        ? window.location.href
        : "https://zcode.z.ai",
    ).toString();
    const method = (init?.method ?? "GET").toUpperCase();
    const headersJson = JSON.stringify(serializeHeaders(init?.headers));
    const body = typeof init?.body === "string" ? init.body : "";
    const id = ++httpIdSeed;
    ensureHttpEventSinkInstalled();

    return new Promise<Response>((resolve, reject) => {
      const onAbort = () => {
        if (!httpRegistry.delete(id)) return;
        reject(new DOMException("The operation was aborted.", "AbortError"));
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      httpRegistry.set(id, {
        resolve,
        reject,
        cleanup: () => signal?.removeEventListener("abort", onAbort),
      });
      try {
        bridge.fetch!(id, resolvedUrl, method, headersJson, body);
      } catch (error) {
        httpRegistry.delete(id);
        signal?.removeEventListener("abort", onAbort);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  };
}
