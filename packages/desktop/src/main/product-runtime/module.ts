/** build flavor、产品目录与固定分发入口的唯一 Desktop helper。 */
export const desktopProductRuntimeModule = {
  id: "desktop-product-runtime",
  requires: ["shared"],
  provides: ["desktop-product-runtime"],
  publicEntrypoints: ["contract.ts", "../desktopProductRuntime.ts"],
} as const;
