import type { DraftSuggestedPromptsContract } from "./contract.js";

/** 模式和职业由既有业务 owner 注入；选择建议后的草稿动作不属于此模块。 */
export function exampleDraftSuggestedPrompts(
  contract: DraftSuggestedPromptsContract,
  isOfficeMode: boolean,
  occupation?: string | null,
) {
  return {
    feature: contract.getFeaturePromptPool(isOfficeMode),
    office: contract.getOfficePromptPool(isOfficeMode, occupation),
  };
}
