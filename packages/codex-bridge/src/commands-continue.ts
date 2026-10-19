import type {
  CommandEnvelope,
  CommandPayloadMap,
  CommandResult,
} from "@codez/shared/codez-protocol-v4";
import type { CodexRpcPort } from "./contract.js";
import type { ThreadProjectionState, ThreadStateStore } from "./thread-state.js";
import { selectionOverrides, turnMode } from "./command-input.js";
import { turnPermissionIntent } from "./control-common.js";
import { array, object, string, type JsonObject } from "./json.js";
import { projectThread } from "./projection.js";
import { isHiddenContinuationUserMessage } from "./projection-item-extras.js";

/** 原生 Codex 识别为 contextual user fragment 的内部继续标记，不会写入可见提示词文本。 */
export const CODEX_INTERNAL_CONTINUE_TEXT =
  '<codex_internal_context source="continue">\n\n</codex_internal_context>';

const COMPLETED_STATUS_TOOL_TYPES = new Set([
  "commandExecution",
  "fileChange",
  "mcpToolCall",
  "collabAgentToolCall",
  "dynamicToolCall",
  "imageGeneration",
]);

const IMPLICITLY_COMPLETED_TOOL_TYPES = new Set([
  "imageView",
  "webSearch",
  "functionCallOutput",
]);

/** 判断中断轮中是否已有执行完成的工具调用。 */
export function hasCompletedToolInCodexTurn(turn: JsonObject): boolean {
  for (const raw of array(turn.items)) {
    const item = object(raw);
    const type = typeof item.type === "string" ? item.type : "";
    if (IMPLICITLY_COMPLETED_TOOL_TYPES.has(type)) return true;
    if (COMPLETED_STATUS_TOOL_TYPES.has(type) && item.status === "completed") return true;
    if (type === "subAgentActivity" && item.kind === "completed") return true;
  }
  return false;
}

function findOriginalUserInputForInterruptedTurn(
  turns: readonly JsonObject[],
  startIndex: number,
): unknown[] | undefined {
  for (let index = startIndex; index >= 0; index -= 1) {
    const turn = turns[index]!;
    const user = array(turn.items)
      .map(object)
      .find((item) => item.type === "userMessage");
    if (!user) continue;
    if (isHiddenContinuationUserMessage(user)) continue;
    return array(user.content);
  }
  return undefined;
}

function findRevertAnchorTurnId(turns: readonly JsonObject[], startIndex: number): string {
  let index = startIndex;
  while (index > 0) {
    const turn = turns[index]!;
    const user = array(turn.items)
      .map(object)
      .find((item) => item.type === "userMessage");
    if (user && !isHiddenContinuationUserMessage(user)) {
      break;
    }
    index -= 1;
  }
  return string(turns[index]?.id, "turnId");
}

/**
 * 中断轮的「继续」：
 * - 若该轮尚未完成任何工具调用（思考/流式中断或首个工具未执行完中断），
 *   通过 `thread/revert` 回退未完成轮次，并以最新模型/思考强度重发原始用户输入。
 * - 若该轮已有已完成工具调用，保留已完成工具上下文，通过隐藏的内部上下文标记启动续跑，
 *   不产生合成用户提示词气泡。
 */
export async function executeInterruptedTurnContinue(input: {
  command: CommandEnvelope;
  payload: Pick<
    CommandPayloadMap["sendText"],
    "interruptedContinueTarget" | "modelSelection" | "mode" | "planEnabled"
  >;
  rpc: CodexRpcPort;
  store: ThreadStateStore;
  state: ThreadProjectionState;
  sessionId: string;
  running: JsonObject | undefined;
}): Promise<CommandResult> {
  const { command, payload, rpc, store, state, sessionId, running } = input;
  if (running) {
    throw new Error("Cannot continue while a turn is still running");
  }
  const target = payload.interruptedContinueTarget;
  if (!target) {
    throw new Error("Missing interrupted continue target");
  }
  const snapshot = projectThread(state.thread, { workspacePath: store.cwd });
  const row = snapshot.rows.window.find(
    (candidate) =>
      candidate.rowId === target.rowId && candidate.entityId === target.entityId,
  );
  const lastRow = snapshot.rows.window.at(-1);
  if (!row || !lastRow || row.turnId !== lastRow.turnId) {
    throw new Error("Target row is no longer the latest interrupted turn");
  }
  const turns = array(state.thread.turns).map(object);
  const lastTurnIndex = turns.length - 1;
  const lastTurn = turns[lastTurnIndex];
  if (!lastTurn || lastTurn.status !== "interrupted") {
    throw new Error("Latest turn is not interrupted");
  }

  const native = { threadId: sessionId };
  const controlContext = { rpc, cwd: store.cwd };
  const permissions = await turnPermissionIntent(
    controlContext,
    state.thread,
    payload.mode,
  );
  const settingsOverrides = {
    ...selectionOverrides(payload.modelSelection),
    ...turnMode(
      payload.mode,
      payload.modelSelection?.modelId ?? (state.thread.model as string | undefined),
      payload.planEnabled,
      payload.modelSelection?.options?.reasoningLevel ??
        (state.thread.reasoningEffort as string | undefined),
      permissions,
    ),
  };

  if (!hasCompletedToolInCodexTurn(lastTurn)) {
    const originalInput = findOriginalUserInputForInterruptedTurn(turns, lastTurnIndex);
    if (!originalInput || originalInput.length === 0) {
      throw new Error("Original user input is unavailable");
    }
    const beforeTurnId = findRevertAnchorTurnId(turns, lastTurnIndex);
    await rpc.request("thread/revert", {
      ...native,
      beforeTurnId,
    });
    await store.reloadAfterHistoryChange(sessionId);
    const turnParams = {
      ...native,
      input: originalInput,
      clientUserMessageId: command.commandId,
      ...settingsOverrides,
    };
    const response = await rpc.request("turn/start", turnParams);
    store.applySettings(sessionId, {
      ...turnParams,
      ...(payload.modelSelection
        ? { modelProvider: payload.modelSelection.providerId }
        : {}),
    });
    store.acceptTurnResponse(sessionId, response);
    store.rememberMode(sessionId, payload.mode);
    return {
      type: "inputAccepted",
      delivery: "startNow",
      inputId: command.commandId,
    };
  }

  const turnParams = {
    ...native,
    input: [{ type: "text", text: CODEX_INTERNAL_CONTINUE_TEXT, text_elements: [] }],
    clientUserMessageId: command.commandId,
    ...settingsOverrides,
  };
  const response = await rpc.request("turn/start", turnParams);
  store.applySettings(sessionId, {
    ...turnParams,
    ...(payload.modelSelection
      ? { modelProvider: payload.modelSelection.providerId }
      : {}),
  });
  store.acceptTurnResponse(sessionId, response);
  store.rememberMode(sessionId, payload.mode);
  return {
    type: "inputAccepted",
    delivery: "startNow",
    inputId: command.commandId,
  };
}
