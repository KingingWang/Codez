import { WEB_REMOTE_CONTROL_RPC_TRANSPORT_LIMITS } from "@codez/shared";
import type { WebRemoteControlPayloadSendResult } from "@codez/client";
import type {
  WebRemoteControlTerminalTransportDiagnostic,
  WebRemoteControlTerminalTransportDiagnosticInput,
} from "#src/web-remote-control/contracts/transport.js";

/**
 * WebRemoteControlTerminalTransport 的无状态诊断/预算投影助手。
 *
 * 这里只承载「按入参计算、不持有 socket、加密或 socketGeneration 状态」的纯逻辑：
 * pair-status 诊断去重与浏览器环境快照、relay 出站帧物理预算判定、开发态 trace 输出。
 * 连接生命周期与配对状态机的唯一所有者仍然是 transport 类本身，本模块只读它投影出来的
 * 两个诊断字段，因此拆分前后行为逐语句等价（架构 max-file-lines 上限 800 行是唯一动机）。
 */

/** transport 投影给诊断助手的可变诊断状态（结构化只读视图，不转移所有权）。 */
export interface TerminalDiagnosticState {
  readonly hiddenStartedAt?: number;
  readonly lastPairStatusDiagnostic?: string;
}

export interface TerminalDiagnosticProjection {
  readonly hiddenStartedAt?: number;
  readonly lastPairStatusDiagnostic?: string;
  readonly diagnostic: WebRemoteControlTerminalTransportDiagnostic;
}

/**
 * 计算一次诊断投影：pair-status 与上一次完全相同则返回 null（调用方直接丢弃），
 * 否则返回补充了时间戳、可见性、在线状态与隐藏时长的最终诊断，以及需要回写的诊断状态。
 */
export function projectTerminalDiagnostic(
  diagnostic: WebRemoteControlTerminalTransportDiagnosticInput,
  state: TerminalDiagnosticState,
  now: number,
): TerminalDiagnosticProjection | null {
  let lastPairStatusDiagnostic = state.lastPairStatusDiagnostic;
  if (diagnostic.type === "pair-status") {
    const nextPairStatusDiagnostic = `${diagnostic.state}:${diagnostic.pairStatus ?? "unknown"}`;
    if (lastPairStatusDiagnostic === nextPairStatusDiagnostic) {
      return null;
    }
    lastPairStatusDiagnostic = nextPairStatusDiagnostic;
  }
  const visibilityState = typeof document === "undefined" ? "unknown" : document.visibilityState;
  const hiddenDurationMs =
    state.hiddenStartedAt && visibilityState !== "hidden" ? now - state.hiddenStartedAt : undefined;
  return {
    hiddenStartedAt: hiddenDurationMs === undefined ? state.hiddenStartedAt : undefined,
    lastPairStatusDiagnostic,
    diagnostic: {
      ...diagnostic,
      timestamp: now,
      visibilityState,
      online: typeof navigator === "undefined" ? true : navigator.onLine,
      ...(hiddenDurationMs !== undefined ? { hiddenDurationMs } : {}),
    } as WebRemoteControlTerminalTransportDiagnostic,
  };
}

/** relay 出站帧是否仍在物理帧预算内（与 sendPayloadResult 的 oversize 判定同源常量）。 */
export function isRelayFrameWithinPhysicalBudget(serialized: string): boolean {
  return (
    new TextEncoder().encode(serialized).byteLength <=
    WEB_REMOTE_CONTROL_RPC_TRANSPORT_LIMITS.maxPhysicalFrameBytes
  );
}

/** relay 入站帧字节数是否仍在物理帧预算内；超限由调用方上报 raw transport fault。 */
export function isRelayIngressWithinPhysicalBudget(byteLength: number): boolean {
  return byteLength <= WEB_REMOTE_CONTROL_RPC_TRANSPORT_LIMITS.maxPhysicalFrameBytes;
}

/** 出站帧超出物理预算时的永久性失败结果（不做重试，与 sendPayloadResult 语义一致）。 */
export function createOversizePayloadSendResult(bytes: number): WebRemoteControlPayloadSendResult {
  return {
    kind: "oversize",
    bytes,
    maxBytes: WEB_REMOTE_CONTROL_RPC_TRANSPORT_LIMITS.maxPhysicalFrameBytes,
  };
}

/**
 * Bugfix: 远控 relay 消息量高，生产环境打印正文会快速放大日志体积并暴露敏感内容。
 * 这里只在开发态输出摘要字段，排查链路足够且不会污染线上日志（开关由调用方持有）。
 */
export function emitRelayMessageTrace(
  direction: "send" | "recv",
  fields: Record<string, unknown>,
): void {
  console.info("[web-remote-control][relay-message]", {
    direction,
    ...fields,
  });
}
