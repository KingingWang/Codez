import { CodexRpcError, CodexTransportError } from "./rpc-errors.js";
import { z } from "zod";

export type BridgeStateDiagnostic =
  | {
      kind: "snapshotPrepared";
      deliveryKind: "initial" | "recovery";
      sessionId: string;
      subscriptionId: string;
      logEpoch: string;
      seq: number;
      phase: string;
      lastTurnId: string | null;
    }
  | {
      kind: "continueRejected";
      sessionId: string;
      commandId: string;
      nativeStatus: string;
      latestTurnStatus: string;
      selectedRunningTurnId: string;
      runningTurnCount: number;
      logEpoch: string;
      seq: number;
      revision: number;
    };

const diagnosticId = (value: string | null): string =>
  value && /^[A-Za-z0-9_-]{1,64}$/.test(value) ? value : "none";

/** stderr 只接受闭合枚举、计数与短 ID；原生文本不进入生产诊断。 */
export function formatBridgeStateDiagnostic(diagnostic: BridgeStateDiagnostic): string {
  if (diagnostic.kind === "snapshotPrepared") {
    const phase = new Set([
      "draft",
      "prewarming",
      "running",
      "completedSuccess",
      "completedInterrupted",
      "error",
    ]).has(diagnostic.phase)
      ? diagnostic.phase
      : "error";
    return `Codex desktop bridge state: snapshotPrepared; deliveryKind=${diagnostic.deliveryKind}; sessionId=${diagnosticId(diagnostic.sessionId)}; subscriptionId=${diagnosticId(diagnostic.subscriptionId)}; logEpoch=${diagnosticId(diagnostic.logEpoch)}; seq=${diagnostic.seq}; phase=${phase}; lastTurnId=${diagnosticId(diagnostic.lastTurnId)}\n`;
  }
  const nativeStatus = new Set(["notLoaded", "idle", "systemError", "active"]).has(
    diagnostic.nativeStatus,
  )
    ? diagnostic.nativeStatus
    : "unknown";
  const latestTurnStatus = new Set(["inProgress", "completed", "interrupted", "failed"]).has(
    diagnostic.latestTurnStatus,
  )
    ? diagnostic.latestTurnStatus
    : "unknown";
  return `Codex desktop bridge state: continueRejected; sessionId=${diagnosticId(diagnostic.sessionId)}; commandId=${diagnosticId(diagnostic.commandId)}; nativeStatus=${nativeStatus}; latestTurnStatus=${latestTurnStatus}; selectedRunningTurnId=${diagnosticId(diagnostic.selectedRunningTurnId)}; runningTurnCount=${diagnostic.runningTurnCount}; logEpoch=${diagnosticId(diagnostic.logEpoch)}; seq=${diagnostic.seq}; revision=${diagnostic.revision}\n`;
}

/** 诊断回调（含 stderr IO）失败不能影响 ACK、路由所有权或原生准入。 */
export function emitBridgeStateDiagnostic(
  emit: ((diagnostic: BridgeStateDiagnostic) => void) | undefined,
  diagnostic: BridgeStateDiagnostic,
): void {
  try {
    emit?.(diagnostic);
  } catch {
    /* 只读诊断不改变运行态 */
  }
}

export type BridgeFailureOrigin =
  | "startup"
  | "shutdown"
  | "host-protocol"
  | "native-transport"
  | "native-event"
  | "native-interaction"
  | "conversation-projection"
  | "sessions-index"
  | "workspace-config";

/** 生产包曾只输出笼统退出信息，无法区分第二轮投影与传输故障。
 * 仅输出固定分类/代码位置，不输出可能携带凭据、用户路径或消息 ID 的异常正文与堆栈。
 */
export function describeBridgeFailure(
  error: unknown,
  origin: BridgeFailureOrigin = "host-protocol",
): { category: string; origin: BridgeFailureOrigin; code?: number | string } {
  if (error instanceof CodexTransportError)
    return { category: "native-transport", origin, code: error.code };
  if (error instanceof CodexRpcError) return { category: "native-rpc", origin, code: error.code };
  if (error instanceof z.ZodError) return { category: "schema-validation", origin };
  const message = error instanceof Error ? error.message : "";
  const category =
    message.startsWith("Duplicate Codex item ID:") ||
    message.startsWith("Duplicate Codex item ID in turn ")
      ? "duplicate-item-id"
      : message === "Duplicate Codex thread ID in sessions index"
        ? "duplicate-thread-id"
        : "adapter-failure";
  return { category, origin };
}
