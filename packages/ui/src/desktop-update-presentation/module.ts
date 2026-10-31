/** desktop-update-presentation 模块清单；层：domain，updater 生命周期不在此处。 */
export const desktopUpdatePresentationModule = {
  id: "desktop-update-presentation",
  requires: ["shared"],
  provides: ["desktop-update-presentation"],
  publicEntrypoints: ["contract.ts", "../lib/desktopUpdateMenu.ts"],
} as const;
