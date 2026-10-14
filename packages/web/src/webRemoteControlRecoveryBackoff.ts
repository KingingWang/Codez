/**
 * bridge 降级驱动的恢复退避。
 *
 * 背景（2026-10-14 生产日志）：bridge 因 rpc replay buffer 溢出降级后，手机立即
 * 全量恢复（bootstrap + workspace-list + 会话快照），恢复洪水再次打爆 buffer，
 * 形成 12~17 秒一轮的"降级→恢复→再降级"活锁，手机永远停在重连/空白页，
 * 且整段过程维持数百 KB/s 的异常流量。
 *
 * 压缩与推送节流降低单轮洪水量之后，这里再加最后一道保险：同一滑动窗口内
 * 连续降级次数越多，下一次自动恢复等待越久，让手机 ACK 有机会排空、桌面负载
 * 有机会回落。窗口内无降级一段时间后自动清零，真正偶发的单次降级不受影响。
 */

export const BRIDGE_DEGRADATION_BACKOFF_WINDOW_MS = 120_000;
export const BRIDGE_DEGRADATION_BACKOFF_MIN_DELAY_MS = 5_000;
export const BRIDGE_DEGRADATION_BACKOFF_MAX_DELAY_MS = 30_000;
/** 前两次降级立即恢复（偶发故障不应让用户等待），第三次起开始退避。 */
export const BRIDGE_DEGRADATION_BACKOFF_FREE_RECOVERIES = 2;

export interface WebRemoteControlRecoveryBackoff {
  /** 记录一次 bridge 降级，返回本次自动恢复应延迟的毫秒数（0 = 立即恢复）。 */
  noteDegradation(): number;
  /** 生命周期恢复（回前台/手动刷新）后清零：用户在场时按最快路径恢复。 */
  reset(): void;
}

export function createWebRemoteControlRecoveryBackoff(
  now: () => number = Date.now,
): WebRemoteControlRecoveryBackoff {
  let degradedAt: number[] = [];
  return {
    noteDegradation(): number {
      const current = now();
      degradedAt = degradedAt.filter(
        (at) => current - at < BRIDGE_DEGRADATION_BACKOFF_WINDOW_MS,
      );
      degradedAt.push(current);
      const excess = degradedAt.length - BRIDGE_DEGRADATION_BACKOFF_FREE_RECOVERIES;
      if (excess <= 0) return 0;
      return Math.min(
        BRIDGE_DEGRADATION_BACKOFF_MAX_DELAY_MS,
        BRIDGE_DEGRADATION_BACKOFF_MIN_DELAY_MS * 2 ** (excess - 1),
      );
    },
    reset(): void {
      degradedAt = [];
    },
  };
}
