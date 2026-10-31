import type {
  buildCodexAutomationSendTextPayload,
  resolveCodexAutomationHistory,
  resolveCodexAutomationTerminalOutcome,
} from "../codexAutomationAdapter.js";
import type { CodexAutomationCorrelationRepo } from "../../session/codexAutomationCorrelation.js";

export type {
  CodexAutomationSendInput,
  CodexAutomationSendTextPayload,
  CodexAutomationHistoryResolution,
} from "../codexAutomationAdapter.js";
export type {
  CodexAutomationCorrelation,
  CodexAutomationCorrelationState,
} from "../../session/codexAutomationCorrelation.js";

export type BuildCodexAutomationPayload = typeof buildCodexAutomationSendTextPayload;
export type ResolveCodexAutomationHistory = typeof resolveCodexAutomationHistory;
export type ResolveCodexAutomationTerminalOutcome = typeof resolveCodexAutomationTerminalOutcome;
export type CodexAutomationCorrelationPort = Pick<
  CodexAutomationCorrelationRepo,
  "get" | "prepare" | "transition"
>;
