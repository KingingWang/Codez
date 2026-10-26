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
  projectThreadMode,
  selectionOverrides,
  type ResolveAttachments,
} from "./command-input.js";
import { object, string } from "./json.js";
import {
  SELECTION_SIDE_CHAT_THREAD_SOURCE,
  resolveSelectionSideChatBoundary,
  withSelectionSideChatBoundary,
} from "./selection-side-chat.js";
import type { CodexProviderKeyGate } from "./provider-key-gate.js";

export interface SelectionSideSessionContext {
  rpc: CodexRpcPort;
  store: ThreadStateStore;
  attachments?: ResolveAttachments;
  providerKeyGate?: CodexProviderKeyGate;
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
  const parentId = string(command.sessionId, "sessionId");
  const parentThread = store.get(parentId)?.thread;
  const forked = decorateNativeThread(
    await rpc.request("thread/fork", {
      threadId: parentId,
      threadSource: SELECTION_SIDE_CHAT_THREAD_SOURCE,
    }),
  );
  // 修复原因：
  // 1) 父会话在运行中或跨 provider 切换模型后，store 中的 parentThread 已记录最新生效的
  //    model / modelProvider / reasoningEffort / collaborationMode 及权限档位，而原生
  //    thread/fork 响应可能缺失这些运行期覆写（或回退到创建期默认 provider），导致辅助对话
  //    打开后丢失主会话的模型、思考等级和模式；
  // 2) 过去在 markStarted 后无条件调用 reloadAfterHistoryChange，会额外串行发起
  //    thread/read + thread/resume + thread/turns/list(child) + thread/turns/list(parent) + thread/queue/list
  //    5 次原生 RPC，造成本地和远程打开辅助对话明显卡顿。
  // 修复依据：合并已加载父线程的生效配置，并在 forked 已带完整 turns 时直接用父线程内存 turns
  // 建立继承裁剪集合，省去冗余冷加载。
  const inheritedThread: Record<string, unknown> = {
    ...(typeof parentThread?.model === "string" && parentThread.model
      ? { model: parentThread.model }
      : {}),
    ...(typeof parentThread?.modelProvider === "string" && parentThread.modelProvider
      ? { modelProvider: parentThread.modelProvider }
      : {}),
    ...(typeof parentThread?.reasoningEffort === "string" && parentThread.reasoningEffort
      ? { reasoningEffort: parentThread.reasoningEffort }
      : {}),
    ...(parentThread?.collaborationMode !== undefined
      ? { collaborationMode: parentThread.collaborationMode }
      : {}),
    ...(parentThread?.approvalPolicy !== undefined
      ? { approvalPolicy: parentThread.approvalPolicy }
      : {}),
    ...(parentThread?.approvalsReviewer !== undefined
      ? { approvalsReviewer: parentThread.approvalsReviewer }
      : {}),
    ...(parentThread?.sandboxPolicy !== undefined
      ? { sandboxPolicy: parentThread.sandboxPolicy }
      : {}),
    ...forked,
    ...(typeof forked.model === "string" && forked.model
      ? { model: forked.model }
      : typeof parentThread?.model === "string" && parentThread.model
        ? { model: parentThread.model }
        : {}),
    ...(typeof parentThread?.modelProvider === "string" && parentThread.modelProvider
      ? { modelProvider: parentThread.modelProvider }
      : {}),
    ...(typeof forked.reasoningEffort === "string" && forked.reasoningEffort
      ? { reasoningEffort: forked.reasoningEffort }
      : typeof parentThread?.reasoningEffort === "string" && parentThread.reasoningEffort
        ? { reasoningEffort: parentThread.reasoningEffort }
        : {}),
    ...(forked.collaborationMode !== undefined
      ? { collaborationMode: forked.collaborationMode }
      : parentThread?.collaborationMode !== undefined
        ? { collaborationMode: parentThread.collaborationMode }
        : {}),
  };
  const childId = string(object(inheritedThread).id);
  const childState = store.markStarted(inheritedThread);
  if (parentThread) {
    store.rememberMode(childId, projectThreadMode(parentThread));
  }
  const hasFullTurns =
    Array.isArray(inheritedThread.turns) &&
    inheritedThread.turns.every((turn) => object(turn).itemsView === "full");
  if (hasFullTurns) {
    childState.sideChat = await resolveSelectionSideChatBoundary(
      rpc,
      childState.thread,
      parentThread && Array.isArray(parentThread.turns) ? parentThread.turns : undefined,
    );
  } else {
    await store.reloadAfterHistoryChange(childId);
  }
  if (!p.firstInput) return { type: "createSelectionSideSession", sessionId: childId };
  const childInput = await nativeInput(
    withSelectionSideChatBoundary(p.firstInput.text),
    undefined,
    childId,
    attachments,
  );
  // fork 继承父线程供应商；显式选择优先，缺省时由门禁回退到 config 默认供应商。
  await context.providerKeyGate?.assertTurnAllowed(
    p.firstInput.modelSelection?.providerId ??
      (typeof childState.thread.modelProvider === "string"
        ? childState.thread.modelProvider
        : undefined),
  );
  const started = await rpc.request("turn/start", {
    threadId: childId,
    input: childInput,
    clientUserMessageId: command.commandId,
    ...selectionOverrides(p.firstInput.modelSelection),
  });
  if (p.firstInput.modelSelection) {
    store.applySettings(childId, {
      model: p.firstInput.modelSelection.modelId,
      modelProvider: p.firstInput.modelSelection.providerId,
      ...(p.firstInput.modelSelection.options?.reasoningLevel
        ? { effort: p.firstInput.modelSelection.options.reasoningLevel }
        : {}),
    });
  }
  store.acceptTurnResponse(childId, started);
  return {
    type: "createSelectionSideSession",
    sessionId: childId,
    input: { delivery: "startNow", inputId: command.commandId },
  };
}
