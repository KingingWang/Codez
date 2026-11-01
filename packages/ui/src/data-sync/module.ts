/**
 * data-sync 模块清单（architecture-governance managed 模块）。
 * 层：contract < domain（比较纯函数）< app（分类适配器、弹窗状态）< ui（设置页与弹窗、index）。
 * 修改 requires 时同步更新 architecture-policy.yaml（检查器会校验两者一致）。
 */
export const dataSyncModule = {
  id: "data-sync",
  // provider-bootstrap-ui：复用 UI 唯一的 Host 运行时解析器 resolveRootProviderStartupMode
  // （specs/data-sync-codex-backend.md「判定信号与唯一来源」），不新造第二个 agentRuntimeMode 解释。
  requires: ["services", "shared", "ui", "conversation-workspace-target", "provider-bootstrap-ui"],
  provides: ["data-sync"],
  publicEntrypoints: ["index.ts", "contract.ts"],
} as const;
