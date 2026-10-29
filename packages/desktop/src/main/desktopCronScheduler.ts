// desktop main 侧的 cron scheduler 进程管理器。
// 职责：拉起/恢复/销毁常驻 scheduler；按目标 attachment 路由给所属窗口 Host（转成 CronRun）；
// 把 host 回报的 CronRunResult 转回 scheduler 结算。scheduler 只碰 tasks-index，createTask 在 host 域执行。
import { utilityProcess as electronUtilityProcess } from "electron";
import type { UtilityProcess as ElectronUtilityProcess } from "electron";
import { HostMessageTypes } from "@codez/shared";
import { buildHostProcessEnv, schedulerModulePath } from "./desktopRuntimeEnv.js";
import { ingestSchedulerSelfResourceSample } from "./processResourceSelfHeapSource.js";
import { registerSchedulerProcess, unregisterSchedulerProcess } from "./resourceManagerWindow.js";
import type {
  MainToSchedulerMessage,
  SchedulerToMainMessage,
} from "../scheduler/schedulerProtocol.js";

export interface CronRunResultPayload {
  runId: string;
  ok: boolean;
  taskId?: string;
  sessionId?: string;
  error?: string;
  failureKind?: "transient" | "permanent";
}

/** host → main 的闲时任务派发结果（与 cron 消息独立）。 */
export interface OffPeakRunResultPayload {
  offPeakTaskId: string;
  ok: boolean;
  lifecycleManaged?: true;
  conversationId?: string;
  sessionId?: string;
  error?: string;
  failureKind?: "transient" | "permanent";
}

interface CronSchedulerDeps {
  hostProcessLocalEnv: Record<string, string>;
  logger: {
    info: (...args: unknown[]) => void;
    warn: (...args: unknown[]) => void;
    error: (...args: unknown[]) => void;
  };
  /** 按目标 attachment 选窗口 Host；远端不可用时返回 null，禁止回落本机。 */
  resolveDispatchHost: (target: {
    workspacePath: string;
    workspaceIdentity?: string;
    hostId?: string;
  }) => ElectronUtilityProcess | null;
  /** 闲时任务执行中计数变化（keep-awake：main 据此 + 设置切 powerSaveBlocker）。 */
  onOffPeakActiveCountChanged?: (count: number) => void;
}

export interface CronSchedulerHandle {
  /** host 回报派发结果时调用，转交给 scheduler 结算。 */
  handleCronRunResult: (result: CronRunResultPayload) => void;
  /** host 回报闲时任务派发结果时调用，转交给 scheduler 结算。 */
  handleOffPeakRunResult: (result: OffPeakRunResultPayload) => void;
  /** manual run 落库后立即唤醒 scheduler，不等待下一次轮询。 */
  wake: (automationId: string) => void;
  /** app 退出前优雅收尾（通知 scheduler 释放认领 + 关库，兜底强杀）。 */
  dispose: () => Promise<void>;
}

const DISPOSE_FORCE_KILL_MS = 1_500;
const RESTART_INITIAL_DELAY_MS = 1_000;
const RESTART_MAX_DELAY_MS = 30_000;
const STABLE_UPTIME_MS = 60_000;

