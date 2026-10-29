import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { utilityProcess as electronUtilityProcess } from "electron";
import { hostCronRunMessageSchema, hostOffPeakRunMessageSchema } from "@codez/shared";
import { spawnCronScheduler } from "../src/main/desktopCronScheduler.js";

vi.mock("electron", () => ({
  utilityProcess: {
    fork: vi.fn(),
  },
}));

vi.mock("../src/main/desktopRuntimeEnv.js", () => ({
  buildHostProcessEnv: vi.fn(() => ({})),
  schedulerModulePath: "/tmp/codez-scheduler.js",
}));

class MockSchedulerProcess extends EventEmitter {
  pid: number | undefined = 12345;
  postMessage = vi.fn();
  kill = vi.fn(() => true);
}

describe("desktopCronScheduler", () => {
  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.clearAllMocks();
    vi.mocked(electronUtilityProcess.fork).mockReset();
  });

  it.each(["cron", "offpeak"] as const)(
    "forwards and validates the saved %s project directory snapshot",
    async (kind) => {
      const child = new MockSchedulerProcess();
      const host = { postMessage: vi.fn() };
      vi.mocked(electronUtilityProcess.fork).mockReturnValue(child as never);
      const scheduler = spawnCronScheduler({
        hostProcessLocalEnv: {},
        logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
        resolveDispatchHost: () => host as never,
      });
      const execution = {
        workspacePath: "/frozen",
        workspaceIdentity: "remote:server:s:/frozen",
        projectId: "p",
        hostId: "remote:server:s",
        additionalDirectories: [],
      };
      child.emit("message", {
        ...execution,
        type: `${kind}-dispatch-request`,
        prompt: "run",
        ...(kind === "cron"
          ? { automationId: "a", runId: "r" }
          : {
              offPeakTaskId: "o",
              permissionMode: "default",
              modelSelection: { providerId: "p", modelId: "m" },
            }),
      });
      const frame = host.postMessage.mock.calls[0]?.[0];
      expect(frame).toMatchObject(execution);
      expect(
        (kind === "cron" ? hostCronRunMessageSchema : hostOffPeakRunMessageSchema).parse(frame),
      ).toMatchObject(execution);
      const disposing = scheduler.dispose();
      child.emit("exit", 0);
      await disposing;
    },
  );

  it("立即执行时直接向 scheduler 发送 wake 消息", () => {
    const child = new MockSchedulerProcess();
    vi.mocked(electronUtilityProcess.fork).mockReturnValue(child as never);

    const scheduler = spawnCronScheduler({
      hostProcessLocalEnv: {},
      logger: {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      },
      resolveDispatchHost: () => null,
    });

    scheduler.wake("automation-1");

    expect(child.postMessage).toHaveBeenCalledWith({
      type: "scheduler-wake",
      automationId: "automation-1",
    });
  });

  it.each(["cron", "offpeak"] as const)("按 %s 的完整目标选择 Host", async (kind) => {
    const child = new MockSchedulerProcess();
    const host = { postMessage: vi.fn() };
    vi.mocked(electronUtilityProcess.fork).mockReturnValue(child as never);
    const resolveDispatchHost = vi.fn(() => host as never);
    const scheduler = spawnCronScheduler({
      hostProcessLocalEnv: {},
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      resolveDispatchHost,
    });
    const target = {
      workspacePath: "/same-path",
      workspaceIdentity: "remote:server:second:/same-path",
      hostId: "remote:server:second",
    };
    child.emit("message", {
      type: `${kind}-dispatch-request`,
      ...target,
      automationId: "a",
      runId: "r",
      offPeakTaskId: "o",
      prompt: "test",
    });
    expect(resolveDispatchHost).toHaveBeenCalledWith(expect.objectContaining(target));
    const disposing = scheduler.dispose();
    child.emit("exit", 0);
    await disposing;
  });

  it("退出后只启动一个替代进程，旧消息不能再派发，稳定 handle 转发给新进程", async () => {
    vi.useFakeTimers();
    const first = new MockSchedulerProcess();
    const second = new MockSchedulerProcess();
    const host = { postMessage: vi.fn() };
    vi.mocked(electronUtilityProcess.fork)
      .mockReturnValueOnce(first as never)
      .mockReturnValueOnce(second as never);
    const scheduler = spawnCronScheduler({
      hostProcessLocalEnv: {},
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      resolveDispatchHost: () => host as never,
    });
    first.emit("exit", 1);
    first.emit("exit", 1);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(electronUtilityProcess.fork).toHaveBeenCalledTimes(2);
    const message = {
      type: "cron-dispatch-request",
      automationId: "a",
      runId: "r",
      prompt: "test",
      workspacePath: "/project",
    };
    first.emit("message", message);
    expect(host.postMessage).not.toHaveBeenCalled();
    second.emit("message", message);
    expect(host.postMessage).toHaveBeenCalledOnce();
    scheduler.wake("a");
    scheduler.handleCronRunResult({ runId: "r", ok: true });
    expect(second.postMessage).toHaveBeenCalledWith({ type: "scheduler-wake", automationId: "a" });
    expect(second.postMessage).toHaveBeenCalledWith({
      type: "cron-dispatch-result",
      runId: "r",
      ok: true,
    });
    const disposing = scheduler.dispose();
    second.emit("exit", 0);
    await disposing;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(electronUtilityProcess.fork).toHaveBeenCalledTimes(2);
  });

  it("fork 失败保留稳定 handle，指数退避有上限，退出取消待重启", async () => {
    vi.useFakeTimers();
    vi.mocked(electronUtilityProcess.fork).mockImplementation(() => {
      throw new Error("fork failed");
    });
    const scheduler = spawnCronScheduler({
      hostProcessLocalEnv: {},
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      resolveDispatchHost: () => null,
    });
    expect(electronUtilityProcess.fork).toHaveBeenCalledTimes(1);
    for (const delay of [1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000]) {
      const before = vi.mocked(electronUtilityProcess.fork).mock.calls.length;
      await vi.advanceTimersByTimeAsync(delay - 1);
      expect(electronUtilityProcess.fork).toHaveBeenCalledTimes(before);
      await vi.advanceTimersByTimeAsync(1);
      expect(electronUtilityProcess.fork).toHaveBeenCalledTimes(before + 1);
    }
    await scheduler.dispose();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(electronUtilityProcess.fork).toHaveBeenCalledTimes(8);
  });

  it("稳定存活后重置退避；旧退出不能停止替代进程", async () => {
    vi.useFakeTimers();
    const children = [
      new MockSchedulerProcess(),
      new MockSchedulerProcess(),
      new MockSchedulerProcess(),
    ];
    vi.mocked(electronUtilityProcess.fork)
      .mockReturnValueOnce(children[0] as never)
      .mockReturnValueOnce(children[1] as never)
      .mockReturnValueOnce(children[2] as never);
    const scheduler = spawnCronScheduler({
      hostProcessLocalEnv: {},
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      resolveDispatchHost: () => null,
    });
    children[0]!.emit("exit", 1);
    await vi.advanceTimersByTimeAsync(1_000);
    await vi.advanceTimersByTimeAsync(60_000);
    children[1]!.emit("exit", 1);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(electronUtilityProcess.fork).toHaveBeenCalledTimes(3);
    children[0]!.emit("exit", 1);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(electronUtilityProcess.fork).toHaveBeenCalledTimes(3);
    const disposing = scheduler.dispose();
    expect(scheduler.dispose()).toBe(disposing);
    children[2]!.emit("exit", 0);
    await disposing;
  });

  it("进入退出状态后停止向 Host 派发新任务", async () => {
    const child = new MockSchedulerProcess();
    const host = { postMessage: vi.fn() };
    vi.mocked(electronUtilityProcess.fork).mockReturnValue(child as never);
    const scheduler = spawnCronScheduler({
      hostProcessLocalEnv: {},
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      resolveDispatchHost: () => host as never,
    });

    const disposing = scheduler.dispose();
    child.emit("message", {
      type: "cron-dispatch-request",
      runId: "run-after-dispose",
      automationId: "automation-1",
      prompt: "test",
      workspacePath: "C:/repo",
    });

    expect(host.postMessage).not.toHaveBeenCalled();
    expect(child.postMessage).toHaveBeenCalledWith({
      type: "cron-dispatch-result",
      runId: "run-after-dispose",
      ok: false,
      failureKind: "transient",
      error: "app is shutting down",
    });
    child.emit("exit", 0);
    await disposing;
  });

  it("把 scheduler 自采样本交给资源遥测来源，非法样本丢弃", async () => {
    const { selfHeapProcessResourceSampleSource } =
      await import("../src/main/processResourceSelfHeapSource.js");
    selfHeapProcessResourceSampleSource.reset?.();
    const child = new MockSchedulerProcess();
    vi.mocked(electronUtilityProcess.fork).mockReturnValue(child as never);
    spawnCronScheduler({
      hostProcessLocalEnv: {},
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      resolveDispatchHost: () => null,
    });

    // 字段缺失的样本在 main 入口丢弃，不抛错。
    expect(() =>
      child.emit("message", {
        type: "scheduler-resource-sample",
        sample: { cpuPercent: 1, rssKb: 122_880 },
      }),
    ).not.toThrow();
    child.emit("message", {
      type: "scheduler-resource-sample",
      sample: { cpuPercent: 1, rssKb: 122_880, heapUsedKb: 24_576 },
    });

    const heapSamples: Array<[string, number]> = [];
    selfHeapProcessResourceSampleSource.sample?.({
      now: 0,
      addRoleSample: () => {},
      addRoleHeapSample: (role, heapUsedKb) => heapSamples.push([role, heapUsedKb]),
      addAppProcessTotals: () => {},
    });

    expect(heapSamples).toEqual([["scheduler", 24_576]]);
  });
});
