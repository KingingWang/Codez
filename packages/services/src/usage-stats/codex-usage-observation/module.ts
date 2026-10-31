/** 原所属 Host 的 usage 观察缓存；requires 与 architecture-policy.yaml 同步。 */
export const codexUsageObservationModule = {
  id: "codex-usage-observation",
  requires: [],
  provides: ["codex-usage-observation"],
  publicEntrypoints: ["contract.ts", "../codexUsageObservationCache.ts"],
} as const;
