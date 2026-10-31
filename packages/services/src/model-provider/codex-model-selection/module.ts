/** 原 workspace catalog 应用端口；requires 与 architecture-policy.yaml 同步。 */
export const codexModelSelectionModule = {
  id: "codex-model-selection",
  requires: ["provider", "shared", "rpc", "services"],
  provides: ["codex-model-selection"],
  publicEntrypoints: [
    "contract.ts",
    "../codexHostModelCatalog.ts",
    "../codexModelSelectionService.ts",
  ],
} as const;
