/** draft-suggested-prompts 模块清单；层：domain，草稿与提交 owner 不变。 */
export const draftSuggestedPromptsModule = {
  id: "draft-suggested-prompts",
  requires: ["ui"],
  provides: ["draft-suggested-prompts"],
  publicEntrypoints: [
    "contract.ts",
    "../v4/featureSuggestedPrompts.ts",
    "../v4/officeSuggestedPrompts.ts",
  ],
} as const;
