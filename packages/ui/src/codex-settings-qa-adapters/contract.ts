/** 现有显式入口；该类型不是自动测试调度表。 */
export type CodexSettingsQaEntrypoint =
  | "automation-model-read-e2e.mjs"
  | "bootstrap-watchdog-e2e.mjs"
  | "desktop-check.mjs"
  | "desktop-conversation-check.mjs"
  | "desktop-followup-check.mjs"
  | "desktop-general-accessibility-check.mjs"
  | "desktop-interrupted-turn-check.mjs"
  | "desktop-mapped-provider-check.mjs"
  | "desktop-probe.mjs"
  | "desktop-retry-check.mjs"
  | "help-menu-flavors-e2e.mjs"
  | "interaction-e2e.mjs"
  | "mapped-provider-runner.mjs"
  | "provider-model-slug-e2e.mjs";

export interface CodexSettingsQaRunEvidence {
  readonly entrypoint: CodexSettingsQaEntrypoint;
  readonly exitCode: number;
  readonly completedChecks: readonly string[];
  readonly skippedChecks: readonly string[];
}
