import type { ApiRetryState } from "@codez/shared/codez-protocol-v4";
import { array, object, type JsonObject } from "./json.js";

/** 桥侧持有的原生重试态：只归属某个 native turn，随投影存活，不是持久事实。 */
export type NativeRetryState = {
  turnId: string;
  status: Extract<ApiRetryState, { source: "codex" }>;
} | null;

function optionalRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/** Only the structured status is safe to show; native error details may contain provider data. */
export function retryHttpStatus(error: unknown): number | null {
  const info = optionalRecord(optionalRecord(error).codexErrorInfo);
  const value = optionalRecord(info.responseStreamDisconnected).httpStatusCode;
  return typeof value === "number" && Number.isInteger(value) && value >= 100 && value <= 599
    ? value
    : null;
}

/**
 * Bug 原因：原生 willRetry 通知以前完全不进入会话投影，用户看不到模型接口正在重试。
 * 只有“最后一个 inProgress turn”的重试才可见：过期 turn、已结束 turn 的通知既不能创建
 * 也不能复活状态；终态（willRetry 非 true）清除该 turn 的重试。状态是瞬时的显示事实，
 * 归属 Codex，桥不推断重试次数，也不复制可能含敏感 provider 信息的错误正文。
 */
export function applyNativeRetry(
  thread: JsonObject,
  current: NativeRetryState,
  params: JsonObject,
): { retry: NativeRetryState; changed: boolean } {
  const unchanged = { retry: current, changed: false };
  const turnId = params.turnId;
  if (typeof turnId !== "string") return unchanged;
  if (params.willRetry !== true)
    return current?.turnId === turnId ? { retry: null, changed: true } : unchanged;
  const activeTurn = object(array(thread.turns).at(-1));
  if (activeTurn.id !== turnId || activeTurn.status !== "inProgress") return unchanged;
  const httpStatusCode = retryHttpStatus(params.error);
  if (current?.turnId === turnId && current.status.httpStatusCode === httpStatusCode)
    return unchanged;
  return { retry: { turnId, status: { source: "codex", httpStatusCode } }, changed: true };
}
