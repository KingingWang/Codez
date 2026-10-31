import type { ProviderBootstrapRuntimePort } from "./contract.js";

/** 当前 Root 负责 pending 与 stale-result guard，例子不启动 Provider。 */
export function providerRuntimeReadExample(port: ProviderBootstrapRuntimePort) {
  return port.info();
}
