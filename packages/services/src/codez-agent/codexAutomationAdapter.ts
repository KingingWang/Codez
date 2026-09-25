import type { ModelSelection } from "@codez/shared";
import type { ConversationRow, TurnHeaderRow } from "@codez/shared/codez-protocol-v4";

export interface CodexAutomationSendInput {
  text: string;
  modelSelection?: ModelSelection;
}

export type CodexAutomationSendTextPayload = {
  text: string;
  heldQueueDisposition: "keepQueueAndSend";
  modelSelection?: ModelSelection;
};

/**
 * Codex automation v1 is a native prompt only. Legacy execution context must be removed at
 * the adapter boundary instead of relying on the bridge to reject a doomed command.
 */
export function buildCodexAutomationSendTextPayload(
  input: CodexAutomationSendInput,
): CodexAutomationSendTextPayload {
  return {
    text: input.text,
    heldQueueDisposition: "keepQueueAndSend",
    ...(input.modelSelection ? { modelSelection: input.modelSelection } : {}),
  };
}

export type CodexAutomationHistoryResolution =
  | { admitted: true; terminal: false; turnId?: string }
  | { admitted: true; terminal: true; outcome: "completed" | "failed"; turnId?: string };

export function resolveCodexAutomationHistory(
  rows: readonly ConversationRow[],
  commandId: string,
): CodexAutomationHistoryResolution | null {
  const turn = rows.find(
    (row): row is TurnHeaderRow => row.kind === "turnHeader" && row.sourceCommandId === commandId,
  );
  if (turn) {
    if (turn.state === "running") return { admitted: true, terminal: false, turnId: turn.turnId };
    return {
      admitted: true,
      terminal: true,
      outcome: turn.state === "completedSuccess" ? "completed" : "failed",
      turnId: turn.turnId,
    };
  }
  const userInput = rows.some(
    (row) => row.kind === "userInput" && row.sourceCommandId === commandId,
  );
  return userInput ? { admitted: true, terminal: false } : null;
}

export function isCodexScheduledPromptCapabilitySupported(capability: unknown): boolean {
  return (
    typeof capability === "object" &&
    capability !== null &&
    (capability as { scheduledPromptAutomations?: unknown }).scheduledPromptAutomations ===
      "supported"
  );
}
