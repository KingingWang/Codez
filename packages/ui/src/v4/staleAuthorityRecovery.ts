const STALE_AUTHORITY_REASON_CODES = new Set([
  "proto.staleLogEpoch",
  "proto.staleRevision",
  "proto.staleTarget",
]);

/** stop 的精确目标守卫；runtime 侧 idle 与 mismatch 都收口到这一个 reasonCode。 */
const STOP_TARGET_CHANGED_REASON_CODE = "guard.stopTargetChanged";

function faultReasonCode(value: unknown): string | undefined {
  if (value instanceof Error) return value.message;
  if (typeof value === "string") return value;
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const candidate = value as { status?: unknown; reasonCode?: unknown };
  if (candidate.status !== undefined && candidate.status !== "stale") return undefined;
  return typeof candidate.reasonCode === "string" ? candidate.reasonCode : undefined;
}

/** row command/query 的权威 projection 已跨 revision/epoch/entity 时，统一走 same-sub recovery。 */
export function shouldResyncForStaleAuthority(value: unknown): boolean {
  return STALE_AUTHORITY_REASON_CODES.has(faultReasonCode(value) ?? "");
}

/**
 * stop 的目标守卫 noop 与 proto.stale 系列同源：`guard.stopTargetChanged` 说明 runtime
 * 当前的前台执行已经不是投影里那一个（不存在或已 abort），本地投影必然陈旧。
 *
 * 修复依据：修复前 `SessionPane.handleStop` 只在 promise reject 时打日志，而 noop 是
 * RPC 成功返回；生产构建下 renderer 日志不落盘，ACK 摘要只进有界调试缓冲，用户连点
 * 停止也毫无反应，会话永久停在幻影 running（2026-11-23 现场：`disposeWorkspace`
 * 回收在途轮次后卡住 34 分钟，23 次停止全部 noop）。
 * 这里把该 ACK 归入同一套 same-sub recovery 判定，不新增第二条恢复路径，
 * 也不放宽 CLI 侧 `expectedForegroundExecutionId` 的精确匹配。
 */
export function shouldRecoverFromStopTargetChanged(type: string, value: unknown): boolean {
  if (type !== "stop") return false;
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as { status?: unknown; reasonCode?: unknown };
  return candidate.status === "noop" && candidate.reasonCode === STOP_TARGET_CHANGED_REASON_CODE;
}
