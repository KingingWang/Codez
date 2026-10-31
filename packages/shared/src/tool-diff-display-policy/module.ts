export const toolDiffDisplayPolicyModule = {
  id: "tool-diff-display-policy",
  requires: [],
  provides: ["tool-diff-display-policy"],
  publicEntrypoints: [
    "packages/shared/src/tool-diff-display-policy/contract.ts",
    "packages/shared/src/toolDiffDisplayLimits.ts",
  ],
} as const;
