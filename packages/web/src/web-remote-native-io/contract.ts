/** main 注入 transport 的现有 IO 输出；认证、加密与 socket 生命周期不归此 read model。 */
export interface WebRemoteNativeIoPorts {
  readonly WebSocketCtor: typeof globalThis.WebSocket;
  readonly fetcher: typeof globalThis.fetch;
}

/** 与 Android NativeSocketBridge.kt 一致；只搬运字节，不执行配对、认证或 E2EE。 */
export interface CodezAndroidSocketBridge {
  open(id: number, url: string): void;
  sendText(id: number, text: string): boolean;
  sendBinary(id: number, base64: string): boolean;
  close(id: number, code: number, reason: string): void;
  fetch?(id: number, url: string, method: string, headersJson: string, body: string): void;
}

export type NativeSocketEvent =
  | { type: "open"; extensions?: string }
  | { type: "message"; text?: string; base64?: string }
  | { type: "error" }
  | { type: "close"; code: number; reason: string; wasClean: boolean };

export type SocketListener = (event: Event) => void;

declare global {
  interface Window {
    CodezAndroidSocket?: CodezAndroidSocketBridge;
    __CODEZ_BROWSER_EXTENSION__?: boolean;
    __codezAndroidSocketEvent?: (id: number, eventJson: string) => void;
    __codezAndroidHttpEvent?: (id: number, eventJson: string) => void;
  }
}
