import type { WebRemoteNativeIoPorts } from "./contract.js";

export function nativeRemoteIoCompositionExample(
  WebSocketCtor: typeof globalThis.WebSocket,
  fetcher: typeof globalThis.fetch,
): WebRemoteNativeIoPorts {
  return { WebSocketCtor, fetcher };
}
