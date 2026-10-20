import {
  CODEZ_NATIVE_BROWSER_CUA_BROWSER_ENV,
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
      // CUA-only 也保留载体；不能再把“清单非空”误作本窗口 browser 授权。
      servers.some(
        (server) =>
          server.name === CODEZ_NATIVE_BROWSER_CUA_MCP_SERVER_NAME &&
          server.env[CODEZ_NATIVE_BROWSER_CUA_BROWSER_ENV] !== "0",
      ),
  };
}
