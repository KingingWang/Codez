import type * as FeaturePrompts from "@/v4/featureSuggestedPrompts.js";
import type * as OfficePrompts from "@/v4/officeSuggestedPrompts.js";

/** 既有静态语料和纯候选筛选；不读取服务、提交消息或持有草稿。 */
export interface DraftSuggestedPromptsContract {
  readonly getFeaturePromptPool: typeof FeaturePrompts.getRecommendedPromptPool;
  readonly getOfficePromptPool: typeof OfficePrompts.getRecommendedPromptPool;
  readonly featurePrompts: Readonly<typeof FeaturePrompts.featureSuggestedPrompts>;
  readonly officePrompts: Readonly<typeof OfficePrompts.officeSuggestedPrompts>;
  readonly defaultPrompts: Readonly<typeof OfficePrompts.defaultSuggestedPrompts>;
}
