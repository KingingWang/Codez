import { randomUUID } from "node:crypto";
import { pendingInteractionSchema, type PendingInteraction } from "@zcode/shared/zcode-protocol-v4";
import type { CodexRpcPort, CodexServerRequest } from "./contract.js";
import { array, object, string, type JsonObject } from "./json.js";

interface Pending {
  request: CodexServerRequest;
  threadId: string;
  turnId?: string;
  interaction: PendingInteraction;
  responding: boolean;
}
export interface InteractionAnswer {
  optionId?: string;
  freeText?: string;
  action?: "accept" | "decline" | "cancel";
  content?: Record<string, unknown>;
}

/** Reverse-RPC identities are scoped to this process lifetime, never reconstructed from history. */
export class InteractionBroker {
  private readonly pending = new Map<string, Pending>();
  constructor(
    private readonly rpc: CodexRpcPort,
    private readonly changed: (threadId: string) => void | Promise<void>,
  ) {}

  list(threadId: string): PendingInteraction[] {
    return [...this.pending.values()]
      .filter((entry) => entry.threadId === threadId)
      .map((entry) => entry.interaction);
  }

  async accept(request: CodexServerRequest): Promise<void> {
    const supported = [
      "item/commandExecution/requestApproval",
      "item/fileChange/requestApproval",
      "item/permissions/requestApproval",
      "item/tool/requestUserInput",
      "mcpServer/elicitation/request",
    ];
    if (!supported.includes(request.method)) {
      await this.rpc.respondError(request.id, {
        code: -32601,
        message: "Unsupported client request",
      });
      return;
    }
    const params = object(request.params);
    const threadId = string(params.threadId);
    const interactionId = randomUUID();
    const payload =
      request.method === "item/tool/requestUserInput"
        ? this.questionPayload(params)
        : request.method === "mcpServer/elicitation/request"
          ? {
              kind: "userInput",
              prompt: String(params.message ?? "MCP input requested"),
              freeText: true,
              toolName: String(params.serverName),
              schema: params.requestedSchema,
              input: params,
            }
          : this.permissionPayload(request.method, params);
    const interaction = pendingInteractionSchema.parse({
      interactionId,
      kind: payload.kind,
      anchorRowId: null,
      createdAt: Date.now(),
      // toolCallId 只在 turn 内唯一；保留 turnId 防止后续轮次复用 itemId 时误挂审批。
      ...(typeof params.turnId === "string" ? { turnId: params.turnId } : {}),
      payload,
    });
    this.pending.set(interactionId, {
      request,
      threadId,
      interaction,
      responding: false,
      turnId: typeof params.turnId === "string" ? params.turnId : undefined,
    });
    await this.changed(threadId);
  }

  private permissionPayload(method: string, params: JsonObject): JsonObject {
    const permitted = array(params.availableDecisions).filter(
      (decision): decision is string => typeof decision === "string",
    );
    const defaults = ["accept", "acceptForSession", "decline", "cancel"];
    const decisions = Array.isArray(params.availableDecisions)
      ? defaults.filter((value) => permitted.includes(value))
      : defaults;
    return {
      kind: "permission",
      toolCallId: string(params.itemId),
      toolName: method.includes("fileChange")
        ? "ApplyPatch"
        : method.includes("permissions")
          ? "Permissions"
          : "Bash",
      summary: String(params.reason ?? params.command ?? "Codex requests approval"),
      detail: params,
      options: decisions.map((decision) => ({
        optionId: decision,
        label: {
          accept: "Allow once",
          acceptForSession: "Allow for this session",
          decline: "Deny",
          cancel: "Cancel turn",
        }[decision],
        kind: decision === "accept" ? "allowOnce" : decision === "decline" ? "deny" : "custom",
      })),
    };
  }

  private questionPayload(params: JsonObject): JsonObject {
    const questions = array(params.questions).map(object);
    return {
      kind: "userInput",
      prompt: questions.map((question) => question.question).join("\n"),
      freeText: true,
      sensitive: questions.some((question) => question.isSecret === true),
      toolName: "AskUserQuestion",
      toolCallId: string(params.itemId),
      input: params,
      questions: questions.map((question) => ({
        question: string(question.question),
        header: string(question.header),
        options: array(question.options).map((option) => ({
          value: string(object(option).label),
          label: string(object(option).label),
          description: String(object(option).description ?? ""),
        })),
      })),
    };
  }

  async resolve(threadId: string, interactionId: string, answer: InteractionAnswer): Promise<void> {
    const entry = this.pending.get(interactionId);
    if (!entry || entry.threadId !== threadId || entry.responding)
      throw new Error("Interaction is stale or already resolved");
    const params = object(entry.request.params);
    let response: unknown;
    if (entry.request.method === "item/tool/requestUserInput") {
      const questions = array(params.questions).map(object);
      const answers: Record<string, { answers: string[] }> = {};
      for (const [index, question] of questions.entries()) {
        const raw = answer.content?.[string(question.id)] ?? answer.content?.[String(index)];
        const values = Array.isArray(raw)
          ? raw.filter((value): value is string => typeof value === "string")
          : typeof raw === "string"
            ? [raw]
            : questions.length === 1 && (answer.freeText || answer.optionId)
              ? [answer.freeText ?? answer.optionId!]
              : [];
        if (!values.length && answer.action !== "cancel")
          throw new Error("Every question requires an answer");
        answers[string(question.id)] = { answers: values };
      }
      response = { answers };
    } else if (entry.request.method === "mcpServer/elicitation/request") {
      response = {
        action: answer.action ?? "cancel",
        content: answer.content ?? null,
        _meta: null,
      };
    } else {
      const decision = answer.optionId ?? answer.action ?? "cancel";
      if (
        entry.interaction.payload.kind !== "permission" ||
        !entry.interaction.payload.options.some((option) => option.optionId === decision)
      ) {
        throw new Error("Approval decision was not offered by Codex");
      }
      response =
        entry.request.method === "item/permissions/requestApproval"
          ? {
              permissions:
                decision === "accept" || decision === "acceptForSession" ? params.permissions : {},
              scope: decision === "acceptForSession" ? "session" : "turn",
            }
          : { decision };
    }
    // 不重发写回：失败可能意味着 Codex 已消费响应但连接随后丢失。
    entry.responding = true;
    await this.rpc.respond(entry.request.id, response);
    this.pending.delete(interactionId);
    await this.changed(threadId);
  }

  async expireTurn(threadId: string, turnId: string): Promise<void> {
    for (const [id, entry] of this.pending) {
      if (entry.threadId === threadId && entry.turnId === turnId) this.pending.delete(id);
    }
    await this.changed(threadId);
  }

  async resolved(threadId: string, requestId: unknown): Promise<void> {
    for (const [id, entry] of this.pending) {
      if (entry.threadId === threadId && entry.request.id === requestId) this.pending.delete(id);
    }
    await this.changed(threadId);
  }
}
