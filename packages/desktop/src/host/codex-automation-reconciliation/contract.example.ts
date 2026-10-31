import {
  assertCodexScheduledPromptCapability,
  codexCorrelationStateFromRunOutcome,
  codexRunOutcomeFromCorrelationState,
  reconcileCodexAutomationHistory,
} from "../codexAutomationCorrelation.js";
import type { CodexAutomationReconciliationPort } from "./contract.js";

/** 示例引用既有实现，不创建 scheduler、ledger、native turn 或第二份事实。 */
export const codexAutomationReconciliationExample = {
  assertCodexScheduledPromptCapability,
  reconcileCodexAutomationHistory,
  codexCorrelationStateFromRunOutcome,
  codexRunOutcomeFromCorrelationState,
} satisfies CodexAutomationReconciliationPort;
