import {
  conversationRowSchema,
  type ConversationRow,
  type PendingInteraction,
  type ToolCallRow,
} from "@zcode/shared/zcode-protocol-v4";
import {
  isCodexKnownItem,
  type CodexKnownItem,
  type CodexThread,
  type CodexThreadItem,
  type CodexTurn,
  type CodexUserInput,
} from "./codex-types.js";
import { assertRowBudget, projectToolInput, projectToolOutput } from "./projection-bounds.js";

/** Explicit textual fallbacks: no fake attachment refs, byte counts or MIME facts. */
export function projectInputText(input: readonly CodexUserInput[]): string {
  return input
    .map((part) => {
      switch (part.type) {
        case "text":
          return part.text;
        case "image":
        case "localImage":
          // 原生 image 可能包含整张图片的 data URL；仅显示标记，避免撑爆行预算或泄漏 sidecar 路径。
          // 可访问的 attachment refs 由 bridge 恢复，纯投影不伪造也不暴露媒体定位符。
          return "[image]";
        case "audio":
          return `[audio: ${part.url}]`;
        case "localAudio":
          return `[local audio: ${part.path}]`;
        case "skill":
          return `[skill: ${part.name} (${part.path})]`;
        case "mention":
          return `[mention: ${part.name} (${part.path})]`;
      }
    })
    .join("\n");
}

/** 展示 ID 编码原生 (turnId, itemId)，避免原生按 turn 复用 itemId 时发生碰撞。 */
export function itemEntityId(turnId: string, itemId: string): string {
  return `codex:turn:${encodeURIComponent(turnId)}:item:${encodeURIComponent(itemId)}`;
}

type RowBase = Pick<
  ConversationRow,
  "rowId" | "entityId" | "turnId" | "productTurnId" | "createdAt" | "createdAtSeq" | "visibility"
>;
type ToolItem = Extract<
  CodexKnownItem,
  { type: "commandExecution" | "fileChange" | "mcpToolCall" }
>;

function toolRow(
  item: ToolItem,
  base: RowBase,
  turn: CodexTurn,
  interactions: readonly PendingInteraction[],
): ToolCallRow {
  const approval = interactions.find(
    (interaction) =>
      interaction.payload.kind === "permission" &&
      interaction.payload.toolCallId === item.id &&
      (interaction.turnId === undefined || interaction.turnId === turn.id),
  );
  let status: ToolCallRow["status"];
  if (item.status === "completed") status = "success";
  else if (item.status === "failed") status = "error";
  else if (item.status === "declined" || turn.status === "interrupted") status = "cancelled";
  else if (turn.status === "failed") status = "error";
  else status = approval ? "pendingApproval" : "running";
  const common: ToolCallRow = {
    ...base,
    kind: "toolCall",
    toolCallId: item.id,
    toolName: item.type,
    status,
    inputText: "",
  };
  if (status === "pendingApproval") common.approvalInteractionId = approval?.interactionId;
  if (status === "error")
    common.error = {
      code: `codex.${item.type}.failed`,
      message:
        item.type === "mcpToolCall" && item.error
          ? item.error.message
          : (turn.error?.message ?? `Codex ${item.type} failed`),
    };
  if (item.type === "commandExecution") {
    common.toolName = "Bash";
    Object.assign(common, projectToolInput({ command: item.command, cwd: item.cwd }));
    if (item.aggregatedOutput != null) common.output = projectToolOutput(item.aggregatedOutput);
    if (item.exitCode != null && item.exitCode !== 0 && status === "success") {
      common.status = "error";
      common.error = {
        code: "codex.command.exit",
        message: `Command exited with code ${item.exitCode}`,
      };
    }
  } else if (item.type === "fileChange") {
    common.toolName = "ApplyPatch";
    Object.assign(common, projectToolInput({ changes: item.changes }));
    common.output = projectToolOutput(
      item.changes.map((change) => `${change.path}\n${change.diff}`).join("\n"),
    );
  } else {
    common.toolName = `mcp__${item.server}__${item.tool}`;
    Object.assign(common, projectToolInput(item.arguments));
    if (item.server.length <= 256 && item.tool.length <= 256)
      common.display = {
        kind: "mcp_tool",
        serverName: item.server,
        toolName: item.tool,
      };
    if (item.result != null) common.output = projectToolOutput(JSON.stringify(item.result));
  }
  // Codex does not supply tool start/end timestamps. Turn timestamps are not tool telemetry.
  return common;
}

