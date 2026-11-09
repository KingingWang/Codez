import {
  codezSessionStateSnapshotSchema,
  type CodezMessagePart,
  type CodezMessageWithParts,
  type CodezSessionInfo,
  type CodezSessionStateSnapshot,
  type CodezToolState,
} from "@codez/shared";
import type { ConversationRow, ToolCallRow } from "@codez/shared/codez-protocol-v4";
import { codexThreadSchema, type CodexThread, type CodexUserInput } from "./codex-types.js";
import { itemEntityId, projectInputText, projectRows } from "./projection-rows.js";
import { isSelectionSideChatThread } from "./selection-side-chat.js";
import { nativeThreadTitle } from "./native-thread-title.js";
import { isHiddenContinuationUserMessage } from "./projection-item-extras.js";
import type { CodezSessionIndexSemanticInput } from "@codez/shared";

function toolState(row: ToolCallRow, completedAt: number): CodezToolState {
  const input =
    row.input !== null && typeof row.input === "object" && !Array.isArray(row.input)
      ? (row.input as Record<string, unknown>)
      : { arguments: row.input };
  const metadata = {
    source: "codex",
    timingSource: "turn",
    codexStatus: row.status,
    ...(row.output?.truncated ? { outputTruncated: row.output.truncated } : {}),
  };
  if (row.status === "inputStreaming" || row.status === "pendingApproval") {
    return { status: "pending", input, raw: row.inputText };
  }
  if (row.status === "running")
    return { status: "running", input, startedAt: row.createdAt, metadata };
  if (row.status === "success")
    return {
      status: "completed",
      input,
      output: row.output?.text ?? "",
      title: row.toolName,
      metadata,
      startedAt: row.createdAt,
      completedAt,
    };
  return {
    status: "error",
    input,
    error: row.error?.message ?? "Codex tool cancelled",
    metadata,
    startedAt: row.createdAt,
    completedAt,
  };
}

function messagePart(row: ConversationRow, thread: CodexThread): CodezMessagePart | undefined {
  const base = { partId: `${row.entityId}:part`, messageId: row.entityId!, sessionId: thread.id };
  if (row.kind === "userInput" || row.kind === "assistantText")
    return { ...base, type: "text", text: row.text };
  if (row.kind === "reasoning") return { ...base, type: "reasoning", text: row.text };
  if (row.kind === "toolCall") {
    const turn = thread.turns.find((candidate) => candidate.id === row.turnId);
    return {
      ...base,
      type: "tool",
      callId: row.toolCallId,
      tool: row.toolName,
      state: toolState(row, (turn?.completedAt ?? turn?.startedAt ?? thread.createdAt) * 1000),
    };
  }
  return undefined;
}

function messages(
  thread: CodexThread,
  rows: readonly ConversationRow[],
  workspacePath: string,
): CodezMessageWithParts[] {
  const result: CodezMessageWithParts[] = [];
  let parentMessageId: string | undefined;
  for (const row of rows) {
    const part = messagePart(row, thread);
    if (!part) continue;
    if (row.kind === "userInput") {
      parentMessageId = row.entityId!;
      result.push({
        info: {
          messageId: parentMessageId,
          sessionId: thread.id,
          role: "user",
          time: { created: row.createdAt },
          agent: "codex",
          visibility: "user-visible",
          metadata: { sourceCommandId: row.sourceCommandId, timingSource: "turn" },
        },
        parts: [part],
      });
    } else {
      // 旧协议强制要求真实 parentMessageId；缺少用户历史时不能伪造一个悬空父消息。
      if (!parentMessageId)
        throw new Error(
          "Legacy projection requires a preceding user message; use V4 for this history",
        );
      const turn = thread.turns.find((candidate) => candidate.id === row.turnId);
      result.push({
        info: {
          messageId: row.entityId!,
          sessionId: thread.id,
          role: "assistant",
          parentMessageId,
          agent: "codex",
          time: {
            created: row.createdAt,
            ...(turn?.completedAt != null ? { completed: turn.completedAt * 1000 } : {}),
          },
          path: { cwd: workspacePath, root: workspacePath },
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          structured: { source: "codex", usageAvailable: false, timingSource: "turn" },
        },
        parts: [part],
      });
    }
  }
  return result;
}

