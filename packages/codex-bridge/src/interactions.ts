import { randomUUID } from "node:crypto";
import { pendingInteractionSchema, type PendingInteraction } from "@codez/shared/codez-protocol-v4";
import type { CodexRpcPort, CodexServerRequest } from "./contract.js";
import { object, string } from "./json.js";
import { INTERACTION_METHODS, projectNativeInteraction } from "./interaction-projection.js";
import {
  nativeInteractionResponse,
  nativeResponseDecision,
  type InteractionAnswer,
} from "./interaction-response.js";
import {
  QUESTION_AUTO_RESOLUTION_MS,
  QUESTION_HIDDEN_GRACE_MS,
  scheduleQuestionTimer,
  type QuestionAutoResolutionOptions,
} from "./interaction-auto-resolution.js";

export type { InteractionAnswer } from "./interaction-response.js";

interface Pending {
  request: CodexServerRequest;
  threadId: string;
  turnId?: string;
  interaction: PendingInteraction;
  nativeDecisions?: Map<string, unknown>;
  responding: boolean;
  eligible: boolean;
  cancelTimers?: () => void;
}

/** Reverse-RPC identities are scoped to this process lifetime, never reconstructed from history. */
export class InteractionBroker {
  private readonly pending = new Map<string, Pending>();
  private tail: Promise<void> = Promise.resolve();
  private enabled = true;
  private closed = false;
  private readonly now: () => number;
  private readonly schedule: NonNullable<QuestionAutoResolutionOptions["schedule"]>;
  constructor(
    private readonly rpc: CodexRpcPort,
    private readonly changed: (threadId: string) => void | Promise<void>,
    private readonly observed?: (
      request: CodexServerRequest,
      phase: "requested" | "resolved" | "denied",
      decision?: "allow" | "deny" | "modify" | "escalate",
    ) => void,
    private readonly options: QuestionAutoResolutionOptions = {},
  ) {
    this.now = options.now ?? Date.now;
    this.schedule = options.schedule ?? scheduleQuestionTimer;
  }

  list(threadId: string): PendingInteraction[] {
    return [...this.pending.values()]
      .filter((entry) => entry.threadId === threadId)
      .map((entry) => entry.interaction);
  }

