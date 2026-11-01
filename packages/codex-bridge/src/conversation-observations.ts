import {
  conversationTelemetryFactSchema,
  localTtftNow,
  LOCAL_TTFT_MAX_PENDING,
  LOCAL_TTFT_TTL_MS,
  type CommandAck,
  type CommandEnvelope,
  type ConversationTelemetryFact,
} from "@codez/shared/codez-protocol-v4";
import type { CodexNotification, CodexServerRequest } from "./contract.js";
import type { ThreadProjectionState } from "./thread-state-types.js";
import { emitBridgeStateDiagnostic, type BridgeStateDiagnostic } from "./diagnostics.js";
import {
  completeObservedUsage,
  nativeOutputKind,
  nativeToolName,
  OBSERVED_USAGE_KEYS,
  observationId,
  observationNumber,
  observationRecord,
  observeConversationSafely,
  type CommandObservations,
  type NativeFirstOutputDiagnostic,
  type ObservedUsage,
} from "./conversation-observation-types.js";

const MAX_PENDING_FACTS = 128;
const MAX_OUTBOUND_FACTS = 512;
const MAX_ITEM_KEYS = 128;
type FactBody = Record<string, unknown>;
interface Input {
  commandId: string;
  sessionId?: string;
  receivedAt: number;
  inputOrigin?: "desktop" | "mobile";
  observationId?: string;
  eligible: boolean;
  reported: boolean;
}
interface Tool {
  started?: number;
  completed?: boolean;
  startedSeen?: boolean;
}
interface Turn {
  sessionId: string;
  id: string;
  createdAt: number;
  completedAt?: number;
  source?: Input;
  sourceCommandId?: string;
  startSeen: boolean;
  ended: boolean;
  pending: { body: FactBody; at: number }[];
  tools: Map<string, Tool>;
  streams: Set<string>;
  usageValid: boolean;
  reportedUsage?: ObservedUsage;
  nativeTotal?: ObservedUsage;
  firstOutput?: { at: number; kind: NativeFirstOutputDiagnostic["outputKind"] };
}

/** 实时只读派生；不复制历史，不拥有 accepted queue，不在原生事件尾上等待遥测 IO。 */
export class BridgeConversationObservations implements CommandObservations {
  private readonly inputs = new Map<string, Input>();
  private readonly turns = new Map<string, Turn>();
  private readonly outbound: ConversationTelemetryFact[] = [];
  private eventSeq = 0;
  private readonly droppedCounts = new Map<"capacity" | "invalid" | "transport", number>();
  private lastDropReport = -Infinity;
  private drain?: Promise<void>;
  private closed = false;
  private readonly timer: ReturnType<typeof setInterval>;

  constructor(
    private readonly options: {
      instanceId: string;
      state(sessionId: string): ThreadProjectionState | undefined;
      notify(fact: ConversationTelemetryFact): Promise<void>;
      diagnostic?(value: BridgeStateDiagnostic): void;
      now?(): number;
    },
  ) {
    this.timer = setInterval(() => observeConversationSafely(() => this.expire()), 30_000);
    this.timer.unref();
  }

  private now(): number {
    return this.options.now?.() ?? localTtftNow();
  }
  private inputKey(command: CommandEnvelope): string {
    return `${command.sessionId ?? "create"}\0${command.commandId}`;
  }
  private key(sessionId: string, turnId: string): string {
    return `${sessionId}\0${turnId}`;
  }

  received(command: CommandEnvelope, at: number): void {
    if (this.closed || !observationId(command.commandId)) return;
    if (
      !["sendText", "createSession", "retryTurn", "editUserQuery", "sendQueuedNow"].includes(
        command.type,
      )
    )
      return;
    if (command.type === "createSession" && !observationRecord(command.payload).firstInput) return;
    this.expire();
    const input: Input = {
      commandId: command.commandId,
      ...(command.sessionId ? { sessionId: command.sessionId } : {}),
      receivedAt: at,
      inputOrigin: command.inputOrigin,
      ...(command.ttft && command.inputOrigin !== "mobile"
        ? { observationId: command.ttft.observationId }
        : {}),
      eligible: false,
      reported: false,
    };
    if (this.inputs.size >= LOCAL_TTFT_MAX_PENDING) {
      this.finishInput(input, "excluded", "capacity");
      this.dropped("capacity");
      return;
    }
    this.inputs.set(this.inputKey(command), input);
  }

