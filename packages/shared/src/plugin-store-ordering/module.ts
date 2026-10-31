/** plugin-store-ordering 模块清单；层：domain，纯排序不持有安装态。 */
export const pluginStoreOrderingModule = {
  id: "plugin-store-ordering",
  requires: ["shared"],
  provides: ["plugin-store-ordering"],
  publicEntrypoints: ["contract.ts", "../pluginStoreOrdering.ts"],
} as const;
