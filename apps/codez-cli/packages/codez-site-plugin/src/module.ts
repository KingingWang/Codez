/**
 * codez-site-panel 模块清单（architecture-governance managed 模块）。
 * 层：app。修改 requires 时同步更新 architecture-policy.yaml（检查器会校验两者一致）。
 */
export const codezSitePanelModule = {
  id: "codez-site-panel",
  requires: ["shared"],
  provides: ["codez-site-panel"],
  publicEntrypoints: ["index.ts", "contract.ts"],
} as const;
