/**
 * 主窗口 renderer 原生崩溃后的有界恢复策略。
 *
 * 背景：Chromium 杀掉 renderer（SIGTRAP/OOM 等）后 BrowserWindow 仍存活，但页面
 * （含 renderer 侧启动看门狗）已随进程消失；Linux/Windows 上没有任何入口会再触发
 * 重建，用户只会看到一个永久无响应的空窗口（真实桌面复现：资源受限宿主上 reload
 * 触发 renderer crash，exit code 133）。macOS 依赖 activate 时丢弃崩溃窗口重建，
 * 其他平台没有等价路径。
 *
 * 策略：对可恢复原因做有界原地 reload，保留窗口、会话与 Host attachment；
 * 超过预算后停止自动 reload 并明确告警，避免崩溃循环。
 *
 * 恢复优先级：本模块的原地 reload 是第一道恢复，全平台生效；
 * primaryWindowCoordinator 的「丢弃崩溃窗口并重建」只是最后兜底
 * （macOS 在 activate 时触发，其他平台仅在再次请求主窗口时触发）。
 * 延迟与存活性策略也属于本模块，避免散落在 Main 的大文件里。
 */
export const RECOVERABLE_RENDERER_CRASH_REASONS = new Set([
  "crashed",
  "killed",
  "oom",
  "launch-failed",
]);

export type RendererCrashRecoveryOutcome = "reloaded" | "budget-exhausted" | "ignored";

export interface RendererCrashRecovery {
  handle(details: { reason?: string }): RendererCrashRecoveryOutcome;
  readonly autoReloadCount: number;
}

export function createRendererCrashRecovery(input: {
  reload: () => void;
  /** 延迟到期后的存活性判定；缺省视为可 reload。 */
  canReload?: () => boolean;
  /** 可注入的调度器，便于测试验证延迟与竞态。 */
  schedule?: (task: () => void, delayMs: number) => void;
  reloadDelayMs?: number;
  isQuitting: () => boolean;
  logger: { warn(message: string, payload?: unknown): void };
  maxAutoReloads?: number;
}): RendererCrashRecovery {
  const maxAutoReloads = input.maxAutoReloads ?? 2;
  const reloadDelayMs = input.reloadDelayMs ?? 1000;
  const schedule =
    input.schedule ?? ((task: () => void, delayMs: number) => setTimeout(task, delayMs));
  let autoReloadCount = 0;
  return {
    get autoReloadCount() {
      return autoReloadCount;
    },
    handle(details) {
      const reason = details.reason ?? "unknown";
      if (input.isQuitting() || !RECOVERABLE_RENDERER_CRASH_REASONS.has(reason)) {
        return "ignored";
      }
      if (autoReloadCount >= maxAutoReloads) {
        input.logger.warn("[renderer-crash] auto reload budget exhausted; window left crashed", {
          reason,
          autoReloadCount,
        });
        return "budget-exhausted";
      }
      autoReloadCount += 1;
      input.logger.warn("[renderer-crash] renderer crashed; reloading window in place", {
        reason,
        attempt: autoReloadCount,
        maxAutoReloads,
      });
      // 崩溃回调里同步 reload 可能命中尚未收尾的 WebContents；延迟一个宏任务，
      // 到期后复查退出态与存活性，失败只告警不再抛。
      schedule(() => {
        if (input.isQuitting()) return;
        if (input.canReload && !input.canReload()) {
          input.logger.warn("[renderer-crash] deferred reload skipped; window already gone", {
            reason,
          });
          return;
        }
        try {
          input.reload();
        } catch (error) {
          input.logger.warn("[renderer-crash] deferred reload failed", {
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }, reloadDelayMs);
      return "reloaded";
    },
  };
}
