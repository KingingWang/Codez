/** Helper 进程与 broker client 的既有协议边界，不新增执行路径。 */
export const cuaHelperRuntimeModule = {
  id: "cua-helper-runtime",
  requires: ["codez-cua", "cua-native-producer", "cua-pip"],
  provides: ["helper-lifecycle", "broker-runtime"],
  publicEntrypoints: ["contract.ts"],
} as const;
