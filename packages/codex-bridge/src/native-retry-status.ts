import type { ApiRetryState } from "@codez/shared/codez-protocol-v4";
import type { JsonObject } from "./json.js";
import { lastTurn } from "./thread-index.js";

/** 桥侧持有的原生重试态：只归属某个 native turn，随投影存活，不是持久事实。 */
export type NativeRetryState = {
  turnId: string;
  status: Extract<ApiRetryState, { source: "codex" }>;
} | null;

const MAX_RETRY_ERROR_DETAIL_CHARS = 16_384;

function optionalRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/** 原生 additionalDetails 可能是 provider 响应体；只保留有界文本，避免快照被异常正文撑大。 */
export function retryErrorDetail(error: unknown): string | null {
  const detail = optionalRecord(error).additionalDetails;
  if (typeof detail !== "string") return null;
  const normalized = detail.trim();
  if (!normalized) return null;
  return normalized.length > MAX_RETRY_ERROR_DETAIL_CHARS
    ? `${normalized.slice(0, MAX_RETRY_ERROR_DETAIL_CHARS - 1)}…`
    : normalized;
}

/** HTTP 状态码只接受结构化字段；正文另行做有界处理。 */
export function retryHttpStatus(error: unknown): number | null {
  const info = optionalRecord(optionalRecord(error).codexErrorInfo);
  const value = optionalRecord(info.responseStreamDisconnected).httpStatusCode;
  return typeof value === "number" && Number.isInteger(value) && value >= 100 && value <= 599
    ? value
    : null;
}

const MAX_REPORTED_RETRY_COUNT = 1000;

/**
 * 从原生 willRetry 通知的 error.message 中仅提取正整数进度对 (attempt, maxRetries)，
 * 例如 "Reconnecting... 1/5" -> { attempt: 1, maxRetries: 5 }。
 * 不从 message 之外伪造计数；没有携带有效进度则返回 null。
 */
export function retryAttemptCounts(error: unknown): { attempt: number; maxRetries: number } | null {
  const message = optionalRecord(error).message;
  if (typeof message !== "string") return null;
  const match = /(\d+)\s*\/\s*(\d+)/.exec(message);
  if (!match) return null;
  const attempt = Number(match[1]);
  const maxRetries = Number(match[2]);
  if (
    !Number.isSafeInteger(attempt) ||
    !Number.isSafeInteger(maxRetries) ||
    attempt < 1 ||
    maxRetries < attempt ||
    maxRetries > MAX_REPORTED_RETRY_COUNT
  ) {
    return null;
  }
  return { attempt, maxRetries };
}

/**
 * Bug 原因：原生 willRetry 通知以前完全不进入会话投影，用户看不到模型接口正在重试。
 * 只有“最后一个 inProgress turn”的重试才可见：过期 turn、已结束 turn 的通知既不能创建
 * 也不能复活状态；终态（willRetry 非 true）清除该 turn 的重试。状态是瞬时的显示事实，
 * 归属 Codex，桥只提取受校验的 HTTP 状态码、正整数重试进度对和有界错误详情。
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
  // 修复原因：旧写法 `object(array(thread.turns).at(-1))` 假定「最后一轮一定存在」。
  // 但 `thread.turns` 可以合法为空或整个字段缺失：`thread/started` 走的是未经 schema 校验的
  // 原始 put（thread-state.ts:344-352），`reloadAfterHistoryChange` 也会先把 turns 清空再 await ensure
  // （thread-state.ts:305）。此时 `array()` 防御性地返回 []，紧接着 `.at(-1)` 得到 undefined，
  // `object(undefined)` 抛 "Expected a JSON object"；该异常发生在串行 event tail 上，
  // 会被 bridge-runtime.ts:188-190 升级成 fatal 并让 bridge 进程退出（整个窗口的会话一起断）。
  // 修复依据：本函数头部注释已明确「只有最后一个 inProgress turn 的重试才可见，过期/已结束 turn
  // 的通知既不能创建也不能复活状态」。没有轮次即没有活动轮，与既有分支同一口径返回 unchanged；
  // `lastTurn()` 是仓库已有的安全取值工具（thread-index.ts:311-315），对缺失字段与空数组都返回 undefined。
  const activeTurn = lastTurn(thread);
  if (!activeTurn || activeTurn.id !== turnId || activeTurn.status !== "inProgress")
    return unchanged;
  const httpStatusCode = retryHttpStatus(params.error);
  const counts = retryAttemptCounts(params.error);
  const errorDetail = retryErrorDetail(params.error);
  const attempt = counts?.attempt ?? null;
  const maxRetries = counts?.maxRetries ?? null;
  if (
    current?.turnId === turnId &&
    current.status.httpStatusCode === httpStatusCode &&
    (current.status.attempt ?? null) === attempt &&
    (current.status.maxRetries ?? null) === maxRetries &&
    (current.status.errorDetail ?? null) === errorDetail
  )
    return unchanged;
  return {
    retry: {
      turnId,
      status: {
        source: "codex",
        httpStatusCode,
        attempt,
        maxRetries,
        ...(errorDetail ? { errorDetail } : {}),
      },
    },
    changed: true,
  };
}
