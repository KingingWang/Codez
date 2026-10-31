/** 显式真机 smoke 的工程适配器，不是产品服务。 */
export const cuaRuntimeQaModule = {
  id: "cua-runtime-qa",
  requires: ["codez-cli", "codez-cua", "cua-helper-runtime", "cua-native-producer"],
  provides: ["opt-in-cua-smoke"],
  publicEntrypoints: ["contract.ts"],
} as const;
