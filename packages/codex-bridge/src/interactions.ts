import { randomUUID } from "node:crypto";
import { pendingInteractionSchema, type PendingInteraction } from "@codez/shared/codez-protocol-v4";
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

const MCP_TOOL_APPROVAL_KIND = "mcp_tool_call";

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
          ? (this.mcpToolApprovalPayload(params, interactionId) ?? {
              kind: "userInput",
              prompt: String(params.message ?? "MCP input requested"),
              freeText: true,
              toolName: String(params.serverName),
              schema: params.requestedSchema,
              input: params,
            })
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

  private mcpToolApprovalPayload(params: JsonObject, interactionId: string): JsonObject | null {
    const meta = params._meta;
    const schema = params.requestedSchema;
    // 原因：原生 MCP tool approval 是空 schema 的 action，不是让用户填字符串的 form。
    // 只认 Codex 明确标记且无字段的请求，普通 MCP elicitation 仍走输入通道。
    if (
      params.mode !== "form" ||
      !meta ||
      typeof meta !== "object" ||
      Array.isArray(meta) ||
      (meta as JsonObject).codex_approval_kind !== MCP_TOOL_APPROVAL_KIND ||
      !schema ||
      typeof schema !== "object" ||
      Array.isArray(schema) ||
      (schema as JsonObject).type !== "object" ||
      !("properties" in schema) ||
      !schema.properties ||
      typeof schema.properties !== "object" ||
      Array.isArray(schema.properties) ||
      Object.keys(schema.properties).length > 0
    ) {
      return null;
    }
    const serverName = string(params.serverName, "MCP server");
    const summary = string(params.message, "MCP approval message");
    const metaRecord = meta as JsonObject;
    const rawToolName =
      typeof metaRecord.tool_name === "string" && metaRecord.tool_name.trim().length > 0
        ? metaRecord.tool_name.trim()
        : /^Allow\b[\s\S]*?\bto run tool "([^"\r\n]+)"\?$/u.exec(summary)?.[1]?.trim();
    const toolName = rawToolName
      ? `mcp__${serverName}__${rawToolName}`
      : `mcp__${serverName}__approval`;
    const itemId =
      typeof params.itemId === "string" && params.itemId.trim().length > 0
        ? params.itemId.trim()
        : typeof metaRecord.item_id === "string" && metaRecord.item_id.trim().length > 0
          ? metaRecord.item_id.trim()
          : interactionId;
    const persist = (meta as JsonObject).persist;
    const supports = (mode: string) =>
      persist === mode || (Array.isArray(persist) && persist.includes(mode));
    return {
      kind: "permission",
      // 优先使用显式 itemId；缺失时退回 interactionId，并由 projection-rows 按同 turn in-progress mcpToolCall 匹配。
      toolCallId: itemId,
      toolName,
      summary,
      detail: {
        toolName,
        reason: summary,
        ...(metaRecord.tool_params && typeof metaRecord.tool_params === "object"
          ? { rawInput: metaRecord.tool_params }
          : {}),
      },
      options: [
        { optionId: "accept", label: "Allow", kind: "allowOnce", response: { decision: "allow" } },
        ...(supports("session")
          ? [
              {
                optionId: "acceptForSession",
                label: "Allow for this session",
                kind: "allowAlways",
                response: { decision: "allow" },
              },
            ]
          : []),
        ...(supports("always")
          ? [
              {
                optionId: "acceptAlways",
                label: "Always allow",
                kind: "allowAlways",
                response: { decision: "allow" },
              },
            ]
          : []),
        { optionId: "cancel", label: "Cancel", kind: "custom", response: { decision: "deny" } },
      ],
    };
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
      if (entry.interaction.payload.kind === "permission") {
        const optionId = answer.optionId;
        if (!entry.interaction.payload.options.some((option) => option.optionId === optionId)) {
          throw new Error("Approval decision was not offered by Codex");
        }
        // 原因：freeText 的 "allow" 不是原生 action；持久授权也必须来自已提供的选项。
        response = {
          action: optionId === "cancel" ? "cancel" : "accept",
          content: null,
          _meta:
            optionId === "acceptForSession"
              ? { persist: "session" }
              : optionId === "acceptAlways"
                ? { persist: "always" }
                : null,
        };
      } else {
        response = {
          action: answer.action ?? "cancel",
          content: answer.content ?? null,
          _meta: null,
        };
      }
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