function lightIndexMessages(
  thread: CodexThread,
  workspacePath: string,
): CodezSessionIndexSemanticInput["messages"] {
  const messages: CodezSessionIndexSemanticInput["messages"] = [];
  let parentMessageId: string | undefined;
  for (const turn of thread.turns) {
    for (const item of turn.items) {
      // 只保留 shared task-index reducer 消费的 user/assistant 文本；工具、reasoning、
      // 图片/事件与 data payload 会撑爆轻量读取，且不参与可见性或搜索派生。
      if (item.type !== "userMessage" && item.type !== "agentMessage" && item.type !== "plan")
        continue;
      if (isHiddenContinuationUserMessage(item)) continue;
      if (item.type === "userMessage") {
        const entityId = itemEntityId(turn.id, item.id);
        const createdAt = (turn.startedAt ?? thread.createdAt) * 1000;
        parentMessageId = entityId;
        messages.push({
          info: {
            messageId: entityId,
            sessionId: thread.id,
            role: "user",
            time: { created: createdAt },
            agent: "codex",
            visibility: "user-visible",
            metadata: {
              ...(item.clientId ? { sourceCommandId: item.clientId } : {}),
              timingSource: "turn",
            },
          },
          parts: [
            {
              partId: `${entityId}:part`,
              messageId: entityId,
              sessionId: thread.id,
              type: "text",
              text: projectInputText(item.content as readonly CodexUserInput[]),
            },
          ],
        });
        continue;
      }
      if (item.type === "agentMessage" || item.type === "plan") {
        const entityId = itemEntityId(turn.id, item.id);
        const createdAt = (turn.startedAt ?? thread.createdAt) * 1000;
        // 与 full legacy 投影同规则：缺少前置真实用户历史时不伪造悬空 parentMessageId。
        if (!parentMessageId)
          throw new Error(
            "Legacy projection requires a preceding user message; use V4 for this history",
          );
        messages.push({
          info: {
            messageId: entityId,
            sessionId: thread.id,
            role: "assistant",
            parentMessageId,
            agent: "codex",
            time: {
              created: createdAt,
              ...(turn.completedAt != null ? { completed: turn.completedAt * 1000 } : {}),
            },
            path: { cwd: workspacePath, root: workspacePath },
            cost: 0,
            tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
            structured: { source: "codex", usageAvailable: false, timingSource: "turn" },
          },
          parts: [
            {
              partId: `${entityId}:part`,
              messageId: entityId,
              sessionId: thread.id,
              type: "text",
              text: item.text as string,
            },
          ],
        });
      }
    }
  }
  return messages;
}

/** Read-only legacy compatibility view, NOT a lossless import or execution configuration.
 * The frozen legacy schema requires mode/cost/tokens and tool timestamps absent in Thread.
 * "build" is its display fallback, zero metrics mean unobserved, and timing is explicitly
 * marked turn-derived. Do not use this view to select permissions or report measured usage.
 * Use V4 plus request-owned interactions for live approvals and epoch/sequence delivery.
 */
