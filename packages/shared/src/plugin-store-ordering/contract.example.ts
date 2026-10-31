import type { PluginStoreOrderingContract } from "./contract.js";

/** 调用现有纯排序端口，不改变调用方集合或插件安装状态。 */
export function examplePluginStoreOrdering(
  contract: PluginStoreOrderingContract,
  items: readonly { id: string; category?: string; displayName: string }[],
): { id: string; category?: string; displayName: string }[] {
  return contract.sortPluginStoreEntries(items, (item) => item, "en");
}
