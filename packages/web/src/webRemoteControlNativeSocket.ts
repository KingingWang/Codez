/**
 * 远控 IO 工厂只选择既有 Android / 扩展适配器。
 * 配对、E2EE、认证与 workspace 路由仍由现有 transport 承担。
 */
import {
  CodezAndroidWebSocket,
  requestAndroidHttp,
} from "./web-remote-native-io/adapters/android.js";
import {
  CodezExtensionWebSocket,
  getExtensionRuntimeApi,
  isCodezBrowserExtension,
  requestExtensionHttpIfNeeded,
  toExtensionHttpResponse,
} from "./web-remote-native-io/adapters/extension.js";

export {
  isBrowserExtensionProtocol,
  isCodezBrowserExtension,
  WebRemoteControlExtensionHttpBridgeError,
} from "./web-remote-native-io/adapters/extension.js";

/** Android、扩展与普通浏览器保持原有工厂选择顺序。 */
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

/** 判断当前页面是否运行在受信任的远控壳层。 */
export function isTrustedWebRemoteControlHost(): boolean {
  return isCodezAndroidApp() || isCodezBrowserExtension();
}

/**
 * 同一个 async 工厂等待扩展原 request promise；Android 分支直接返回原 registry promise。
 * 这里只做 IO 选择，不增加 completion、队列、恢复 owner 或超时。
 */
export function resolveWebRemoteControlFetcher(): typeof fetch {
  return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const bridge = typeof window !== "undefined" ? window.CodezAndroidSocket : undefined;
    if (!bridge?.fetch) {
      const extensionRequest = requestExtensionHttpIfNeeded(input, init);
      if (extensionRequest) {
        return toExtensionHttpResponse(await extensionRequest);
      }
      return globalThis.fetch(input, init);
    }
    return requestAndroidHttp(bridge, input, init);
  };
}
