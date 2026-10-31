/** 将可信 attachment 目标传给原 Host model selection service。 */
export const desktopModelSelectionAttachmentModule = {
  id: "desktop-model-selection-attachment",
  requires: ["services", "shared", "rpc"],
  provides: ["desktop-model-selection-attachment"],
  publicEntrypoints: ["contract.ts", "../modelSelectionAttachmentScope.ts"],
} as const;
