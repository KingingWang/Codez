import type { CodexServerRequest } from "./contract.js";
import { array, object, string, type JsonObject } from "./json.js";

const DEFAULT_DECISIONS = ["accept", "acceptForSession", "decline", "cancel"];
const DEFAULT_LABELS: Record<string, string> = {
  accept: "Allow once",
  acceptForSession: "Allow for this session",
  decline: "Deny",
  cancel: "Cancel turn",
};

export const INTERACTION_METHODS = new Set([
  "item/commandExecution/requestApproval",
  "item/fileChange/requestApproval",
  "item/permissions/requestApproval",
  "item/tool/requestUserInput",
  "mcpServer/elicitation/request",
]);

function objectDecisionName(decision: unknown): string | null {
  if (typeof decision !== "object" || decision === null || Array.isArray(decision)) return null;
  const keys = Object.keys(decision);
  if (keys.length !== 1) return null;
  const name = keys[0]!;
  if (name !== "acceptWithExecpolicyAmendment" && name !== "applyNetworkPolicyAmendment")
    return null;
  const raw = (decision as JsonObject)[name];
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const value = raw as JsonObject;
  if (name === "acceptWithExecpolicyAmendment") {
    const amendment = value.execpolicy_amendment;
    return Array.isArray(amendment) && amendment.every((part) => typeof part === "string")
      ? name
      : null;
  }
  const rawAmendment = value.network_policy_amendment;
  if (typeof rawAmendment !== "object" || rawAmendment === null || Array.isArray(rawAmendment))
    return null;
  const amendment = rawAmendment as JsonObject;
  return typeof amendment.host === "string" && ["allow", "deny"].includes(String(amendment.action))
    ? name
    : null;
}

function objectDecisionKind(decision: unknown): "allowAlways" | "deny" | "custom" | null {
  const name = objectDecisionName(decision);
  if (name === "acceptWithExecpolicyAmendment") return "allowAlways";
  if (name === "applyNetworkPolicyAmendment")
    return object(object(object(decision)[name]).network_policy_amendment).action === "deny"
      ? "deny"
      : "allowAlways";
  return null;
}

function permissionProjection(
  method: string,
  params: JsonObject,
): { payload: JsonObject; nativeDecisions?: Map<string, unknown> } {
  const available = Array.isArray(params.availableDecisions)
    ? array(params.availableDecisions).filter((decision) =>
        method === "item/commandExecution/requestApproval"
          ? (typeof decision === "string" && DEFAULT_DECISIONS.includes(decision)) ||
            objectDecisionName(decision) !== null
          : typeof decision === "string" && DEFAULT_DECISIONS.includes(decision),
      )
    : DEFAULT_DECISIONS;
  const counts = new Map<string, number>();
  const nativeDecisions = new Map<string, unknown>();
  const options = available.map((decision) => {
    const name = typeof decision === "string" ? decision : objectDecisionName(decision)!;
    const index = counts.get(name) ?? 0;
    counts.set(name, index + 1);
    const optionId = typeof decision === "string" ? name : `${name}:${index}`;
    nativeDecisions.set(optionId, decision);
    const kind = objectDecisionKind(decision);
    return {
      optionId,
      label:
        typeof decision === "string"
          ? DEFAULT_LABELS[decision]
          : name === "acceptWithExecpolicyAmendment"
            ? "Yes, and don't ask again for commands that start with …"
            : kind === "deny"
              ? "No, and block this host in the future"
              : "Yes, and allow this host in the future",
      kind:
        decision === "accept"
          ? "allowOnce"
          : decision === "decline" || kind === "deny"
            ? "deny"
            : kind === "allowAlways"
              ? "allowAlways"
              : "custom",
    };
  });
  return {
    payload: {
      kind: "permission",
      toolCallId: string(params.itemId),
      toolName: method.includes("fileChange")
        ? "ApplyPatch"
        : method.includes("permissions")
          ? "Permissions"
          : "Bash",
      summary: String(params.reason ?? params.command ?? "Codex requests approval"),
      detail: params,
      options,
    },
    nativeDecisions:
      method === "item/commandExecution/requestApproval" && Array.isArray(params.availableDecisions)
        ? nativeDecisions
        : undefined,
  };
}

function mcpToolApprovalPayload(params: JsonObject, interactionId: string): JsonObject | null {
  const meta = params._meta;
  const schema = params.requestedSchema;
  // 原生 MCP tool approval 是空 schema 的 action，不是让用户填字符串的 form。
  // 只认 Codex 明确标记且无字段的请求，普通 MCP elicitation 仍走输入通道。
  if (
    params.mode !== "form" ||
    !meta ||
    typeof meta !== "object" ||
    Array.isArray(meta) ||
    (meta as JsonObject).codex_approval_kind !== "mcp_tool_call" ||
    !schema ||
    typeof schema !== "object" ||
    Array.isArray(schema) ||
    (schema as JsonObject).type !== "object" ||
    !("properties" in schema) ||
    !schema.properties ||
    typeof schema.properties !== "object" ||
    Array.isArray(schema.properties) ||
    Object.keys(schema.properties).length > 0
  )
    return null;
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
  const persist = metaRecord.persist;
  const supports = (mode: string) =>
    persist === mode || (Array.isArray(persist) && persist.includes(mode));
  return {
    kind: "permission",
    // 优先使用显式 itemId；缺失时由 projection-rows 按同 turn in-progress mcpToolCall 匹配。
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

export function projectNativeInteraction(
  request: CodexServerRequest,
  interactionId: string,
): { payload: JsonObject; nativeDecisions?: Map<string, unknown> } {
  const params = object(request.params);
  if (request.method === "item/tool/requestUserInput") {
    const questions = array(params.questions).map(object);
    return {
      payload: {
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
      },
    };
  }
  if (request.method === "mcpServer/elicitation/request")
    return {
      payload: mcpToolApprovalPayload(params, interactionId) ?? {
        kind: "userInput",
        prompt: String(params.message ?? "MCP input requested"),
        freeText: true,
        toolName: String(params.serverName),
        schema: params.requestedSchema,
        input: params,
      },
    };
  return permissionProjection(request.method, params);
}