  beginTurn(command: CommandEnvelope, sessionId: string, eligible: boolean): void {
    const input = this.inputs.get(this.inputKey(command));
    if (!input) return;
    input.sessionId = sessionId;
    input.eligible = eligible && ["sendText", "createSession"].includes(command.type);
    if (!input.eligible) this.finishInput(input, "excluded", "busy");
  }

  acceptTurn(command: CommandEnvelope, sessionId: string, response: unknown): void {
    const turnId = observationId(observationRecord(observationRecord(response).turn).id);
    if (!turnId || !observationId(sessionId)) return;
    const turn = this.turn(sessionId, turnId);
    if (!turn) return;
    // 归因以原生响应实际返回的 turnId 为准；不用等待时间或“最近的命令”猜测。
    this.bind(turn, command.commandId, this.inputs.get(this.inputKey(command)));
  }

  decided(command: CommandEnvelope, ack: CommandAck): void {
    const input = this.inputs.get(this.inputKey(command));
    if (!input) return;
    if (ack.status !== "accepted") {
      this.finishInput(
        input,
        ack.status === "failed" ? "failed" : "excluded",
        ack.status === "failed" ? undefined : "unsupported",
      );
      this.inputs.delete(this.inputKey(command));
    } else if (!input.eligible) {
      this.finishInput(input, "excluded", "unsupported");
    }
  }

  private turn(sessionId: string, id: string): Turn | undefined {
    const key = this.key(sessionId, id);
    const existing = this.turns.get(key);
    if (existing) return existing;
    const state = this.options.state(sessionId);
    if (!state || state.readOnly === "subagent-child" || this.closed) return undefined;
    if (this.turns.size >= LOCAL_TTFT_MAX_PENDING) {
      const settled = [...this.turns.entries()].find(([, value]) => value.ended);
      if (settled) this.turns.delete(settled[0]);
      else {
        this.dropped("capacity");
        return undefined;
      }
    }
    const turn: Turn = {
      sessionId,
      id,
      createdAt: this.now(),
      startSeen: false,
      ended: false,
      pending: [],
      tools: new Map(),
      streams: new Set(),
      usageValid: true,
    };
    this.turns.set(key, turn);
    return turn;
  }

  private bind(turn: Turn, commandId: string, input?: Input): void {
    if (!observationId(commandId) || turn.sourceCommandId) return;
    turn.sourceCommandId = commandId;
    turn.source = input;
    if (!turn.startSeen) return;
    this.flushPending(turn);
    if (turn.firstOutput) this.firstOutput(turn, turn.firstOutput.at, turn.firstOutput.kind);
  }

