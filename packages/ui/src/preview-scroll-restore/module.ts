/** preview-scroll-restore 模块清单；层：ui，运行时状态仍归各预览组件。 */
export const previewScrollRestoreModule = {
  id: "preview-scroll-restore",
  requires: ["ui"],
  provides: ["preview-scroll-restore"],
  publicEntrypoints: ["index.ts", "contract.ts"],
} as const;
