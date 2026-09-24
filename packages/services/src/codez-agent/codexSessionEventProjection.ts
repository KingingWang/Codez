// Codex 模式下 Bot/Host mirror 的 legacy 流式事件源（spec: specs/codex-bot-stream-projection.md）。
//
// 背景：Codex bridge 刻意不实现 legacy `session/subscribe` + `session/event`，只发 v4
// `conversationFrame` 通知，且只发全量 snapshot 帧（每次变更整帧重编码）。桌面 UI 走 v4
// 帧通道不受影响；但 Bot 回复链路（botsService.watchTaskStream）消费的是 legacy
// CodezStreamEvent，上游在 codex 模式下完全没有事件源，表现为「会话里有回复、机器人侧
// 什么都看不到」（2026-09-24 飞书实测，日志：`Codex adapter does not support session/subscribe`）。
//
// 本模块是唯一「v4 conversation 帧 → legacy CodezSessionEvent」翻译所有者：bridge 当前只发
// 全量 snapshot 帧；协议允许的 deltas 帧经共享 applyConversationDeltas 物化后走同一差分。
// 差分合成 turn.started / model.streaming / tool.updated / turn.completed / turn.failed，
// 下游 adapter 的 mapServiceEvent / mapSessionEvent 零改动复用。
import { codezSessionEventSchema, type CodezSessionEvent } from "@codez/shared";
import {
  applyConversationDeltas,
  type AssistantTextRow,
  type ConversationRow,
  type ConversationSnapshot,
  type ConversationTopicFrame,
  type ReasoningRow,
  type SessionPhase,
  type ToolCallRow,
} from "@codez/shared/codez-protocol-v4";

// 已关闭回合身份的保留上界：超出后最旧的被遗忘。同一回合身份不会再次出现
// （rowId/turnId 单调不复用），有界集合足以防重复收口。
const CLOSED_TURN_TRACK_LIMIT = 32;

interface ToolRowState {
  scheduled: boolean;
  terminal: boolean;
  status: ToolCallRow["status"];
}

interface ActiveTurn {
  turnId: string;
  startedAtMs: number;
}

export interface CodexSessionEventProjection {
  acceptFrame(frame: ConversationTopicFrame): CodezSessionEvent[];
  dispose(): void;
}

function isTerminalPhase(phase: SessionPhase): boolean {
  return phase === "completedSuccess" || phase === "completedInterrupted" || phase === "error";
}

function isTerminalToolStatus(status: ToolCallRow["status"]): boolean {
  return status === "success" || status === "error" || status === "cancelled";
}

function parseToolInput(row: ToolCallRow): unknown {
  if (row.input !== undefined) return row.input;
  const text = row.inputText.trim();
  if (!text) return {};
  try {
    return JSON.parse(text) as unknown;
  } catch {
    // 工具 input 不一定是 JSON（如 Bash 命令字符串）；按原始字符串透出。
    return text;
  }
}

/**
 * 每个（workspace, sessionId）一个实例，由 codezAgentService 的 codex 分支持有。
 * 纯函数式：无 IO、无定时器，快照进、事件数组出，可独立单测。
 */