export function spawnCronScheduler(deps: CronSchedulerDeps): CronSchedulerHandle {
  let currentChild: ElectronUtilityProcess | null = null;
  let isDisposing = false;
  let disposePromise: Promise<void> | null = null;
  let restartTimer: ReturnType<typeof setTimeout> | undefined;
  let restartAttempts = 0;

  const postToScheduler = (message: MainToSchedulerMessage): void => {
    if (!currentChild) return;
    try {
      currentChild.postMessage(message);
    } catch (error) {
      deps.logger.warn("[cron-scheduler] postMessage to scheduler failed:", error);
    }
  };

  function scheduleRestart(): void {
    if (isDisposing || restartTimer !== undefined) return;
    // 原因：scheduler 崩溃/首次 fork 失败后旧 handle 永久失效。
    // Main 只恢复进程，不缓存业务回执；替代进程复用 SQLite claim/correlation 防止重复发送。
    const delay = Math.min(RESTART_INITIAL_DELAY_MS * 2 ** restartAttempts, RESTART_MAX_DELAY_MS);
    restartAttempts = Math.min(restartAttempts + 1, 5);
    deps.logger.warn(`[cron-scheduler] restarting scheduler in ${delay}ms`);
    restartTimer = setTimeout(() => {
      restartTimer = undefined;
      startChild();
    }, delay);
    restartTimer.unref?.();
  }

  function startChild(): void {
    if (isDisposing) return;
    let child: ElectronUtilityProcess;
    try {
      child = electronUtilityProcess.fork(schedulerModulePath, [], {
        serviceName: "codez-cron-scheduler",
        execArgv: ["--no-warnings"],
        env: {
          ...buildHostProcessEnv(deps.hostProcessLocalEnv),
          CODEZ_PROCESS_LABEL: "scheduler",
        },
      });
    } catch (error) {
      deps.logger.error("[cron-scheduler] failed to fork scheduler process:", error);
      scheduleRestart();
      return;
    }
    currentChild = child;
    const startedAt = Date.now();
    deps.logger.info(`[cron-scheduler] forked scheduler process pid=${child.pid}`);
    registerSchedulerProcess(child);

    child.on("message", (raw: unknown) => {
      // 原因：旧进程退出后的迟到消息不能路由给新进程或新 Host。
      if (currentChild !== child) return;
      const msg = raw as SchedulerToMainMessage;
      if (!msg || typeof msg !== "object") return;

      if (msg.type === "scheduler-log") {
        const level = msg.level === "warn" ? "warn" : msg.level === "error" ? "error" : "info";
        deps.logger[level](`[cron-scheduler] ${msg.message}`);
        return;
      }

      if (msg.type === "offpeak-active-count") {
        deps.onOffPeakActiveCountChanged?.(msg.count);
        return;
      }

      // scheduler 自采的 60 秒样本：main 只取 heap 作 scheduler 角色事件的 heap 维度，
      // 非法样本在入口按 schema 丢弃。
      if (msg.type === "scheduler-resource-sample") {
        ingestSchedulerSelfResourceSample(msg.sample);
        return;
      }

      if (msg.type === "cron-dispatch-request") {
        if (isDisposing) {
          // App 退出时 Cron 与 Host 并行收口；进入 disposing 后继续派发会把新任务
          // 发送给正在关闭的 Host。明确拒绝派发，避免为了保持串行而额外增加 1.5 秒退出延迟。
          postToScheduler({
            type: "cron-dispatch-result",
            runId: msg.runId,
            ok: false,
            failureKind: "transient",
            error: "app is shutting down",
          });
          return;
        }
        const host = deps.resolveDispatchHost(msg);
        if (!host) {
          // 没有可派发的本地 host（无窗口/未就绪）：按 transient 回执，scheduler 退避后重试。
          postToScheduler({
            type: "cron-dispatch-result",
            runId: msg.runId,
            ok: false,
            failureKind: "transient",
            error: "no local host available",
          });
          return;
        }
        try {
          host.postMessage({
            type: HostMessageTypes.CronRun,
            automationId: msg.automationId,
            runId: msg.runId,
            prompt: msg.prompt,
            targetTaskId: msg.targetTaskId,
            modelSelection: msg.modelSelection,
            mode: msg.mode,
            workspacePath: msg.workspacePath,
            workspaceIdentity: msg.workspaceIdentity,
            projectId: msg.projectId,
            hostId: msg.hostId,
            additionalDirectories: msg.additionalDirectories,
          });
        } catch (error) {
          deps.logger.warn("[cron-scheduler] forward CronRun to host failed:", error);
          postToScheduler({
            type: "cron-dispatch-result",
            runId: msg.runId,
            ok: false,
            failureKind: "transient",
            error: error instanceof Error ? error.message : String(error),
          });
        }
        return;
      }

      if (msg.type === "offpeak-dispatch-request") {
        const host = deps.resolveDispatchHost(msg);
        if (!host) {
          // 无可用 host：transient 回执，scheduler 按 off-peak 独立退避重试（顺延不丢弃）。
          postToScheduler({
            type: "offpeak-dispatch-result",
            offPeakTaskId: msg.offPeakTaskId,
            ok: false,
            failureKind: "transient",
            error: "no local host available",
          });
          return;
        }
        try {
          host.postMessage({
            type: HostMessageTypes.OffPeakRun,
            offPeakTaskId: msg.offPeakTaskId,
            prompt: msg.prompt,
            permissionMode: msg.permissionMode,
            modelSelection: msg.modelSelection,
            conversationId: msg.conversationId,
            sessionId: msg.sessionId,
            serverTicketId: msg.serverTicketId,
            workspacePath: msg.workspacePath,
            workspaceIdentity: msg.workspaceIdentity,
            projectId: msg.projectId,
            hostId: msg.hostId,
            additionalDirectories: msg.additionalDirectories,
          });
        } catch (error) {
          deps.logger.warn("[cron-scheduler] forward OffPeakRun to host failed:", error);
          postToScheduler({
            type: "offpeak-dispatch-result",
            offPeakTaskId: msg.offPeakTaskId,
            ok: false,
            failureKind: "transient",
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    });

    child.once("exit", (code) => {
      unregisterSchedulerProcess(child);
      if (currentChild !== child) return;
      currentChild = null;
      deps.logger.info(`[cron-scheduler] scheduler process exited code=${code}`);
      if (Date.now() - startedAt >= STABLE_UPTIME_MS) restartAttempts = 0;
      scheduleRestart();
    });
  }

  startChild();

  return {
    handleCronRunResult(result) {
      postToScheduler({ type: "cron-dispatch-result", ...result });
    },
    handleOffPeakRunResult(result) {
      postToScheduler({ type: "offpeak-dispatch-result", ...result });
    },
    wake(automationId) {
      if (isDisposing) return;
      postToScheduler({ type: "scheduler-wake", automationId });
    },
    dispose() {
      if (disposePromise) return disposePromise;
      isDisposing = true;
      if (restartTimer !== undefined) clearTimeout(restartTimer);
      restartTimer = undefined;
      const child = currentChild;
      if (!child) {
        disposePromise = Promise.resolve();
        return disposePromise;
      }
      disposePromise = new Promise<void>((resolve) => {
        let settled = false;
        const done = () => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve();
        };
        const timer = setTimeout(() => {
          try {
            child.kill();
          } catch {
            // 忽略。
          }
          done();
        }, DISPOSE_FORCE_KILL_MS);
        child.once("exit", done);
        // 先监听 exit 再发 dispose，避免同步/快速退出丢失 ACK。
        postToScheduler({ type: "scheduler-dispose" });
      });
      return disposePromise;
    },
  };
}
