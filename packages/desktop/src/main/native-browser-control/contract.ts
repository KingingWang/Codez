import type { DesktopCodexMcpServer, NativeBrowserCuaMcpDescriptor } from "@codez/shared";

export interface NativeBrowserCuaAvailability {
  browserAvailable: boolean;
  cuaAvailable: boolean;
}

export interface NativeBrowserCuaMcpBroker {
  readonly ready: Promise<void>;
  readonly readiness: Promise<void>;
  readonly availability: NativeBrowserCuaAvailability;
  setEnabled(enabled: boolean): void;
  registerWindow(windowId: number): Promise<void>;
  revokeWindow(windowId: number): Promise<void>;
  descriptor(input: {
    executable: string;
    bridgePath: string;
    windowId: number;
  }): NativeBrowserCuaMcpDescriptor;
  close(): Promise<void>;
}

/** The live endpoint or another window's registration cannot grant this window Browser access. */
export type LocalBrowserMcpAvailability = (
  availability: NativeBrowserCuaAvailability,
  servers: readonly DesktopCodexMcpServer[],
) => NativeBrowserCuaAvailability;
