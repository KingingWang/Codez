/** 每窗口 renderer 崩溃后的有界原地恢复，原 Host attachment 不重建。 */
export const desktopRendererRecoveryModule = {
  id: "desktop-renderer-recovery",
  requires: [],
  provides: ["desktop-renderer-recovery"],
  publicEntrypoints: ["contract.ts", "../rendererCrashRecovery.ts"],
} as const;
