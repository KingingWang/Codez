import { createNativeBrowserCuaMcpBroker } from "../browserView/nativeBrowserCuaMcpBroker.js";
import { localBrowserMcpAvailability } from "../desktopCodexMcpAvailability.js";
import type { LocalBrowserMcpAvailability, NativeBrowserCuaMcpBroker } from "./contract.js";

/** 引用原 factory 而不调用，示例不创建窗口、socket 或 credential。 */
export const nativeBrowserControlMainFactoryExample = createNativeBrowserCuaMcpBroker;
export const nativeBrowserControlAvailabilityExample: LocalBrowserMcpAvailability =
  localBrowserMcpAvailability;

export function readNativeBrowserControlExample(broker: NativeBrowserCuaMcpBroker) {
  return broker.availability;
}
