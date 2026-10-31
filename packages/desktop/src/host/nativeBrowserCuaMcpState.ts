import {
  CODEZ_NATIVE_BROWSER_CUA_ENDPOINT_ENV,
  CODEZ_NATIVE_BROWSER_CUA_MCP_SERVER_NAME,
  CODEZ_NATIVE_BROWSER_CUA_TOKEN_FILE_ENV,
} from "@codez/shared";
import type {
  NativeBrowserCuaMcpState,
  NativeBrowserCuaMcpStateHolder,
} from "./native-browser-control/contract.js";

export type {
  NativeBrowserCuaBrokerTarget,
  NativeBrowserCuaMcpState,
  NativeBrowserCuaMcpStateHolder,
} from "./native-browser-control/contract.js";

/**
 * 窗口级内置浏览器 MCP 状态的 Host 侧持有器
 * （spec: codex-desktop-native-browser-cua「Global enable toggle」）。
 *
 * InitLocal 快照初始化，Main 经 NativeBrowserCuaMcpServersChanged 推送即时更新；
 * createLocalServices 的 resolveSpawnEnv 每次 spawn 现读，远程 relay 联动也从这里取事实。
 */

export function createNativeBrowserCuaMcpStateHolder(
  initial?: Partial<NativeBrowserCuaMcpState>,
): NativeBrowserCuaMcpStateHolder {
  let current: NativeBrowserCuaMcpState = {
    servers: initial?.servers ?? [],
    nativeBrowserCua: initial?.nativeBrowserCua,
  };
  const listeners = new Set<(state: NativeBrowserCuaMcpState) => void>();
  return {
    get: () => current,
    set(next) {
      current = { servers: next.servers, nativeBrowserCua: next.nativeBrowserCua };
      for (const listener of listeners) listener(current);
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    brokerTarget() {
      if (!current.nativeBrowserCua?.browserAvailable) return undefined;
      const server = current.servers.find(
        (entry) => entry.name === CODEZ_NATIVE_BROWSER_CUA_MCP_SERVER_NAME,
      );
      const endpoint = server?.env[CODEZ_NATIVE_BROWSER_CUA_ENDPOINT_ENV]?.trim();
      const tokenFile = server?.env[CODEZ_NATIVE_BROWSER_CUA_TOKEN_FILE_ENV]?.trim();
      if (!endpoint || !tokenFile) return undefined;
      return { endpoint, tokenFile };
    },
  };
}
