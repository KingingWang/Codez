export const gitRemovalContractModule = {
  id: "git-removal-contract",
  requires: ["shared"],
  provides: ["git-removal-contract"],
  publicEntrypoints: [
    "packages/shared/src/git-removal-contract/contract.ts",
    "packages/shared/src/gitRemoval.ts",
  ],
} as const;