  observe(event: CodexNotification, receivedAt: number): void {
    if (this.closed) return;
    const params = observationRecord(event.params);
    const sessionId = observationId(params.threadId);
    if (event.method === "thread/deleted" && sessionId) {
      for (const [key, turn] of this.turns) {
        if (turn.sessionId !== sessionId) continue;
        if (turn.source) this.finishInput(turn.source, "interrupted", undefined, turn.id);
        this.turns.delete(key);
      }
      return;
    }
    const nativeTurn = observationRecord(params.turn);
    const turnId = observationId(params.turnId ?? nativeTurn.id);
    if (!sessionId || !turnId) return;
    const turn = this.turn(sessionId, turnId);
    if (!turn || turn.ended) return;
    const at = observationNumber(event.emittedAtMs) ?? receivedAt;
    if (event.method === "turn/started") {
      if (turn.startSeen) return;
      turn.startSeen = true;
      const thread = this.options.state(sessionId)?.thread ?? {};
      this.emit(
        turn,
        {
          kind: "turn.started",
          ...(typeof thread.model === "string" ? { modelName: thread.model } : {}),
          ...(typeof thread.modelProvider === "string"
            ? { modelProvider: thread.modelProvider }
            : {}),
        },
        at,
      );
      this.flushPending(turn);
      if (turn.firstOutput) this.firstOutput(turn, turn.firstOutput.at, turn.firstOutput.kind);
    } else if (event.method === "item/started" || event.method === "item/completed") {
      const item = observationRecord(params.item);
      if (item.type === "userMessage" && event.method === "item/completed") {
        const commandId = observationId(item.clientId);
        if (commandId) this.bind(turn, commandId, this.inputs.get(`${sessionId}\0${commandId}`));
      } else {
        this.tool(turn, item, params, event.method === "item/completed", at);
        this.firstOutput(turn, receivedAt, nativeOutputKind(item));
      }
    } else if (
      [
        "item/agentMessage/delta",
        "item/reasoning/summaryTextDelta",
        "item/reasoning/textDelta",
      ].includes(event.method)
    ) {
      if (typeof params.delta !== "string" || !params.delta.length) return;
      const itemId = observationId(params.itemId);
      if (!itemId) return;
      const channel = event.method === "item/agentMessage/delta" ? "text" : "thought";
      const part = params.summaryIndex ?? params.contentIndex;
      const partId =
        typeof part === "number" && Number.isSafeInteger(part) && part >= 0
          ? `${channel}-${part}`
          : undefined;
      const streamKey = `${channel}\0${itemId}\0${partId ?? ""}`;
      if (!turn.streams.has(streamKey) && turn.streams.size >= MAX_ITEM_KEYS) {
        this.dropped("capacity");
        return;
      }
      const firstChunk = !turn.streams.has(streamKey);
      turn.streams.add(streamKey);
      this.emit(
        turn,
        {
          kind: "stream.chunk",
          channel,
          chunkLength: params.delta.length,
          firstChunk,
          assistantMessageId: itemId,
          ...(partId ? { partId } : {}),
        },
        at,
      );
      this.firstOutput(turn, receivedAt, channel === "text" ? "text" : "reasoning");
    } else if (event.method === "thread/tokenUsage/updated") {
      this.usage(turn, params.tokenUsage, at);
    } else if (
      [
        "item/mcpToolCall/progress",
        "item/commandExecution/outputDelta",
        "item/fileChange/patchUpdated",
      ].includes(event.method)
    ) {
      const id = observationId(params.itemId);
      if (id) this.emit(turn, { kind: "tool.lifecycle", phase: "progress", toolCallId: id }, at);
    } else if (event.method === "turn/completed") {
      const status =
        nativeTurn.status === "completed"
          ? "success"
          : nativeTurn.status === "interrupted"
            ? "interrupted"
            : "failed";
      const durationMs = observationNumber(nativeTurn.durationMs);
      this.emit(
        turn,
        {
          kind: "turn.terminal",
          status,
          ...(durationMs !== undefined ? { durationMs } : {}),
          ...(turn.usageValid && turn.reportedUsage
            ? { tokenCount: turn.reportedUsage.totalTokens }
            : {}),
        },
        at,
      );
      turn.ended = true;
      turn.completedAt = receivedAt;
      if (turn.source)
        this.finishInput(
          turn.source,
          status === "success" ? "excluded" : status,
          status === "success" ? "unsupported" : undefined,
          turn.id,
        );
    }
  }

  private tool(
    turn: Turn,
    item: Record<string, unknown>,
    params: Record<string, unknown>,
    completed: boolean,
    at: number,
  ): void {
    const id = observationId(item.id);
    const name = nativeToolName(item);
    if (!id || !name) return;
    let tool = turn.tools.get(id);
    if (!tool) {
      if (turn.tools.size >= MAX_ITEM_KEYS) {
        this.dropped("capacity");
        return;
      }
      tool = {};
      turn.tools.set(id, tool);
    }
    if (tool.completed || (!completed && tool.startedSeen)) return;
    const started = observationNumber(params.startedAtMs);
    if (started !== undefined) tool.started = started;
    if (!completed) tool.startedSeen = true;
    else tool.completed = true;
    const ended = observationNumber(params.completedAtMs);
    const durationMs =
      observationNumber(item.durationMs) ??
      (ended !== undefined && tool.started !== undefined && ended >= tool.started
        ? ended - tool.started
        : undefined);
    const failed = item.status === "failed" || item.status === "declined";
    this.emit(
      turn,
      {
        kind: "tool.lifecycle",
        phase: completed ? (failed ? "failed" : "completed") : "started",
        toolCallId: id,
        toolName: name,
        ...(completed && durationMs !== undefined ? { durationMs } : {}),
      },
      at,
    );
  }

