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
  const protocol = window.location?.protocol;
  if (
    protocol === "chrome-extension:" ||
    protocol === "moz-extension:" ||
    protocol === "safari-web-extension:"
  ) {
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
      }
    ).chrome?.runtime?.sendMessage;
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
                          resolve(
                            resp && typeof resp === "object" && "status" in resp
                              ? (resp as { status: number; body: string; error?: string })
                              : null,
                          );
                        },
                      );
                      if (maybePromise && typeof maybePromise.then === "function") {
                        maybePromise
                          .then((resp) => {
                            if (resp && typeof resp === "object" && "status" in resp) {
                              resolve(resp as { status: number; body: string; error?: string });
                            }
                          })
                          .catch(() => resolve(null));
                      }
                    } catch {
                      resolve(null);
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
