import type { CommandAck, CommandEnvelope } from "@codez/shared/codez-protocol-v4";

export interface NativeFirstOutputDiagnostic {
  kind: "nativeFirstOutput";
  instanceId: string;
  observationId: string;
  commandId: string;
  sessionId?: string;
  turnId?: string;
  outcome: "success" | "failed" | "interrupted" | "excluded" | "unclosed";
  reason?: "busy" | "unsupported" | "capacity" | "clock-invalid";
  durationMs?: number;
  outputKind?: "text" | "reasoning" | "tool";
}

/** 只读观察端口，不改变 CommandRouter 的 ledger/admission 或 Codex 的执行权。 */
export interface CommandObservations {
  received(command: CommandEnvelope, at: number): void;
  beginTurn(command: CommandEnvelope, sessionId: string, eligible: boolean): void;
  acceptTurn(command: CommandEnvelope, sessionId: string, response: unknown): void;
  decided(command: CommandEnvelope, ack: CommandAck): void;
}

/** 埋点派生不能把已受理命令或有效原生通知变成失败。 */
export function observeConversationSafely(observe: () => void): void {
  try {
    observe();
  } catch {
    // 原因：观察器不是执行权威；诊断出口异常不能影响 ledger/admission 或投影。
  }
}

export function observationRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export function observationId(value: unknown): string | undefined {
  return typeof value === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(value) ? value : undefined;
}

export function observationNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

export function nativeToolName(item: Record<string, unknown>): string | undefined {
  switch (item.type) {
    case "commandExecution":
      return "Bash";
    case "fileChange":
      return "ApplyPatch";
    case "mcpToolCall":
    case "dynamicToolCall":
      return typeof item.tool === "string" && /^[A-Za-z0-9_.:-]{1,128}$/.test(item.tool)
        ? item.tool
        : undefined;
    case "webSearch":
      return "WebSearch";
    case "imageView":
      return "ViewImage";
    case "imageGeneration":
      return "ImageGeneration";
    case "collabAgentToolCall":
      return "Agent";
    default:
      return undefined;
  }
}

/** 空 item start 不是内容；零参数 MCP 调用仍是完整、可展示的工具调用。 */
export function nativeOutputKind(
  item: Record<string, unknown>,
): NativeFirstOutputDiagnostic["outputKind"] {
  if (
    (item.type === "agentMessage" || item.type === "plan") &&
    typeof item.text === "string" &&
    item.text.length > 0
  )
    return "text";
  if (
    item.type === "reasoning" &&
    [item.summary, item.content].some(
      (parts) =>
        Array.isArray(parts) && parts.some((part) => typeof part === "string" && part.length > 0),
    )
  )
    return "reasoning";
  return nativeToolName(item) ? "tool" : undefined;
}

export const OBSERVED_USAGE_KEYS = [
  "inputTokens",
  "outputTokens",
  "totalTokens",
  "reasoningTokens",
  "cacheReadTokens",
  "cacheWriteTokens",
] as const;
export type ObservedUsage = Record<(typeof OBSERVED_USAGE_KEYS)[number], number>;

export function completeObservedUsage(raw: unknown, native = false): ObservedUsage | undefined {
  const value = observationRecord(raw);
  const fields = {
    inputTokens: value.inputTokens,
    outputTokens: value.outputTokens,
    totalTokens: value.totalTokens,
    reasoningTokens: native ? value.reasoningOutputTokens : value.reasoningTokens,
    cacheReadTokens: native ? value.cachedInputTokens : value.cacheReadTokens,
    cacheWriteTokens: native ? value.cacheWriteInputTokens : value.cacheWriteTokens,
  };
  if (!OBSERVED_USAGE_KEYS.every((key) => observationNumber(fields[key]) !== undefined))
    return undefined;
  return fields as ObservedUsage;
}