export function createCodexSessionEventProjection(params: {
  sessionId: string;
}): CodexSessionEventProjection {
  let seq = 0;
  let turnNumber = 0;
  // seeded = 首帧快照已登记基线。首帧只「追到 live 边缘」：历史行不补事件，
  // state=streaming 的行发射一次当前累积文本作为流式起点。
  let seeded = false;
  // deltas 帧的物化基线；snapshot 帧直接替换。差分状态（已发射文本/工具状态）
  // 与物化快照正交，两者不互相推导。
  let materialized: ConversationSnapshot | null = null;
  let activeTurn: ActiveTurn | null = null;
  let lastPhase: SessionPhase | null = null;
  // 首帧快照处理期间的回合启动白名单：只有「正在运行」的回合才允许补 turn.started；
  // 历史回合（turnHeader 已终态）在首帧只登记，不向 Bot 回放。null = 非首帧。
  let startableTurnIds: Set<string> | null = null;
  const closedTurnIds = new Set<string>();
  const closedTurnOrder: string[] = [];
  // rowId → 已发射的文本长度（assistantText/reasoning）。
  const emittedTextByRowId = new Map<number, number>();
  const toolStateByRowId = new Map<number, ToolRowState>();

  const markTurnClosed = (turnId: string): void => {
    if (closedTurnIds.has(turnId)) return;
    closedTurnIds.add(turnId);
    closedTurnOrder.push(turnId);
    if (closedTurnOrder.length > CLOSED_TURN_TRACK_LIMIT) {
      const oldest = closedTurnOrder.shift();
      if (oldest !== undefined) closedTurnIds.delete(oldest);
    }
  };

  const buildEnvelope = (
    events: CodezSessionEvent[],
    type: CodezSessionEvent["type"],
    turnId: string | undefined,
    payload: Record<string, unknown>,
  ): void => {
    seq += 1;
    // 合成事件也过协议 schema：strict 校验保证下游 mapSessionEvent 读到的形状与
    // 真 legacy 事件完全一致；形状错误在投影边界抛错，而不是悄悄污染 Bot 回复链。
    events.push(
      codezSessionEventSchema.parse({
        eventId: `codex-v4-${seq}`,
        sessionId: params.sessionId,
        ...(turnId ? { turnId } : {}),
        seq,
        // 回合内 traceId 稳定：adapter mapSessionEvent 的 turnKey/streamedTurnKeys
        // 依赖同一回合的 chunk 与 complete 落在同一 key 上。
        ...(turnId ? { traceId: `codex-turn-${turnId}` } : {}),
        timestamp: Date.now(),
        type,
        payload,
      }),
    );
  };

  const collectTurnResponse = (rows: readonly ConversationRow[], turnId: string): string =>
    rows
      .filter(
        (row): row is AssistantTextRow => row.kind === "assistantText" && row.turnId === turnId,
      )
      .map((row) => row.text)
      // 与流式 chunk 拼接语义一致（chunk 路径行间无分隔符），避免两条路径正文分叉。
      .join("");

  const countTurnToolCalls = (rows: readonly ConversationRow[], turnId: string): number =>
    rows.filter((row) => row.kind === "toolCall" && row.turnId === turnId).length;

  const closeTurn = (
    events: CodezSessionEvent[],
    rows: readonly ConversationRow[],
    turnId: string,
    state: "completedSuccess" | "completedInterrupted" | "failed",
    snapshot: ConversationSnapshot,
  ): void => {
    if (closedTurnIds.has(turnId)) return;
    if (!activeTurn || activeTurn.turnId !== turnId) {
      // 未见开始的回合（首帧基线里的历史回合）只登记，不补终态事件。
      markTurnClosed(turnId);
      return;
    }
    if (state === "failed") {
      const lastError = snapshot.control.lastError;
      buildEnvelope(events, "turn.failed", turnId, {
        error: {
          type: lastError?.code?.trim() || "codex_turn_failed",
          message: lastError?.message?.trim() || "Codex turn failed",
          ...(lastError?.code ? { code: lastError.code } : {}),
          ...(lastError?.detail ? { detail: lastError.detail } : {}),
        },
        turnPhase: "primaryTurn",
      });
    } else {
      buildEnvelope(events, "turn.completed", turnId, {
        // adapter 在 chunk 已流式送达（streamedTurnKeys）时会抑制 response 回投；
        // 未流式（订阅迟到）时这份全量正文保证 Bot 仍能给出最终回复。
        response: collectTurnResponse(rows, turnId),
        tokenCount: 0,
        toolCallCount: countTurnToolCalls(rows, turnId),
        duration: Math.max(0, Date.now() - activeTurn.startedAtMs),
        resultType: state === "completedSuccess" ? "success" : "cancelled",
      });
    }
    activeTurn = null;
    markTurnClosed(turnId);
  };

  const maybeStartTurn = (events: CodezSessionEvent[], turnId: string, input: string): void => {
    if (activeTurn?.turnId === turnId || closedTurnIds.has(turnId)) return;
    if (startableTurnIds !== null && !startableTurnIds.has(turnId)) return;
    if (activeTurn) {
      // codex 回合串行；看到新回合而旧回合未收口 = 旧回合的终态帧滑出了窗口。
      // 必须补一个终态，否则 Bot 的 typing/流式卡片永远悬挂。
      closeTurnWithSyntheticRows(events, activeTurn.turnId);
    }
    activeTurn = { turnId, startedAtMs: Date.now() };
    turnNumber += 1;
    buildEnvelope(events, "turn.started", turnId, {
      turnNumber,
      input,
    });
  };

  // closeTurn 需要当前窗口 rows 以拼接 response；跨回合兜底收口时窗口可能已不含旧回合行。
  const closeTurnWithSyntheticRows = (events: CodezSessionEvent[], turnId: string): void => {
    if (!activeTurn || activeTurn.turnId !== turnId) return;
    buildEnvelope(events, "turn.completed", turnId, {
      response: "",
      tokenCount: 0,
      toolCallCount: 0,
      duration: Math.max(0, Date.now() - activeTurn.startedAtMs),
      resultType: "cancelled",
    });
    activeTurn = null;
    markTurnClosed(turnId);
  };

  const acceptTextRow = (
    events: CodezSessionEvent[],
    row: AssistantTextRow | ReasoningRow,
    firstSnapshot: boolean,
  ): void => {
    const previous = emittedTextByRowId.get(row.rowId);
    if (previous === undefined) {
      if (firstSnapshot && row.state !== "streaming") {
        // 首帧基线：历史行只登记不补事件，避免把整个会话历史当成新回复推给 Bot。
        emittedTextByRowId.set(row.rowId, row.text.length);
        return;
      }
      // 订阅中途出现的新行（含「出现即完成」的快行）：全量文本作为一个 chunk 发射。
      if (row.text) {
        maybeStartTurn(events, row.turnId, "");
        buildEnvelope(
          events,
          "model.streaming",
          row.turnId,
          row.kind === "assistantText"
            ? {
                kind: "text_delta",
                delta: row.text,
                ...(row.entityId ? { assistantMessageId: row.entityId } : {}),
              }
            : { kind: "reasoning_delta", delta: row.text },
        );
      }
      emittedTextByRowId.set(row.rowId, row.text.length);
      return;
    }
    if (row.text.length > previous) {
      maybeStartTurn(events, row.turnId, "");
      buildEnvelope(
        events,
        "model.streaming",
        row.turnId,
        row.kind === "assistantText"
          ? {
              kind: "text_delta",
              delta: row.text.slice(previous),
              ...(row.entityId ? { assistantMessageId: row.entityId } : {}),
            }
          : { kind: "reasoning_delta", delta: row.text.slice(previous) },
      );
      emittedTextByRowId.set(row.rowId, row.text.length);
    }
  };

  const acceptToolRow = (
    events: CodezSessionEvent[],
    row: ToolCallRow,
    firstSnapshot: boolean,
  ): void => {
    const existing = toolStateByRowId.get(row.rowId);
    if (!existing) {
      if (firstSnapshot && isTerminalToolStatus(row.status)) {
        // 首帧基线：已终态的历史工具不补事件。
        toolStateByRowId.set(row.rowId, {
          scheduled: true,
          terminal: true,
          status: row.status,
        });
        return;
      }
      // 首帧里仍在运行的工具是 live 边缘：与流式文本尾巴同理，补 scheduled + 当前
      // 状态，Bot 卡片才能跟上进行中的回合（订阅略晚于 sendPrompt 是常态）。
      maybeStartTurn(events, row.turnId, "");
      const state: ToolRowState = {
        scheduled: true,
        terminal: false,
        status: row.status,
      };
      toolStateByRowId.set(row.rowId, state);
      buildEnvelope(events, "tool.updated", row.turnId, {
        kind: "scheduled",
        toolCallId: row.toolCallId,
        toolName: row.toolName,
        input: parseToolInput(row),
        ...(row.entityId ? { assistantMessageId: row.entityId } : {}),
      });
      emitToolStatus(events, row, state);
      return;
    }
    if (existing.terminal || existing.status === row.status) return;
    existing.status = row.status;
    emitToolStatus(events, row, existing);
  };

  const emitToolStatus = (
    events: CodezSessionEvent[],
    row: ToolCallRow,
    state: ToolRowState,
  ): void => {
    if (state.terminal) return;
    if (row.status === "running") {
      // adapter mapToolUpdated 的 fallback 分支投成 in_progress（Bot 卡片展示工具运行中）。
      buildEnvelope(events, "tool.updated", row.turnId, {
        kind: "started",
        toolCallId: row.toolCallId,
        startedAt: new Date().toISOString(),
      });
      return;
    }
    if (row.status === "success") {
      state.terminal = true;
      buildEnvelope(events, "tool.updated", row.turnId, {
        kind: "result",
        toolCallId: row.toolCallId,
        result: { content: row.output?.text ?? "", success: true },
        duration:
          row.startedAt !== undefined && row.endedAt !== undefined
            ? // v4 行时间戳是秒级 epoch（projection-legacy 同样 ×1000 换算）。
              Math.max(0, Math.round((row.endedAt - row.startedAt) * 1000))
            : 0,
      });
      return;
    }
    if (row.status === "error" || row.status === "cancelled") {
      state.terminal = true;
      buildEnvelope(events, "tool.updated", row.turnId, {
        kind: "error",
        toolCallId: row.toolCallId,
        error: {
          type: row.error?.code?.trim() || "tool_error",
          message:
            row.error?.message?.trim() ||
            (row.status === "cancelled" ? "Codex tool cancelled" : "Codex tool failed"),
          ...(row.error?.code ? { code: row.error.code } : {}),
        },
      });
    }
  };

  const diffSnapshot = (snapshot: ConversationSnapshot): CodezSessionEvent[] => {
    const events: CodezSessionEvent[] = [];
    const firstSnapshot = !seeded;
    const rows = snapshot.rows.window;

    if (firstSnapshot) {
      // 首帧预扫描：终态 turnHeader 的回合直接登记为已关闭；running turnHeader
      // 的回合允许启动。没有 turnHeader 的旧快照回退为「相位运行中时最后一行的
      // 回合可启动」。之后的行遍历只在这个白名单内补 turn.started。
      const headerRows = rows.filter(
        (row): row is ConversationRow & { kind: "turnHeader" } => row.kind === "turnHeader",
      );
      const startable = new Set<string>();
      for (const header of headerRows) {
        if (header.state === "running") {
          startable.add(header.turnId);
        } else {
          markTurnClosed(header.turnId);
        }
      }
      if (headerRows.length === 0) {
        const phase = snapshot.control.phase;
        const lastRow = rows.at(-1);
        if ((phase === "running" || phase === "prewarming") && lastRow) {
          startable.add(lastRow.turnId);
        }
      }
      startableTurnIds = startable;
    }

    // 终态 turnHeader 的 rowId 属于回合开始（首行附近），而行内容更新（终态文本）
    // 挂在更高的 rowId 上；按 window 顺序就地收口会把 turn.completed 排在最后的
    // 文本 chunk 之前，Bot 会在封卡后才收到正文尾巴。终态收口一律延迟到行遍历之后。
    const pendingTurnCloses: Array<{
      turnId: string;
      state: "completedSuccess" | "completedInterrupted" | "failed";
    }> = [];

    try {
      for (const row of rows) {
        switch (row.kind) {
          case "userInput":
            maybeStartTurn(events, row.turnId, row.text);
            break;
          case "turnHeader":
            if (row.state === "running") {
              const userInput = rows.find(
                (candidate): candidate is ConversationRow & { kind: "userInput" } =>
                  candidate.kind === "userInput" && candidate.turnId === row.turnId,
              );
              maybeStartTurn(events, row.turnId, userInput?.text ?? "");
            } else if (!pendingTurnCloses.some((close) => close.turnId === row.turnId)) {
              pendingTurnCloses.push({ turnId: row.turnId, state: row.state });
            }
            break;
          case "assistantText":
          case "reasoning":
            acceptTextRow(events, row, firstSnapshot);
            break;
          case "toolCall":
            acceptToolRow(events, row, firstSnapshot);
            break;
          default:
            break;
        }
      }
    } finally {
      startableTurnIds = null;
    }

    for (const close of pendingTurnCloses) {
      closeTurn(events, rows, close.turnId, close.state, snapshot);
    }

    // control.phase 是回合终态的兜底信号：turnHeader 缺席（旧快照）时仍能收口，
    // Bot 的 typing/流式卡片不会悬挂。只在「非终态 → 终态」迁移边触发一次。
    const phase = snapshot.control.phase;
    if (
      activeTurn &&
      isTerminalPhase(phase) &&
      (lastPhase === null || !isTerminalPhase(lastPhase))
    ) {
      closeTurn(
        events,
        rows,
        activeTurn.turnId,
        phase === "completedSuccess"
          ? "completedSuccess"
          : phase === "completedInterrupted"
            ? "completedInterrupted"
            : "failed",
        snapshot,
      );
    }
    lastPhase = phase;

    // 内存上界：窗口已滑走且不属于活动回合的行状态可以丢弃
    // （文本只增不改、retry 换新 rowId，滑出窗口的行不会再产生差分）。
    const firstRowId = snapshot.rows.firstRowId;
    if (firstRowId !== null) {
      for (const rowId of emittedTextByRowId.keys()) {
        if (rowId < firstRowId) emittedTextByRowId.delete(rowId);
      }
      for (const [rowId, state] of toolStateByRowId) {
        if (rowId < firstRowId && state.terminal) toolStateByRowId.delete(rowId);
      }
    }

    seeded = true;
    return events;
  };

  return {
    acceptFrame(frame) {
      if (frame.payload.kind === "snapshot") {
        materialized = frame.payload.snapshot;
        return diffSnapshot(materialized);
      }
      // bridge 当前只发 snapshot；deltas 到达但没有基线时无法物化，丢帧好过脑补。
      if (!materialized) return [];
      materialized = applyConversationDeltas(materialized, frame.payload.deltas);
      return diffSnapshot(materialized);
    },

    dispose() {
      materialized = null;
      emittedTextByRowId.clear();
      toolStateByRowId.clear();
      closedTurnIds.clear();
      closedTurnOrder.length = 0;
      activeTurn = null;
    },
  };
}
