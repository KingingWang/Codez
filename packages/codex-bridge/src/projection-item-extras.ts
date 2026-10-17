import { type ConversationRow, type TimelineMarkerRow } from "@codez/shared/codez-protocol-v4";
import { type CodexKnownItem } from "./codex-types.js";
import { projectToolInput, projectToolOutput } from "./projection-bounds.js";

/** 行公共字段：与 projection-rows 的 projectRows 构造保持一致。 */
export type RowBase = Pick<
  ConversationRow,
  "rowId" | "entityId" | "turnId" | "productTurnId" | "createdAt" | "createdAtSeq" | "visibility"
>;

type CodexItemOf<T extends CodexKnownItem["type"]> = Extract<CodexKnownItem, { type: T }>;

type CollabTool = CodexItemOf<"collabAgentToolCall">["tool"];
type SubAgentActivityKind = CodexItemOf<"subAgentActivity">["kind"];
type CodexEventName = Extract<TimelineMarkerRow["marker"], { type: "codexEvent" }>["event"];

/** 多代理工具名映射：v2 五个真实工具用原名（spawn_agent 命中 UI agent family 卡片）；
 * v1 的四个 analytics-only 工具（官方 TUI 同样不展示为工具卡）加 codex_collab_ 前缀，
 * 避免 sendMessage 等撞上原生 SendMessage 渲染器造成误读。 */
const COLLAB_TOOL_NAMES: Record<CollabTool, string> = {
  spawnAgent: "spawn_agent",
  sendInput: "send_input",
  resumeAgent: "resume_agent",
  wait: "wait_agent",
  closeAgent: "close_agent",
  sendMessage: "codex_collab_send_message",
  followupTask: "codex_collab_followup_task",
  interruptAgent: "codex_collab_interrupt_agent",
  listAgents: "codex_collab_list_agents",
};

const SUBAGENT_ACTIVITY_EVENTS: Record<SubAgentActivityKind, CodexEventName> = {
  started: "subagentStarted",
  interacted: "subagentInteracted",
  interrupted: "subagentInterrupted",
  completed: "subagentCompleted",
};

const MARKER_DETAIL_MAX_CHARS = 500;

function capMarkerDetail(detail: string): string {
  return detail.length <= MARKER_DETAIL_MAX_CHARS
    ? detail
    : `${detail.slice(0, MARKER_DETAIL_MAX_CHARS)}…`;
}

/** codex 生命周期/事件 item → 时间线分隔标记。lane 恒 assistantWork（助理工作活动）。 */
export function codexEventMarker(
  base: RowBase,
  event: CodexEventName,
  detail?: string,
  status?: "running" | "completed",
): ConversationRow {
  return {
    ...base,
    kind: "timelineMarker",
    lane: "assistantWork",
    marker: {
      type: "codexEvent",
      event,
      ...(status ? { status } : {}),
      ...(detail && detail.trim().length > 0 ? { detail: capMarkerDetail(detail) } : {}),
    },
  };
}

/** toolCall status 映射：item 自带状态的工具（collab/dynamic）共用。 */
function projectItemStatus(status: "inProgress" | "completed" | "failed" | "interrupted") {
  switch (status) {
    case "completed":
      return "success" as const;
    case "failed":
      return "error" as const;
    case "interrupted":
      return "cancelled" as const;
    default:
      return "running" as const;
  }
}

/** content items → 展示文本：只留文本，image/audio 降成占位符（媒体字节绝不进 row）。 */
function contentItemsText(items: readonly unknown[]): string {
  return items
    .map((content) => {
      if (typeof content !== "object" || content === null) return null;
      const record = content as { type?: unknown; text?: unknown };
      if (record.type === "inputText" && typeof record.text === "string") return record.text;
      if (record.type === "inputImage") return "[image]";
      if (record.type === "inputAudio") return "[audio]";
      return null;
    })
    .filter((line): line is string => typeof line === "string" && line.length > 0)
    .join("\n");
}

function imageGenerationFailureMessage(failure: unknown, status: string): string {
  if (typeof failure === "object" && failure !== null) {
    const type = (failure as { type?: unknown }).type;
    if (typeof type === "string" && type.length > 0) return `Image generation failed: ${type}`;
  }
  return status.trim().length > 0
    ? `Image generation failed: ${status}`
    : "Image generation failed";
}

/** view_image 工具卡片（specs/codex-desktop-image-view.md）：
 * core 只在图片成功附加后产生 imageView item（失败走工具错误、无 item），
 * 所以状态恒为 success，不从 turn 派生。toolName 用原生工具名 view_image，
 * UI identity 的 /^(?:read|view|...)(?:_|$)/i 会把它归入 file-read family，
 * 复用 Read 文件卡片——文件名可点击，预览面板渲染图片内容。 */
export function imageViewRow(item: CodexItemOf<"imageView">, base: RowBase): ConversationRow {
  return {
    ...base,
    kind: "toolCall",
    toolCallId: item.id,
    toolName: "view_image",
    status: "success",
    ...projectToolInput({ path: item.path }),
  };
}

/** web_search 工具卡：item 只在搜索发生后产生（无 status 字段），恒 success。
 * input.query 命中 UI search family 的 query 词表，渲染「搜索：query」。 */
export function webSearchRow(item: CodexItemOf<"webSearch">, base: RowBase): ConversationRow {
  return {
    ...base,
    kind: "toolCall",
    toolCallId: item.id,
    toolName: "web_search",
    status: "success",
    ...projectToolInput({ query: item.query }),
  };
}

