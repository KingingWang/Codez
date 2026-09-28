import {
  CODEZ_NATIVE_BROWSER_CUA_ENDPOINT_ENV,
  CODEZ_NATIVE_BROWSER_CUA_MCP_SERVER_NAME,
  CODEZ_NATIVE_BROWSER_CUA_TOKEN_FILE_ENV,
  type DesktopCodexMcpServer,
} from "@codez/shared";

/**
 * 窗口级内置浏览器 MCP 状态的 Host 侧持有器
 * （spec: codex-desktop-native-browser-cua「Global enable toggle」）。
 *
 * InitLocal 快照初始化，Main 经 NativeBrowserCuaMcpServersChanged 推送即时更新；
 * createLocalServices 的 resolveSpawnEnv 每次 spawn 现读，远程 relay 联动也从这里取事实。
 */

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
  /** 状态变更订阅（Main 推送驱动）；返回注销函数。 */
  subscribe(listener: (state: NativeBrowserCuaMcpState) => void): () => void;
  /** 当前 Main broker 目标；无授权（空清单/条目缺失/环境缺字段）时 undefined。 */
  brokerTarget(): NativeBrowserCuaBrokerTarget | undefined;
}

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