export function projectLegacySnapshot(
  thread: unknown,
  workspacePath: string,
): CodezSessionStateSnapshot {
  const source = codexThreadSchema.parse(thread);
  const rows = projectRows(source);
  const last = source.turns.at(-1);
  const activeTurn = source.turns.findLast((turn) => turn.status === "inProgress");
  const running = source.status.type === "active" || activeTurn !== undefined;
  const status: CodezSessionInfo["status"] =
    source.status.type === "systemError"
      ? "error"
      : running
        ? source.status.type === "active" && source.status.activeFlags.length > 0
          ? "waiting"
          : "running"
        : last?.status === "failed"
          ? "error"
          : last?.status === "interrupted"
            ? "paused"
            : last
              ? "completed"
              : "idle";
  const selection =
    source.model?.trim() && source.modelProvider.trim()
      ? {
          providerId: source.modelProvider,
          modelId: source.model,
          ...(source.reasoningEffort
            ? { options: { reasoningLevel: source.reasoningEffort } }
            : {}),
        }
      : undefined;
  const parentSessionId = source.forkedFromId ?? source.parentThreadId;
  return codezSessionStateSnapshotSchema.parse({
    protocol: { name: "Codez Protocol", version: 1 },
    session: {
      sessionId: source.id,
      workspace: { workspacePath, workspaceKey: workspacePath },
      ...(parentSessionId ? { parentSessionId } : {}),
      // 辅助对话 child 的身份以持久化 threadSource 为准（spec: codex-selection-side-chat）；
      // session/list 已把它过滤掉，这里命中只发生在按 id 直读（含 task-index 修复）。
      sessionKind: isSelectionSideChatThread(source)
        ? "selection_side_chat"
        : source.parentThreadId
          ? "subagent_child"
          : source.forkedFromId
            ? "fork"
            : "interactive",
      title: nativeThreadTitle(source),
      mode: "build",
      status,
      ...(selection ? { model: selection } : {}),
      createdAt: source.createdAt * 1000,
      updatedAt: source.updatedAt * 1000,
    },
    settings: {
      model: { available: [], ...(selection ? { current: selection } : {}) },
      thoughtLevel: {
        enabled: Boolean(source.reasoningEffort),
        available: [],
        ...(source.reasoningEffort ? { current: source.reasoningEffort } : {}),
      },
      mode: { current: "build" },
    },
    projection: {
      sessionId: source.id,
      status,
      mode: "build",
      turnCount: source.turns.length,
      totalTokenCount: 0,
      contextUsed: 0,
      contextWindow: 0,
      ...(activeTurn ? { currentTurnId: activeTurn.id } : {}),
      pendingPermissions: [],
      activeToolCalls: rows
        .filter(
          (row): row is ToolCallRow =>
            row.kind === "toolCall" &&
            (row.status === "running" ||
              row.status === "pendingApproval" ||
              row.status === "inputStreaming"),
        )
        .map((row) => ({
          toolCallId: row.toolCallId,
          toolName: row.toolName,
          status: row.status === "running" ? "running" : "pending",
        })),
      backgroundJobs: [],
      ...(last?.error?.message
        ? { lastError: { type: "codex", code: "codex.turn.failed", message: last.error.message } }
        : {}),
    },
    runtime: {
      eventSeq: 0,
      stateRevision: 0,
      pendingRequestIds: [],
      ...(activeTurn ? { activeTurnId: activeTurn.id, activeTurnKind: "regular" } : {}),
    },
    messages: messages(source, rows, workspacePath),
  });
}

/** 直接从 native Thread 构造 task-index shared reducer 所需的最小语义输入。 */
export function projectLegacySessionIndexInput(
  thread: unknown,
  workspacePath: string,
): CodezSessionIndexSemanticInput {
  const source = codexThreadSchema.parse(thread);
  const last = source.turns.at(-1);
  const activeTurn = source.turns.findLast((turn) => turn.status === "inProgress");
  const running = source.status.type === "active" || activeTurn !== undefined;
  const status =
    source.status.type === "systemError"
      ? "error"
      : running
        ? source.status.type === "active" && source.status.activeFlags.length > 0
          ? "waiting"
          : "running"
        : last?.status === "failed"
          ? "error"
          : last?.status === "interrupted"
            ? "paused"
            : last
              ? "completed"
              : "idle";
  const selection =
    source.model?.trim() && source.modelProvider.trim()
      ? {
          providerId: source.modelProvider,
          modelId: source.model,
          ...(source.reasoningEffort
            ? { options: { reasoningLevel: source.reasoningEffort } }
            : {}),
        }
      : undefined;
  const parentSessionId = source.forkedFromId ?? source.parentThreadId;
  return {
    session: {
      sessionId: source.id,
      workspace: { workspacePath, workspaceKey: workspacePath },
      ...(parentSessionId ? { parentSessionId } : {}),
      sessionKind: isSelectionSideChatThread(source)
        ? "selection_side_chat"
        : source.parentThreadId
          ? "subagent_child"
          : source.forkedFromId
            ? "fork"
            : "interactive",
      title: nativeThreadTitle(source),
      mode: "build",
      status,
      ...(selection ? { model: selection } : {}),
      createdAt: source.createdAt * 1000,
      updatedAt: source.updatedAt * 1000,
    },
    settings: {
      model: { available: [], ...(selection ? { current: selection } : {}) },
      thoughtLevel: {
        enabled: Boolean(source.reasoningEffort),
        available: [],
        ...(source.reasoningEffort ? { current: source.reasoningEffort } : {}),
      },
      mode: { current: "build" },
    },
    projection: {
      sessionId: source.id,
      status,
      mode: "build",
      turnCount: source.turns.length,
      totalTokenCount: 0,
      contextUsed: 0,
      contextWindow: 0,
      ...(activeTurn ? { currentTurnId: activeTurn.id } : {}),
      pendingPermissions: [],
      activeToolCalls: [],
      backgroundJobs: [],
      ...(last?.error?.message
        ? { lastError: { type: "codex", code: "codex.turn.failed", message: last.error.message } }
        : {}),
    },
    messages: lightIndexMessages(source, workspacePath),
  };
}
