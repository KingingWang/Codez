/** dynamic-workflow-availability 模块清单；层：app，复用 Root / Host 的能力投影。 */
export const dynamicWorkflowAvailabilityModule = {
  id: "dynamic-workflow-availability",
  requires: ["services", "shared", "ui"],
  provides: ["dynamic-workflow-availability"],
  publicEntrypoints: ["contract.ts", "../hooks/useDynamicWorkflowAvailability.ts"],
} as const;