  private usage(turn: Turn, raw: unknown, at: number): void {
    const tokenUsage = observationRecord(raw);
    const total = completeObservedUsage(tokenUsage.total, true);
    const current = completeObservedUsage(
      this.options.state(turn.sessionId)?.turnTokenUsage?.[turn.id]?.usage,
    );
    if (
      !total ||
      !current ||
      (!turn.nativeTotal && !completeObservedUsage(tokenUsage.last, true))
    ) {
      turn.usageValid = false;
      return;
    }
    if (
      turn.nativeTotal &&
      OBSERVED_USAGE_KEYS.some((key) => total[key] < turn.nativeTotal![key])
    ) {
      turn.usageValid = false;
      return;
    }
    turn.nativeTotal = total;
    if (!turn.usageValid) return;
    const delta = Object.fromEntries(
      OBSERVED_USAGE_KEYS.map((key) => [key, current[key] - (turn.reportedUsage?.[key] ?? 0)]),
    ) as ObservedUsage;
    if (OBSERVED_USAGE_KEYS.some((key) => delta[key] < 0)) {
      turn.usageValid = false;
      return;
    }
    if (OBSERVED_USAGE_KEYS.every((key) => delta[key] === 0)) return;
    turn.reportedUsage = current;
    const thread = this.options.state(turn.sessionId)?.thread ?? {};
    this.emit(
      turn,
      {
        kind: "usage.delta",
        ...delta,
        ...(typeof thread.modelProvider === "string" ? { providerId: thread.modelProvider } : {}),
        ...(typeof thread.model === "string" ? { modelId: thread.model } : {}),
      },
      at,
    );
  }

  permission(
    request: CodexServerRequest,
    phase: "requested" | "resolved" | "denied",
    decision?: "allow" | "deny" | "modify" | "escalate",
  ): void {
    const params = observationRecord(request.params);
    const sessionId = observationId(params.threadId);
    const turnId = observationId(params.turnId);
    const itemId = observationId(params.itemId);
    if (!sessionId || !turnId || !itemId) return;
    const turn = this.turn(sessionId, turnId);
    if (!turn || turn.ended) return;
    this.emit(
      turn,
      {
        kind: "permission.lifecycle",
        phase,
        toolCallId: itemId,
        requestId: String(request.id),
        ...(decision ? { decision } : {}),
      },
      this.now(),
    );
  }

  private firstOutput(
    turn: Turn,
    at: number,
    kind: NativeFirstOutputDiagnostic["outputKind"],
  ): void {
    if (!kind) return;
    turn.firstOutput ??= { at, kind };
    if (!turn.startSeen || !turn.source?.eligible || turn.source.reported) return;
    this.finishInput(turn.source, "success", undefined, turn.id, turn.firstOutput);
  }

  private finishInput(
    input: Input,
    outcome: NativeFirstOutputDiagnostic["outcome"],
    reason?: NativeFirstOutputDiagnostic["reason"],
    turnId?: string,
    output?: Turn["firstOutput"],
  ): void {
    if (!input.observationId || input.reported) return;
    input.reported = true;
    const durationMs = (output?.at ?? this.now()) - input.receivedAt;
    const valid = observationNumber(durationMs) !== undefined;
    emitBridgeStateDiagnostic(this.options.diagnostic, {
      kind: "nativeFirstOutput",
      instanceId: this.options.instanceId,
      observationId: input.observationId,
      commandId: input.commandId,
      sessionId: input.sessionId,
      turnId,
      outcome: valid ? outcome : "excluded",
      reason: valid ? reason : "clock-invalid",
      ...(valid ? { durationMs } : {}),
      ...(output?.kind ? { outputKind: output.kind } : {}),
    });
  }

