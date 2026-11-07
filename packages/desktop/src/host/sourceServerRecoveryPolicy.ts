import type { SourceServerConnectionStateSnapshot } from "@codez/shared";
import type { WindowRemoteConnectionCloseEvent } from "./windowRemoteConnectionRegistry.js";

export function isSourceServerAutomaticRecoveryTerminalState(
  state: SourceServerConnectionStateSnapshot | undefined,
): boolean {
  return (
    state?.state === "needs-install" ||
    state?.state === "needs-upgrade" ||
    state?.state === "identity-change-pending" ||
    (state?.state === "failed" && state.retryable === false)
  );
}

export function createSourceServerRecoveryCloseEvent(
  state: SourceServerConnectionStateSnapshot,
): WindowRemoteConnectionCloseEvent | undefined {
  if (
    state.state !== "retrying" &&
    state.state !== "offline" &&
    !isSourceServerAutomaticRecoveryTerminalState(state)
  ) {
    return undefined;
  }
  return {
    exitCode: null,
    signal: null,
    // Bug 原因：快速重试预算耗尽后 Manager 仍排有 2 分钟离线探测，旧投影却提前关闭
    // logical session，服务器随后恢复也只能手动重连。只有这组明确的探测事实可恢复；
    // 显式断开和 retryable:false 的 sibling/用户动作状态仍必须进入终态。
    recoverable:
      state.state === "retrying" ||
      (state.state === "offline" &&
        state.recoveryBudgetExhausted === true &&
        state.retryable === true),
    ...(state.error ? { error: state.error } : {}),
    ...(state.recoveryAttempt ? { recoveryAttempt: state.recoveryAttempt } : {}),
    ...(state.recoveryLimit ? { recoveryLimit: state.recoveryLimit } : {}),
    ...(state.recoveryBudgetExhausted !== undefined
      ? { recoveryBudgetExhausted: state.recoveryBudgetExhausted }
      : {}),
    ...(state.errorCode ? { reasonCode: state.errorCode } : {}),
    ...(state.retryable !== undefined ? { retryable: state.retryable } : {}),
  };
}
