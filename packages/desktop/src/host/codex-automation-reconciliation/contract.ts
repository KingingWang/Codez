import type { ICodezAgentService } from "@codez/services";
import type {
  CodexAutomationCorrelationState,
  CodexAutomationHistoryResolution,
} from "@codez/services/node";
import type { CodezAutomationRunOutcome } from "@codez/shared";
import type { ConversationRow } from "@codez/shared/codez-protocol-v4";

export type CodexAutomationTerminalState = Extract<
  CodexAutomationCorrelationState,
  "completed" | "failed" | "stopped"
>;
export type CodexAutomationTerminalOutcome = Exclude<CodezAutomationRunOutcome, "running">;
export type CodexScheduledPromptCapabilityReader = Pick<ICodezAgentService, "helloConversationV4">;

/** 原生历史是唯一 admission/终态证据；此端口只读，不发起或重发 turn。 */
export interface ConversationRowsRangeReader {
  conversationRowsRangeV4(params: {
    workspacePath: string;
    workspaceIdentity?: string;
    remoteSessionId?: string;
    sessionId: string;
    beforeRowId?: number;
    limit: number;
  }): Promise<{ rows: ConversationRow[]; hasMore: boolean }>;
}

export interface CodexAutomationHistoryReconciliationInput {
  agentService: ConversationRowsRangeReader;
  workspacePath: string;
  workspaceIdentity?: string;
  remoteSessionId?: string;
  threadId: string;
  commandId: string;
}

export type CodexAutomationHistoryReconciliation =
  | { kind: "resolved"; resolution: CodexAutomationHistoryResolution }
  | { kind: "missing" }
  | { kind: "unrecoverable"; error: unknown }
  | { kind: "unavailable"; error: unknown };

export interface CodexAutomationReconciliationPort {
  assertCodexScheduledPromptCapability(
    agentService: CodexScheduledPromptCapabilityReader,
  ): Promise<void>;
  reconcileCodexAutomationHistory(
    input: CodexAutomationHistoryReconciliationInput,
  ): Promise<CodexAutomationHistoryReconciliation>;
  codexCorrelationStateFromRunOutcome(
    outcome: CodexAutomationTerminalOutcome,
  ): CodexAutomationTerminalState;
  codexRunOutcomeFromCorrelationState(
    state: CodexAutomationTerminalState,
  ): CodexAutomationTerminalOutcome;
}
