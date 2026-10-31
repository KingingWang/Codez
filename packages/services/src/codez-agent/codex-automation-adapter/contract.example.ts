import type {
  BuildCodexAutomationPayload,
  CodexAutomationCorrelationPort,
  CodexAutomationSendInput,
} from "./contract.js";

/** 未选择模型时保持稀疏默认值，不编造 reasoning effort。 */
export const automationPromptExample = {
  text: "Summarize pending changes.",
} satisfies CodexAutomationSendInput;

export function automationPayloadExample(buildPayload: BuildCodexAutomationPayload) {
  return buildPayload(automationPromptExample);
}

export const correlationLookupExample = {
  workspaceKey: "/workspace/example",
  runId: "example-run",
} satisfies Parameters<CodexAutomationCorrelationPort["get"]>[0];
