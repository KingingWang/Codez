import {
  CODEZ_NATIVE_BROWSER_CUA_MCP_SERVER_NAME,
  type DesktopCodexMcpServer,
} from "@codez/shared";

/** A different window's registered broker must never make this Host advertise Browser support. */
export function localBrowserMcpAvailability(
  availability: { browserAvailable: boolean; cuaAvailable: boolean },
  servers: readonly DesktopCodexMcpServer[],
) {
  return {
    ...availability,
    browserAvailable:
      availability.browserAvailable &&
      servers.some((server) => server.name === CODEZ_NATIVE_BROWSER_CUA_MCP_SERVER_NAME),
  };
}
