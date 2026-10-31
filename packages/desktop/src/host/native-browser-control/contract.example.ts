import { executeNativeBrowserCuaBrokerRequest } from "../nativeBrowserCuaBrokerClient.js";
import { createNativeBrowserCuaMcpStateHolder } from "../nativeBrowserCuaMcpState.js";
import type { NativeBrowserCuaBrokerRequest, NativeBrowserCuaMcpStateHolder } from "./contract.js";

/** 仅展示类型连接，不打开 socket 或读取真实凭据。 */
export const nativeBrowserCuaBrokerRequestExample: NativeBrowserCuaBrokerRequest =
  executeNativeBrowserCuaBrokerRequest;

export function createNativeBrowserCuaStateExample(): NativeBrowserCuaMcpStateHolder {
  return createNativeBrowserCuaMcpStateHolder({ servers: [] });
}
