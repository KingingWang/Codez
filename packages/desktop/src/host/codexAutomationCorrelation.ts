import type { ICodezAgentService } from "@codez/services";
import {
  isCodexScheduledPromptCapabilitySupported,
  resolveCodexAutomationHistory,
  type CodexAutomationHistoryResolution,
} from "@codez/services/node";
import type { ConversationRow } from "@codez/shared/codez-protocol-v4";

export type CodexAutomationHistoryReconciliation =
  | { kind: "resolved"; resolution: CodexAutomationHistoryResolution }
  | { kind: "missing" }
  | { kind: "unrecoverable"; error: unknown }
  | { kind: "unavailable"; error: unknown };

interface ConversationRowsRangeReader {
  conversationRowsRangeV4(params: {
    workspacePath: string;
    workspaceIdentity?: string;
    remoteSessionId?: string;
    sessionId: string;
    beforeRowId?: number;
    limit: number;
  }): Promise<{
    rows: ConversationRow[];
    hasMore: boolean;
  }>;
}

/**
 * Capability read is deliberately side-effect free. A missing/degraded authority answer must
 * stop the automation before any native send, rather than being inferred from a command failure.
 */
export async function assertCodexScheduledPromptCapability(
  agentService: Pick<ICodezAgentService, "helloConversationV4">,
): Promise<void> {
  const hello = await agentService.helloConversationV4();
  const capability = hello.capabilities.codex?.scheduledPromptAutomations;
  if (!isCodexScheduledPromptCapabilitySupported({ scheduledPromptAutomations: capability })) {
    throw new Error(
      `Codex scheduled prompt automations are unavailable (${capability ?? "missing capability"})`,
    );
  }
}

/**
 * Reconciliation reads authoritative native history by run-derived command id. It never resends;
 * only a terminal row can resolve an ambiguous send.
 */
export async function reconcileCodexAutomationHistory(params: {
  agentService: ConversationRowsRangeReader;
  workspacePath: string;
  workspaceIdentity?: string;
  remoteSessionId?: string;
  threadId: string;
  commandId: string;
}): Promise<CodexAutomationHistoryReconciliation> {
  const rows: ConversationRow[] = [];
  let beforeRowId: number | undefined;
  let hasMore = true;
  try {
    do {
      const page = await params.agentService.conversationRowsRangeV4({
        workspacePath: params.workspacePath,
        ...(params.workspaceIdentity ? { workspaceIdentity: params.workspaceIdentity } : {}),
        ...(params.remoteSessionId ? { remoteSessionId: params.remoteSessionId } : {}),
        sessionId: params.threadId,
        ...(beforeRowId === undefined ? {} : { beforeRowId }),
        limit: 200,
      });
      rows.push(...page.rows);
      const firstRowId = page.rows[0]?.rowId;
      if (page.hasMore && firstRowId === undefined) {
        return { kind: "unavailable", error: new Error("History pagination returned no rows") };
      }
      hasMore = page.hasMore;
      if (hasMore && firstRowId === beforeRowId) {
        return { kind: "unavailable", error: new Error("History pagination did not advance") };
      }
      beforeRowId = firstRowId;
    } while (hasMore);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return /\b(thread|session)\b.*\b(not found|was deleted)\b/iu.test(message) ||
      /\b(thread was deleted)\b/iu.test(message)
      ? { kind: "unrecoverable", error }
      : { kind: "unavailable", error };
  }

  const resolution = resolveCodexAutomationHistory(rows, params.commandId);
  return resolution ? { kind: "resolved", resolution } : { kind: "missing" };
}
