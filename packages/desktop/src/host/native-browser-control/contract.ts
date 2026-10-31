import type { Socket } from "node:net";
import type { DesktopCodexMcpServer } from "@codez/shared";

/** Main-issued facts only; the holder does not grant or reconstruct a capability. */
export interface NativeBrowserCuaMcpState {
  servers: readonly DesktopCodexMcpServer[];
  nativeBrowserCua?: { browserAvailable: boolean; cuaAvailable: boolean };
}

export interface NativeBrowserCuaBrokerTarget {
  endpoint: string;
  tokenFile: string;
}

export interface NativeBrowserCuaMcpStateHolder {
  get(): NativeBrowserCuaMcpState;
  set(next: NativeBrowserCuaMcpState): void;
  subscribe(listener: (state: NativeBrowserCuaMcpState) => void): () => void;
  brokerTarget(): NativeBrowserCuaBrokerTarget | undefined;
}

export interface NativeBrowserCuaBrokerRequestInput {
  target: NativeBrowserCuaBrokerTarget;
  payload: string;
  timeoutMs?: number;
  connect?: (endpoint: string) => Socket;
  readTokenFile?: (path: string) => Promise<string>;
}

/** One request/connection; failure is a broker frame, never a resend of a mutation. */
export type NativeBrowserCuaBrokerRequest = (
  input: NativeBrowserCuaBrokerRequestInput,
) => Promise<string>;
