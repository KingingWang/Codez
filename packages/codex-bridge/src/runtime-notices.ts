import type { CodexNotification } from "./contract.js";

const MAX_MESSAGE_CHARS = 4_096;
const MAX_DETAIL_CHARS = 16_384;
const RUNTIME_NOTICE_METHODS = new Set([
  "warning",
  "configWarning",
  "deprecationNotice",
  "guardianWarning",
  "modelProvider/authRecoveryStarted",
  "modelProvider/authRecoveryCompleted",
]);

export function isRuntimeNoticeMethod(method: string): boolean {
  return RUNTIME_NOTICE_METHODS.has(method);
}

export interface CodexRuntimeNoticeLog {
  kind: "warning" | "configWarning" | "deprecationNotice" | "guardianWarning" | "authRecovery";
  message: string;
  detail?: string;
  threadId?: string;
  turnId?: string;
  provider?: string;
  phase?: "started" | "completed";
}

function boundedText(value: unknown, max: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = value.trim();
  return text ? text.slice(0, max) : undefined;
}

function identity(value: unknown, max = 1024): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = value.trim();
  return text && text.length <= max ? text : undefined;
}

/** 将原生通知转成有界日志事实；配置路径不进入日志，也不再投影到会话 UI。 */
export function readRuntimeNotice(event: CodexNotification): CodexRuntimeNoticeLog | undefined {
  const rawParams = event.params;
  if (!rawParams || typeof rawParams !== "object" || Array.isArray(rawParams)) return undefined;
  const params = rawParams as Record<string, unknown>;
  if (event.method === "configWarning" || event.method === "deprecationNotice") {
    const message = boundedText(params.summary, MAX_MESSAGE_CHARS);
    if (!message) return undefined;
    const detail = boundedText(params.details, MAX_DETAIL_CHARS);
    return { kind: event.method, message, ...(detail ? { detail } : {}) };
  }
  if (event.method === "warning" || event.method === "guardianWarning") {
    const message = boundedText(params.message, MAX_MESSAGE_CHARS);
    if (!message) return undefined;
    if (event.method === "warning" && params.threadId === null) {
      return { kind: "warning", message };
    }
    const threadId = identity(params.threadId);
    if (!threadId) return undefined;
    return {
      kind: event.method === "warning" ? "warning" : "guardianWarning",
      message,
      threadId,
    };
  }
  if (
    event.method === "modelProvider/authRecoveryStarted" ||
    event.method === "modelProvider/authRecoveryCompleted"
  ) {
    const threadId = identity(params.threadId);
    const turnId = identity(params.turnId);
    const provider = identity(params.provider, 160);
    const message = boundedText(params.message, MAX_MESSAGE_CHARS);
    if (!threadId || !turnId || !provider || !message) return undefined;
    return {
      kind: "authRecovery",
      message,
      threadId,
      turnId,
      provider,
      phase: event.method.endsWith("Started") ? "started" : "completed",
    };
  }
  return undefined;
}
