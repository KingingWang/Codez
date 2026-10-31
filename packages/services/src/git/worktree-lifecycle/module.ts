/** 原 Git operation adapter；requires 与 architecture-policy.yaml 同步。 */
export const gitWorktreeLifecycleModule = {
  id: "git-worktree-lifecycle",
  requires: ["shared", "services"],
  provides: ["git-worktree-lifecycle"],
  publicEntrypoints: [
    "contract.ts",
    "../repo/gitWorktreeCreation.ts",
    "../repo/gitWorktreeRemoval.ts",
    "../repo/gitBranchDeletion.ts",
    "../repo/gitRemovalErrors.ts",
  ],
} as const;
