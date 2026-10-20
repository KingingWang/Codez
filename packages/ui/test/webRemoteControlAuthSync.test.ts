// @vitest-environment jsdom
import { cleanup, renderHook } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { Emitter } from "@codez/rpc";
import { useWebRemoteControlAuthSync } from "@/web-remote-control/app/useWebRemoteControlAuthSync.js";

afterEach(cleanup);
it("初始恢复后转发凭据完成事件，不依赖 UI 用户或成功计数更新；卸载取消订阅", () => {
  const session = new Emitter<"signed-in" | "signed-out">();
  const oauth = { onDidChangeSession: session.event };
  const notifyWebRemoteControlAuthStateChanged = vi.fn();
  const platform = { notifyWebRemoteControlAuthStateChanged };
  const { rerender, unmount } = renderHook(
    ({ userId, restoring }) => useWebRemoteControlAuthSync(platform, oauth, userId, restoring),
    {
      initialProps: { userId: "" as string | undefined, restoring: true },
    },
  );
  expect(notifyWebRemoteControlAuthStateChanged).not.toHaveBeenCalled();
  rerender({ userId: "user", restoring: false });
  session.fire("signed-out");
  // 设置后处理失败时 UI 用户仍是 user，完成事件也必须立即送到 Main。
  session.fire("signed-in");
  session.fire("signed-in");
  rerender({ userId: undefined, restoring: false });
  unmount();
  session.fire("signed-out");
  expect(notifyWebRemoteControlAuthStateChanged.mock.calls).toEqual([
    [{ state: "signed-in" }],
    [{ state: "signed-out" }],
    [{ state: "signed-in" }],
    [{ state: "signed-in" }],
  ]);
});

it("没有桌面平台通知能力时不订阅远端 OAuth 事件", () => {
  const onDidChangeSession = vi.fn();
  renderHook(() => useWebRemoteControlAuthSync({}, { onDidChangeSession }, "user", false));
  expect(onDidChangeSession).not.toHaveBeenCalled();
});

it("Codex 启动模式：初始投影静默读取缓存会话，落定前不按 UI user=null 抢先投影 signed-out", async () => {
  const session = new Emitter<"signed-in" | "signed-out">();
  const oauth = { onDidChangeSession: session.event };
  const notifyWebRemoteControlAuthStateChanged = vi.fn();
  const platform = { notifyWebRemoteControlAuthStateChanged };
  let resolveRestore: ((value: string | undefined) => void) | undefined;
  const resolveInitialAuthUserId = vi.fn(
    () =>
      new Promise<string | undefined>((resolve) => {
        resolveRestore = resolve;
      }),
  );
  const { rerender } = renderHook(
    ({ restoring }) =>
      useWebRemoteControlAuthSync(platform, oauth, undefined, restoring, resolveInitialAuthUserId),
    { initialProps: { restoring: true } },
  );
  // 启动恢复进行中不能消费 resolver。
  expect(resolveInitialAuthUserId).not.toHaveBeenCalled();
  rerender({ restoring: false });
  expect(resolveInitialAuthUserId).toHaveBeenCalledTimes(1);
  // resolver 未落定前不能按 root user=null 误投影 signed-out（Codex 模式 root user 恒为 null）。
  expect(notifyWebRemoteControlAuthStateChanged).not.toHaveBeenCalled();
  resolveRestore?.("user-1");
  await vi.waitFor(() => {
    expect(notifyWebRemoteControlAuthStateChanged).toHaveBeenCalledWith({ state: "signed-in" });
  });
  expect(notifyWebRemoteControlAuthStateChanged).toHaveBeenCalledTimes(1);
});

it("Codex 启动模式：缓存会话缺失或读取失败时投影 signed-out", async () => {
  const session = new Emitter<"signed-in" | "signed-out">();
  const oauth = { onDidChangeSession: session.event };
  const notifyWebRemoteControlAuthStateChanged = vi.fn();
  const platform = { notifyWebRemoteControlAuthStateChanged };
  const { unmount } = renderHook(() =>
    useWebRemoteControlAuthSync(platform, oauth, undefined, false, async () => undefined),
  );
  await vi.waitFor(() => {
    expect(notifyWebRemoteControlAuthStateChanged).toHaveBeenCalledWith({ state: "signed-out" });
  });
  unmount();

  notifyWebRemoteControlAuthStateChanged.mockClear();
  renderHook(() =>
    useWebRemoteControlAuthSync(platform, oauth, undefined, false, async () => {
      throw new Error("decrypt failed");
    }),
  );
  await vi.waitFor(() => {
    expect(notifyWebRemoteControlAuthStateChanged).toHaveBeenCalledWith({ state: "signed-out" });
  });
});

it("Codex 启动模式：卸载后静默恢复落定不再通知 Main", async () => {
  const session = new Emitter<"signed-in" | "signed-out">();
  const oauth = { onDidChangeSession: session.event };
  const notifyWebRemoteControlAuthStateChanged = vi.fn();
  const platform = { notifyWebRemoteControlAuthStateChanged };
  let resolveRestore: ((value: string | undefined) => void) | undefined;
  const { unmount } = renderHook(() =>
    useWebRemoteControlAuthSync(
      platform,
      oauth,
      undefined,
      false,
      () =>
        new Promise<string | undefined>((resolve) => {
          resolveRestore = resolve;
        }),
    ),
  );
  unmount();
  resolveRestore?.("user-1");
  // 宏任务冲刷整条 promise 链，确保落定回调有机会执行。
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(notifyWebRemoteControlAuthStateChanged).not.toHaveBeenCalled();
});
