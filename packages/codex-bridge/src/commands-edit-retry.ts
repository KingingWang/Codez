import {
  commandPayloadSchemas,
  type CommandEnvelope,
} from "@codez/shared/codez-protocol-v4";
import type { CodexRpcPort } from "./contract.js";
import type {
  ThreadProjectionState,
  ThreadStateStore,
} from "./thread-state.js";
import { nativeInput, type ResolveAttachments } from "./command-input.js";
import { array, object, unsupported } from "./json.js";
import { projectThread } from "./projection.js";
import type { SessionTitleCoordinator } from "./session-title.js";
import type { CodexProviderKeyGate } from "./provider-key-gate.js";

/** editUserQuery / retryTurn：revert 历史后以同一供应商重新发起 turn。 */
export async function editUserQueryOrRetryTurn(input: {
  command: CommandEnvelope;
  rpc: CodexRpcPort;
  store: ThreadStateStore;
  state: ThreadProjectionState;
  sessionId: string;
  running: unknown;
  attachments?: ResolveAttachments;
  title?: SessionTitleCoordinator;
  providerKeyGate?: CodexProviderKeyGate;
}): Promise<void> {
  const { command, rpc, store, state, sessionId, running, attachments } = input;
  input.title?.cancel(sessionId);
  const p =
    command.type === "editUserQuery"
      ? commandPayloadSchemas.editUserQuery.parse(command.payload)
      : commandPayloadSchemas.retryTurn.parse(command.payload);
  if (running)
    throw new Error(
      "Stop the active turn before changing conversation history",
    );
  if ("workspaceMode" in p && p.workspaceMode === "rewind")
    unsupported("file rewind; Codex history revert does not undo files");
  const snapshot = projectThread(state.thread, { workspacePath: store.cwd });
  const row = snapshot.rows.window.find(
    (candidate) =>
      candidate.rowId === p.target.rowId &&
      candidate.entityId === p.target.entityId,
  );
  if (!row) throw new Error("Target row no longer exists");
  const turn = array(state.thread.turns)
    .map(object)
    .find((candidate) => candidate.id === row.turnId);
  const user = array(turn?.items)
    .map(object)
    .find((item) => item.type === "userMessage");
  if (!user) throw new Error("Original user input is unavailable");
  const edit =
    command.type === "editUserQuery"
      ? commandPayloadSchemas.editUserQuery.parse(command.payload)
      : undefined;
  const turnInput = edit
    ? await nativeInput(edit.newText, edit.attachments, sessionId, attachments)
    : user.content;
  // 缺本机临时 Key 的供应商在 revert+turn/start 前 fail-closed。
  await input.providerKeyGate?.assertTurnAllowed(
    codexThreadProviderId(state.thread),
  );
  await rpc.request("thread/revert", {
    threadId: sessionId,
    beforeTurnId: row.turnId,
  });
  await store.reloadAfterHistoryChange(sessionId);
  const response = await rpc.request("turn/start", {
    threadId: sessionId,
    input: turnInput,
    clientUserMessageId: command.commandId,
  });
  store.acceptTurnResponse(sessionId, response);
}

/** 线程当前执行供应商；未显式设置时返回 undefined，由门禁回退到 config 默认值。 */
export function codexThreadProviderId(
  thread: Record<string, unknown>,
): string | undefined {
  const value = thread.modelProvider;
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
