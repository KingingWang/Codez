/** Host 原生 Automation 只读对账适配；不拥有 scheduler 或 correlation ledger。 */
export const desktopCodexAutomationReconciliationModule = {
  id: "desktop-codex-automation-reconciliation",
  requires: ["services", "shared"],
  provides: ["desktop-codex-automation-reconciliation"],
  publicEntrypoints: ["contract.ts", "../codexAutomationCorrelation.ts"],
} as const;
