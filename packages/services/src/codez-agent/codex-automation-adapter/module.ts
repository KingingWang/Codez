/** 原 Host Automation 关联适配；requires 与 architecture-policy.yaml 同步。 */
export const codexAutomationAdapterModule = {
  id: "codex-automation-adapter",
  requires: ["shared"],
  provides: ["codex-automation-adapter"],
  publicEntrypoints: [
    "contract.ts",
    "../codexAutomationAdapter.ts",
    "../../session/codexAutomationCorrelation.ts",
  ],
} as const;