  /** 问题资格、偏好和 timer 必须经过同一入口；不能让异步写回与 deadline 竞争重发。 */
  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.tail.then(() => {
      if (this.closed) throw new Error("Interaction broker is closed");
      return operation();
    });
    this.tail = result.then(
      () => {},
      () => {},
    );
    return result;
  }

  async whenSettled(): Promise<void> {
    await this.tail;
  }

  private recordObservation(
    request: CodexServerRequest,
    phase: "requested" | "resolved" | "denied",
    decision?: "allow" | "deny" | "modify" | "escalate",
  ): void {
    // 只读观察失败不能把已经受理/回复的请求改成业务错误，也不能导致原生写回重发。
    try {
      this.observed?.(request, phase, decision);
    } catch {
      /* 只读诊断 */
    }
  }

  private observeQuestion(request: CodexServerRequest, response?: unknown): void {
    if (request.method !== "item/tool/requestUserInput") return;
    try {
      this.options.onQuestion?.(request, response);
    } catch (error) {
      // 历史/诊断旁路失败不能翻转已写出的应答或阻止 timer 注册。
      this.reportError(error);
    }
  }

  private reportError(error: unknown): void {
    try {
      this.options.onError?.(error);
    } catch {
      /* 诊断回调不得破坏单次写回语义 */
    }
  }

  accept(request: CodexServerRequest): Promise<void> {
    return this.enqueue(async () => {
      if (!INTERACTION_METHODS.has(request.method)) {
        await this.rpc.respondError(request.id, {
          code: -32601,
          message: "Unsupported client request",
        });
        return;
      }
      const params = object(request.params);
      const threadId = string(params.threadId);
      const interactionId = randomUUID();
      const { payload, nativeDecisions } = projectNativeInteraction(request, interactionId);
      const interaction = pendingInteractionSchema.parse({
        interactionId,
        kind: payload.kind,
        anchorRowId: null,
        createdAt: this.now(),
        // toolCallId 只在 turn 内唯一，不能把下一轮复用的 itemId 误挂到旧问题。
        ...(typeof params.turnId === "string" ? { turnId: params.turnId } : {}),
        payload,
      });
      this.pending.set(interactionId, {
        request,
        threadId,
        interaction,
        nativeDecisions,
        responding: false,
        turnId: typeof params.turnId === "string" ? params.turnId : undefined,
        eligible: this.enabled && request.method === "item/tool/requestUserInput",
      });
      this.observeQuestion(request);
      this.recordObservation(request, "requested");
      this.startHead(threadId);
      await this.changed(threadId);
    });
  }

  private startHead(threadId: string): void {
    const head = [...this.pending.values()].find((entry) => entry.threadId === threadId);
    if (!head || !head.eligible || head.responding || head.interaction.autoResolution) return;
    const startedAt = this.now();
    const visibleAt = startedAt + (this.options.hiddenGraceMs ?? QUESTION_HIDDEN_GRACE_MS);
    const deadlineAt = startedAt + (this.options.autoResolutionMs ?? QUESTION_AUTO_RESOLUTION_MS);
    head.interaction.autoResolution = { state: "hiddenGrace", startedAt, visibleAt, deadlineAt };
    const timer = (at: number, action: () => Promise<void>) =>
      this.schedule(
        () => {
          if (this.closed) return;
          void this.enqueue(action).catch((error: unknown) => {
            if (!this.closed) this.reportError(error);
          });
        },
        Math.max(0, at - this.now()),
      );
    const visible = timer(visibleAt, async () => {
      const timing = head.interaction.autoResolution;
      if (head.responding || timing?.state !== "hiddenGrace" || !this.isPending(head)) return;
      head.interaction.autoResolution = { ...timing, state: "visibleCountdown" };
      await this.changed(threadId);
    });
    const deadline = timer(deadlineAt, async () => {
      const timing = head.interaction.autoResolution;
      if (head.responding || !timing || timing.state === "snoozed" || !this.isPending(head)) return;
      // 普通 UI 答案校验禁止空答案；只有到期路径按原生协议发送空 answers，
      // 不猜选项、不批准权限、不追加伪造的用户消息。
      await this.reply(head, { answers: {} });
    });
    head.cancelTimers = () => {
      visible();
      deadline();
    };
  }

  private isPending(entry: Pending): boolean {
    return this.pending.get(entry.interaction.interactionId) === entry;
  }

  private pause(entry: Pending): boolean {
    entry.eligible = false;
    const timing = entry.interaction.autoResolution;
    if (!timing || timing.state === "snoozed" || entry.responding) return false;
    entry.cancelTimers?.();
    entry.cancelTimers = undefined;
    entry.interaction.autoResolution = {
      state: "snoozed",
      startedAt: timing.startedAt,
      snoozedAt: this.now(),
    };
    return true;
  }

  snooze(threadId: string, interactionId: string): Promise<boolean> {
    return this.enqueue(async () => {
      const entry = this.pending.get(interactionId);
      if (!entry || entry.threadId !== threadId || !this.pause(entry)) return false;
      await this.changed(threadId);
      return true;
    });
  }

  updatePreferences(enabled: boolean): Promise<{
    askUserQuestionAutoResolutionEnabled: boolean;
    snoozedInteractionCount: number;
  }> {
    return this.enqueue(async () => {
      this.enabled = enabled;
      let count = 0;
      const changed = new Set<string>();
      if (!enabled) {
        // 关闭撤销既有排队问题的资格，重开不能追溯恢复；新注册才读当前设置。
        for (const entry of this.pending.values()) {
          if (this.pause(entry)) {
            count++;
            changed.add(entry.threadId);
          }
        }
      }
      for (const id of changed) await this.changed(id);
      return { askUserQuestionAutoResolutionEnabled: this.enabled, snoozedInteractionCount: count };
    });
  }

  resolve(threadId: string, interactionId: string, answer: InteractionAnswer): Promise<void> {
    return this.enqueue(async () => {
      const entry = this.pending.get(interactionId);
      if (!entry || entry.threadId !== threadId || entry.responding)
        throw new Error("Interaction is stale or already resolved");
      await this.reply(entry, nativeInteractionResponse(entry, answer), answer);
    });
  }

  private async reply(
    entry: Pending,
    response: unknown,
    answer?: InteractionAnswer,
  ): Promise<void> {
    // 写回失败可能发生在 Codex 已消费之后；先占有请求并清 timer，未知结果绝不重试。
    entry.responding = true;
    entry.cancelTimers?.();
    entry.cancelTimers = undefined;
    await this.rpc.respond(entry.request.id, response);
    if (this.closed) return;
    this.observeQuestion(entry.request, response);
    this.pending.delete(entry.interaction.interactionId);
    const { denied, decision } = nativeResponseDecision(entry.request.method, response, answer);
    this.recordObservation(entry.request, denied ? "denied" : "resolved", decision);
    this.startHead(entry.threadId);
    await this.changed(entry.threadId);
  }

  expireTurn(threadId: string, turnId: string): Promise<void> {
    return this.enqueue(async () => {
      for (const [id, entry] of this.pending) {
        if (entry.threadId === threadId && entry.turnId === turnId) {
          entry.cancelTimers?.();
          this.pending.delete(id);
        }
      }
      this.startHead(threadId);
      await this.changed(threadId);
    });
  }

  resolved(threadId: string, requestId: unknown): Promise<void> {
    return this.enqueue(async () => {
      for (const [id, entry] of this.pending) {
        if (entry.threadId === threadId && entry.request.id === requestId) {
          entry.cancelTimers?.();
          this.pending.delete(id);
          this.recordObservation(entry.request, "resolved");
        }
      }
      this.startHead(threadId);
      await this.changed(threadId);
    });
  }

  close(): void {
    this.closed = true;
    for (const entry of this.pending.values()) entry.cancelTimers?.();
    this.pending.clear();
  }
}