function itemRow(
  item: CodexThreadItem,
  turn: CodexTurn,
  base: RowBase,
  interactions: readonly PendingInteraction[],
): ConversationRow {
  if (!isCodexKnownItem(item)) {
    const approval = interactions.find(
      (interaction) =>
        interaction.payload.kind === "permission" &&
        interaction.payload.toolCallId === item.id &&
        (interaction.turnId === undefined || interaction.turnId === turn.id),
    );
    const nativeStatus = typeof item.status === "string" ? item.status : undefined;
    const status =
      nativeStatus === "failed" || nativeStatus === "error"
        ? "error"
        : nativeStatus === "declined" || nativeStatus === "cancelled"
          ? "cancelled"
          : nativeStatus === "completed"
            ? "success"
            : turn.status === "failed"
              ? "error"
              : turn.status === "interrupted"
                ? "cancelled"
                : turn.status === "completed"
                  ? "success"
                  : approval
                    ? "pendingApproval"
                    : "running";
    return {
      ...base,
      kind: "toolCall",
      toolCallId: item.id,
      toolName: `codex.${item.type}`,
      status,
      ...projectToolInput(item),
      output: projectToolOutput(
        `Codex ${item.type} (generic presentation; status may be turn-derived)\n${JSON.stringify(item)}`,
      ),
      ...(status === "pendingApproval" ? { approvalInteractionId: approval?.interactionId } : {}),
      ...(status === "error"
        ? { error: { code: "codex.item.failed", message: `Codex ${item.type} failed` } }
        : {}),
    };
  }
  switch (item.type) {
    case "userMessage":
      return {
        ...base,
        kind: "userInput",
        text: projectInputText(item.content),
        origin: "realUser",
        // Codex 将 turn/start.clientUserMessageId 持久化成 item.clientId；它不是提交端 clientId。
        ...(item.clientId ? { sourceCommandId: item.clientId } : {}),
      };
    case "agentMessage":
    case "plan":
      return {
        ...base,
        kind: "assistantText",
        text: item.text,
        state:
          turn.status === "inProgress"
            ? "streaming"
            : turn.status === "completed"
              ? "complete"
              : turn.status === "failed"
                ? "failed"
                : "interrupted",
      };
    case "reasoning":
      return {
        ...base,
        kind: "reasoning",
        text: [...item.summary, ...item.content].join("\n\n"),
        state:
          turn.status === "inProgress"
            ? "streaming"
            : turn.status === "completed"
              ? "complete"
              : "interrupted",
      };
    default:
      return toolRow(item, base, turn, interactions);
  }
}

/** Whole-history ordinals, not deltas. Insert/remove/reorder requires a new caller-owned epoch.
 * createdAtSeq=0 means hydrated before the live stream, never an invented event sequence.
 * Missing item/turn timestamps fall back to thread.createdAt for display only.
 */
export function projectRows(
  thread: CodexThread,
  interactions: readonly PendingInteraction[] = [],
): ConversationRow[] {
  const rows: ConversationRow[] = [];
  const turnIds = new Set<string>();
  for (const turn of thread.turns) {
    if (turn.itemsView !== "full")
      throw new Error("Codex conversation projection requires full turn items");
    if (turnIds.has(turn.id)) throw new Error(`Duplicate Codex turn ID: ${turn.id}`);
    turnIds.add(turn.id);
    const createdAt = (turn.startedAt ?? thread.createdAt) * 1000;
    const base = {
      turnId: turn.id,
      productTurnId: turn.id,
      createdAt,
      createdAtSeq: 0,
      visibility: "visible" as const,
    };
    const source = turn.items.filter(isCodexKnownItem).find((item) => item.type === "userMessage");
    const entityIds = new Set<string>();
    rows.push(
      assertRowBudget(
        conversationRowSchema.parse({
          ...base,
          rowId: rows.length,
          entityId: `codex:turn:${encodeURIComponent(turn.id)}`,
          kind: "turnHeader",
          origin: "userInput",
          executionKind: "agent",
          startedAt: createdAt,
          ...(turn.completedAt != null ? { endedAt: turn.completedAt * 1000 } : {}),
          ...(source?.type === "userMessage" && source.clientId
            ? { sourceCommandId: source.clientId }
            : {}),
          state:
            turn.status === "inProgress"
              ? "running"
              : turn.status === "completed"
                ? "completedSuccess"
                : turn.status === "interrupted"
                  ? "completedInterrupted"
                  : "failed",
        }),
      ),
    );
    for (const item of turn.items) {
      if (entityIds.has(item.id)) {
        // 原生协议按 turn 限定 itemId；同一 turn 内重复仍表示损坏历史，必须失败。
        throw new Error(`Duplicate Codex item ID in turn ${turn.id}: ${item.id}`);
      }
      entityIds.add(item.id);
      rows.push(
        assertRowBudget(
          conversationRowSchema.parse(
            itemRow(
              item,
              turn,
              {
                ...base,
                rowId: rows.length,
                entityId: itemEntityId(turn.id, item.id),
              },
              interactions,
            ),
          ),
        ),
      );
    }
  }
  return rows;
}