/** 生图工具卡。result 是 base64 图片本体，绝不进 row（行预算）；
 * 展示只保留 revisedPrompt/savedPath 与状态。 */
export function imageGenerationRow(
  item: CodexItemOf<"imageGeneration">,
  base: RowBase,
): ConversationRow {
  const status =
    item.status === "completed"
      ? ("success" as const)
      : item.status === "failed"
        ? ("error" as const)
        : ("running" as const);
  return {
    ...base,
    kind: "toolCall",
    toolCallId: item.id,
    toolName: "image_generation",
    status,
    ...projectToolInput({
      ...(item.revisedPrompt ? { revisedPrompt: item.revisedPrompt } : {}),
      ...(item.savedPath ? { savedPath: item.savedPath } : {}),
    }),
    ...(status === "error"
      ? {
          error: {
            code: "codex.imageGeneration.failed",
            message: imageGenerationFailureMessage(item.failure, item.status),
          },
        }
      : {}),
  };
}

/** 多代理协作工具卡：prompt/thread ids 进 input，agentsStates 渲染成逐代理状态行。 */
export function collabAgentToolCallRow(
  item: CodexItemOf<"collabAgentToolCall">,
  base: RowBase,
): ConversationRow {
  const input: Record<string, unknown> = {
    ...(item.prompt ? { prompt: item.prompt } : {}),
    senderThreadId: item.senderThreadId,
    ...(item.receiverThreadIds.length > 0 ? { receiverThreadIds: item.receiverThreadIds } : {}),
    ...(item.model ? { model: item.model } : {}),
    ...(item.reasoningEffort ? { reasoningEffort: item.reasoningEffort } : {}),
  };
  const stateLines = Object.entries(item.agentsStates).map(
    ([threadId, state]) =>
      `${threadId}: ${state.status}${state.message ? ` — ${state.message}` : ""}`,
  );
  return {
    ...base,
    kind: "toolCall",
    toolCallId: item.id,
    toolName: COLLAB_TOOL_NAMES[item.tool],
    status: projectItemStatus(item.status),
    ...projectToolInput(input),
    ...(stateLines.length > 0 ? { output: projectToolOutput(stateLines.join("\n")) } : {}),
  };
}

/** 客户端注册的 dynamic tool。bridge 不应答 DynamicToolCall 请求（工具实际不可执行），
 * 这里只做历史/通知的忠实投影；media content 降成占位符。 */
export function dynamicToolCallRow(
  item: CodexItemOf<"dynamicToolCall">,
  base: RowBase,
): ConversationRow {
  const toolName = item.namespace ? `${item.namespace}.${item.tool}` : item.tool;
  const status = projectItemStatus(item.status);
  const outputText = contentItemsText(item.contentItems ?? []);
  return {
    ...base,
    kind: "toolCall",
    toolCallId: item.id,
    toolName,
    status,
    ...projectToolInput(item.arguments ?? {}),
    ...(outputText ? { output: projectToolOutput(outputText) } : {}),
    ...(status === "error"
      ? {
          error: {
            code: "codex.dynamicToolCall.failed",
            message: `Dynamic tool ${toolName} failed`,
          },
        }
      : {}),
  };
}

/** hook 拦截合成的工具输出（无对应 call item，官方 TUI 也不单独展示）。
 * 投影成只有输出的最小工具卡，保持可见且诚实；media 降成占位符。 */
export function functionCallOutputRow(
  item: CodexItemOf<"functionCallOutput">,
  base: RowBase,
): ConversationRow {
  const outputText = typeof item.output === "string" ? item.output : contentItemsText(item.output);
  return {
    ...base,
    kind: "toolCall",
    toolCallId: item.id,
    toolName: item.name,
    status: "success",
    inputText: "",
    ...(outputText ? { output: projectToolOutput(outputText) } : {}),
  };
}

/** 子代理活动事件标记：kind → codexEvent，detail 携带 agentPath。 */
export function subAgentActivityMarker(
  item: CodexItemOf<"subAgentActivity">,
  base: RowBase,
): ConversationRow {
  return codexEventMarker(base, SUBAGENT_ACTIVITY_EVENTS[item.kind], item.agentPath);
}

/** 原生 contextCompaction 标记：在途 turn 中未完成时标记 running。 */
export function contextCompactionMarker(
  item: CodexItemOf<"contextCompaction">,
  turnStatus: string,
  base: RowBase,
): ConversationRow {
  return codexEventMarker(
    base,
    "contextCompaction",
    undefined,
    item.status === "inProgress" && turnStatus === "inProgress" ? "running" : undefined,
  );
}

/** 识别中断轮无气泡继续的隐藏 contextual user fragment。 */
export function isHiddenContinuationUserMessage(item: {
  type?: unknown;
  content?: unknown;
}): boolean {
  if (item.type !== "userMessage" || !Array.isArray(item.content)) return false;
  if (item.content.length !== 1) return false;
  const first = item.content[0];
  if (!first || typeof first !== "object") return false;
  const record = first as { type?: unknown; text?: unknown };
  if (record.type !== "text" || typeof record.text !== "string") return false;
  const trimmed = record.text.trim();
  return (
    trimmed.startsWith('<codex_internal_context source="continue">') &&
    trimmed.endsWith("</codex_internal_context>")
  );
}
