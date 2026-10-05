import {
  commandPayloadSchemas,
  type CommandEnvelope,
  type CommandResult,
} from "@codez/shared/codez-protocol-v4";
import type { CodexRpcPort } from "./contract.js";
import type { ThreadStateStore } from "./thread-state.js";
import {
  decorateNativeThread,
  nativeInput,
  selectionOverrides,
  type ResolveAttachments,
} from "./command-input.js";
import { object, string } from "./json.js";
import {
  SELECTION_SIDE_CHAT_THREAD_SOURCE,
  withSelectionSideChatBoundary,
} from "./selection-side-chat.js";

export interface SelectionSideSessionContext {
  rpc: CodexRpcPort;
  store: ThreadStateStore;
  attachments?: ResolveAttachments;
}

/**
 * 创建辅助对话 child：原生 fork + threadSource 持久化标记；fork 复制父历史作为
 * 模型参考上下文、保留源 turn id，fork 后立即可写。firstInput 只落 child，
 * 作为首条自有输入随带边界指令（spec: codex-selection-side-chat）。
 */
export async function createSelectionSideSession(
  command: CommandEnvelope,
  context: SelectionSideSessionContext,
): Promise<CommandResult> {
  const { rpc, store, attachments } = context;
  const p = commandPayloadSchemas.createSelectionSideSession.parse(command.payload);
  const forked = decorateNativeThread(
    await rpc.request("thread/fork", {
      threadId: string(command.sessionId, "sessionId"),
      threadSource: SELECTION_SIDE_CHAT_THREAD_SOURCE,
    }),
  );
  const childId = string(object(forked).id);
  store.markStarted(forked);
  // 完整冷加载：识别标记并建立继承裁剪集合，UI 随后的订阅拿到已裁剪快照。
  await store.reloadAfterHistoryChange(childId);
  if (!p.firstInput) return { type: "createSelectionSideSession", sessionId: childId };
  const childInput = await nativeInput(
    withSelectionSideChatBoundary(p.firstInput.text),
    undefined,
    childId,
    attachments,
  );
  const started = await rpc.request("turn/start", {
    threadId: childId,
    input: childInput,
    clientUserMessageId: command.commandId,
    ...selectionOverrides(p.firstInput.modelSelection),
  });
  store.acceptTurnResponse(childId, started);
  return {
    type: "createSelectionSideSession",
    sessionId: childId,
    input: { delivery: "startNow", inputId: command.commandId },
  };
}
