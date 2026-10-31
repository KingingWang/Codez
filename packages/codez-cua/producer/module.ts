/** 原生 producer 与包内 driver seam；不改变 Helper 的执行 owner。 */
export const cuaNativeProducerModule = {
  id: "cua-native-producer",
  requires: [],
  provides: ["native-observation", "native-input"],
  publicEntrypoints: ["contract.ts"],
} as const;