  private emit(turn: Turn, body: FactBody, at: number): void {
    if (!turn.startSeen || !turn.sourceCommandId) {
      if (turn.pending.length < MAX_PENDING_FACTS) turn.pending.push({ body, at });
      else this.dropped("capacity");
      return;
    }
    if (!Number.isSafeInteger(++this.eventSeq)) {
      this.dropped("invalid");
      return;
    }
    const parsed = conversationTelemetryFactSchema.safeParse({
      version: 1,
      eventId: `${this.options.instanceId}:${this.eventSeq}`,
      eventSeq: this.eventSeq,
      occurredAt: at,
      sessionId: turn.sessionId,
      turnId: turn.id,
      sourceCommandId: turn.sourceCommandId,
      ...body,
      ...(body.kind === "turn.started" && turn.source?.inputOrigin
        ? { inputOrigin: turn.source.inputOrigin }
        : {}),
    });
    if (!parsed.success) {
      this.dropped("invalid");
      return;
    }
    if (this.outbound.length >= MAX_OUTBOUND_FACTS) {
      this.dropped("capacity");
      return;
    }
    this.outbound.push(parsed.data);
    this.pump();
  }

  private flushPending(turn: Turn): void {
    if (!turn.startSeen || !turn.sourceCommandId) return;
    const pending = turn.pending.splice(0);
    // 原因：响应关联可能晚于通知；合法乱序不能让 stream/tool 先于 turn.started 出口。
    for (const value of pending.filter((value) => value.body.kind === "turn.started"))
      this.emit(turn, value.body, value.at);
    for (const value of pending.filter((value) => value.body.kind !== "turn.started"))
      this.emit(turn, value.body, value.at);
  }

  private async flushOutbound(): Promise<void> {
    while (!this.closed && this.outbound.length) {
      const fact = this.outbound.shift()!;
      try {
        await this.options.notify(fact);
      } catch {
        this.dropped("transport");
      }
    }
  }

  private pump(): void {
    if (this.drain || this.closed || !this.outbound.length) return;
    this.drain = this.flushOutbound().finally(() => {
      this.drain = undefined;
      this.reportDrops();
      // 原因：最后一次 await 返回后、finally 前仍可能进来新事实，不能把它们滞留在出口。
      this.pump();
    });
  }

  private dropped(reason: "capacity" | "invalid" | "transport"): void {
    this.droppedCounts.set(reason, (this.droppedCounts.get(reason) ?? 0) + 1);
    this.reportDrops();
  }

  private reportDrops(force = false): void {
    if (!this.droppedCounts.size) return;
    const at = this.now();
    if (!force && at - this.lastDropReport < 1_000) return;
    this.lastDropReport = at;
    for (const [reason, count] of this.droppedCounts) {
      emitBridgeStateDiagnostic(this.options.diagnostic, {
        kind: "conversationTelemetryDropped",
        reason,
        count,
      });
    }
    this.droppedCounts.clear();
  }

  expire(): void {
    const now = this.now();
    for (const [key, input] of this.inputs) {
      if (now - input.receivedAt < LOCAL_TTFT_TTL_MS) continue;
      this.finishInput(input, "unclosed");
      this.inputs.delete(key);
    }
    for (const [key, turn] of this.turns) {
      // 活动轮可超过五分钟；只回收终态或始终未获真实归因的记录，不误判长任务超时。
      const at = turn.completedAt ?? (!turn.sourceCommandId ? turn.createdAt : undefined);
      if (at !== undefined && now - at >= LOCAL_TTFT_TTL_MS) this.turns.delete(key);
    }
    this.reportDrops(true);
  }

  async settled(): Promise<void> {
    while (this.drain) await this.drain;
  }
  close(): void {
    this.closed = true;
    clearInterval(this.timer);
    for (const input of this.inputs.values()) this.finishInput(input, "interrupted");
    this.inputs.clear();
    this.turns.clear();
    this.outbound.length = 0;
    this.reportDrops(true);
  }
}
