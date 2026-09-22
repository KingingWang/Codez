import {
  commandPayloadSchemas,
  type CommandEnvelope,
  type CommandResult,
} from "@zcode/shared/zcode-protocol-v4";
import type { CodexRpcPort } from "./contract.js";
import type { ThreadStateStore } from "./thread-state.js";
import {
  decorateNativeThread,
  nativeInput,
  selectionOverrides,
  turnMode,
  type ResolveAttachments,
} from "./command-input.js";
import { string, unsupported } from "./json.js";

export async function createNativeSession(
  command: CommandEnvelope,
  context: {
    rpc: CodexRpcPort;
    store: ThreadStateStore;
    workspaceId: string;
    attachments?: ResolveAttachments;
  },
): Promise<CommandResult> {
  const { rpc, store, workspaceId, attachments } = context;
  const p = commandPayloadSchemas.createSession.parse(command.payload);
  if (p.workspaceId !== workspaceId && p.workspaceId !== store.cwd)
    throw new Error("Workspace identity mismatch");
  if (p.mcpServers?.length || p.offPeakToolEnabled || p.dynamicWorkflowEnabled)
    unsupported("legacy session extensions; configure native Codex MCP and plugins instead");
  if ((p.firstInput?.mode ?? p.config?.mode) === "edit") unsupported("edit mode");
  const selection = p.firstInput?.modelSelection ?? p.config?.modelSelection;
  const response = await rpc.request("thread/start", {
    cwd: store.cwd,
    historyMode: "paginated",
    model: selection?.modelId ?? p.config?.model,
    modelProvider: selection?.providerId ?? p.config?.provider,
  });
  const state = store.markStarted(decorateNativeThread(response));
  const sessionId = string(state.thread.id);
  if (
    !p.firstInput &&
    (p.config?.mode || p.config?.planEnabled !== undefined || p.config?.thought)
  ) {
    const settings = {
      threadId: sessionId,
      effort: p.config.thought,
      ...turnMode(
        p.config.mode,
        state.thread.model as string | undefined,
        p.config.planEnabled,
        p.config.thought ?? (state.thread.reasoningEffort as string | undefined),
        state.thread.sandboxPolicy,
      ),
    };
    await rpc.request("thread/settings/update", settings);
    store.applySettings(sessionId, settings);
  }
  if (p.firstInput) {
    const turnParams = {
      threadId: sessionId,
      clientUserMessageId: command.commandId,
      input: await nativeInput(p.firstInput.text, p.firstInput.attachments, sessionId, attachments),
      ...selectionOverrides(selection),
      ...(p.config?.thought && !selection?.options?.reasoningLevel
        ? { effort: p.config.thought }
        : {}),
      ...turnMode(
        p.firstInput.mode ?? p.config?.mode,
        selection?.modelId ?? (state.thread.model as string | undefined),
        p.firstInput.planEnabled ?? p.config?.planEnabled,
        selection?.options?.reasoningLevel ?? p.config?.thought,
        state.thread.sandboxPolicy,
      ),
    };
    const response = await rpc.request("turn/start", turnParams);
    store.applySettings(sessionId, turnParams);
    store.acceptTurnResponse(sessionId, response);
  }
  return {
    type: "createSession",
    sessionId,
    ...(p.firstInput
      ? { input: { delivery: "startNow" as const, inputId: command.commandId } }
      : {}),
  };
}
