/**
 * codex-model-trajectory 模块清单（architecture-governance managed 模块）。
 * 层：adapters。修改 requires 时同步更新 architecture-policy.yaml（检查器会校验两者一致）。
 */
export const codexModelTrajectoryModule = {
  id: "codex-model-trajectory",
  // shared：Codex rollout 投影复用 isInjectedCodexContextTitle 这一单一谓词，识别以 user 角色
  // 落盘的注入信封（`# AGENTS.md instructions …` / `<environment_context>`），不在本模块另写正则。
  requires: ["services", "session", "shared"],
  provides: ["codex-model-trajectory"],
  publicEntrypoints: ["index.ts", "contract.ts"],
} as const;
