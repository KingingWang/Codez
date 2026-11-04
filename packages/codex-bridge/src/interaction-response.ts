import type { PendingInteraction } from "@codez/shared/codez-protocol-v4";
import type { CodexServerRequest } from "./contract.js";
import { array, object, string } from "./json.js";

export interface InteractionAnswer {
  optionId?: string;
  freeText?: string;
  action?: "accept" | "decline" | "cancel";
  content?: Record<string, unknown>;
}

export function nativeInteractionResponse(
  entry: {
    request: CodexServerRequest;
    interaction: PendingInteraction;
    nativeDecisions?: Map<string, unknown>;
  },
  answer: InteractionAnswer,
): unknown {
  const params = object(entry.request.params);
  if (entry.request.method === "item/tool/requestUserInput") {
    const questions = array(params.questions).map(object);
    const answers = new Map<string, { answers: string[] }>();
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
      answers.set(string(question.id), { answers: values });
    }
    // 原生 ID 可以是 __proto__；普通对象赋值会吞掉该答案，不能误变成自动继续的空 map。
    return { answers: Object.fromEntries(answers) };
  }
  if (entry.request.method === "mcpServer/elicitation/request") {
    if (entry.interaction.payload.kind === "permission") {
      const optionId = answer.optionId;
      if (!entry.interaction.payload.options.some((option) => option.optionId === optionId))
        throw new Error("Approval decision was not offered by Codex");
      // freeText 的 "allow" 不是原生 action；持久授权也必须来自已提供的选项。
      return {
        action: optionId === "cancel" ? "cancel" : "accept",
        content: null,
        _meta:
          optionId === "acceptForSession"
            ? { persist: "session" }
            : optionId === "acceptAlways"
              ? { persist: "always" }
              : null,
      };
    }
    return { action: answer.action ?? "cancel", content: answer.content ?? null, _meta: null };
  }
  const decision = answer.optionId ?? answer.action ?? "cancel";
  if (
    entry.interaction.payload.kind !== "permission" ||
    !entry.interaction.payload.options.some((option) => option.optionId === decision)
  )
    throw new Error("Approval decision was not offered by Codex");
  const nativeDecision = entry.nativeDecisions?.get(decision);
  if (entry.nativeDecisions && nativeDecision === undefined)
    throw new Error("Approval decision was not offered by Codex");
  // amendment 是 Codex 提供的授权事实；renderer 只能提交 optionId，不能伪造 amendment。
  const value = nativeDecision ?? decision;
  return entry.request.method === "item/permissions/requestApproval" && typeof value === "string"
    ? {
        permissions: value === "accept" || value === "acceptForSession" ? params.permissions : {},
        scope: value === "acceptForSession" ? "session" : "turn",
      }
    : { decision: value };
}

export function nativeResponseDecision(
  method: string,
  response: unknown,
  answer?: InteractionAnswer,
): { denied: boolean; decision?: "allow" | "deny" | "modify" } {
  const native = object(response);
  const value =
    native.decision ??
    native.action ??
    (method === "item/permissions/requestApproval" ? answer?.optionId : undefined);
  const kind =
    typeof value === "string"
      ? value
      : value && typeof value === "object" && !Array.isArray(value)
        ? Object.keys(value)[0]
        : undefined;
  const denied = ["decline", "declineWithFeedback", "deny", "cancel"].includes(kind ?? "");
  return {
    denied,
    decision: denied
      ? "deny"
      : ["accept", "acceptForSession", "acceptAlways"].includes(kind ?? "")
        ? "allow"
        : kind?.includes("Amendment")
          ? "modify"
          : undefined,
  };
}
