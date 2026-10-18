import {
  commandPayloadSchemas,
  type CommandEnvelope,
  type CommandResult,
} from "@codez/shared/codez-protocol-v4";
import type { CodexRpcPort } from "./contract.js";
import type { ThreadProjectionState, ThreadStateStore } from "./thread-state.js";
import {
  decorateNativeThread,
  nativeInput,
  selectionOverrides,
  turnMode,
  type ResolveAttachments,
} from "./command-input.js";
import { turnPermissionIntent } from "./control-common.js";
import { array, object, string, unsupported } from "./json.js";
import { projectThread } from "./projection.js";
import type { SessionTitleCoordinator } from "./session-title.js";
import type { CodexProviderKeyGate } from "./provider-key-gate.js";

/** forkAssistant：在指定轮尾 fork 出新的 native thread 并返回新 sessionId。 */
export async function executeForkAssistant(input: {
  command: CommandEnvelope;
  rpc: CodexRpcPort;
  store: ThreadStateStore;
  state: ThreadProjectionState;
  sessionId: string;
}): Promise<CommandResult> {
  const { command, rpc, store, state, sessionId } = input;
  const p = commandPayloadSchemas.forkAssistant.parse(command.payload);
  const snapshot = projectThread(state.thread, { workspacePath: store.cwd });
  const row = snapshot.rows.window.find(
    (candidate) => candidate.rowId === p.target.rowId && candidate.entityId === p.target.entityId,
  );
  if (!row) throw new Error("Target row no longer exists");
  const result = decorateNativeThread(
    await rpc.request("thread/fork", {
      threadId: sessionId,
      lastTurnId: row.turnId,
    }),
  );
  store.markStarted(result);
  await store.reloadAfterHistoryChange(string(result.id));
  return { type: "forkAssistant", sessionId: string(result.id) };
}

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
  if (running) throw new Error("Stop the active turn before changing conversation history");
  if ("workspaceMode" in p && p.workspaceMode === "rewind")
    unsupported("file rewind; Codex history revert does not undo files");
  const snapshot = projectThread(state.thread, { workspacePath: store.cwd });
  const row = snapshot.rows.window.find(
    (candidate) => candidate.rowId === p.target.rowId && candidate.entityId === p.target.entityId,
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
    edit?.modelSelection?.providerId ?? codexThreadProviderId(state.thread),
  );
  await rpc.request("thread/revert", {
    threadId: sessionId,
    beforeTurnId: row.turnId,
  });
  await store.reloadAfterHistoryChange(sessionId);
  // 修复原因：Codex 模式下编辑历史消息重发时，旧实现直接调用仅含 input 的 turn/start，
  // 忽略了 editUserQuery 载荷中用户新选的 modelSelection / mode / planEnabled。
  // 修复依据：当 edit 携带模型或模式覆盖时，按 sendText 同款规则构造 turnParams 并同步线程状态；
  // 未携带时保持纯 turn/start 向后兼容。
  const hasEditOverrides = Boolean(
    edit && (edit.modelSelection || edit.mode !== undefined || edit.planEnabled !== undefined),
  );
  const permissions = hasEditOverrides
    ? await turnPermissionIntent({ rpc, cwd: store.cwd }, state.thread, edit?.mode)
    : undefined;
  const turnParams = {
    threadId: sessionId,
    input: turnInput,
    clientUserMessageId: command.commandId,
    ...(edit
      ? {
          ...selectionOverrides(edit.modelSelection),
          ...turnMode(
            edit.mode,
            edit.modelSelection?.modelId ?? (state.thread.model as string | undefined),
            edit.planEnabled,
            edit.modelSelection?.options?.reasoningLevel ??
              (state.thread.reasoningEffort as string | undefined),
            permissions,
          ),
        }
      : {}),
  };
  const response = await rpc.request("turn/start", turnParams);
  if (hasEditOverrides && edit) {
    store.applySettings(sessionId, {
      ...turnParams,
      ...(edit.modelSelection ? { modelProvider: edit.modelSelection.providerId } : {}),
    });
    store.rememberMode(sessionId, edit.mode);
  }
  store.acceptTurnResponse(sessionId, response);
}

/** 线程当前执行供应商；未显式设置时返回 undefined，由门禁回退到 config 默认值。 */
export function codexThreadProviderId(thread: Record<string, unknown>): string | undefined {
  const value = thread.modelProvider;
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
