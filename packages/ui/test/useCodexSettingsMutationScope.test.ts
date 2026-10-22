// @vitest-environment jsdom

// Bugfix 回归（spec: codex-provider-runtime-env-key「设置页保存事务与 Agent 重启的时序」）：
// 远端 SSH workspace 选「本机保存」新增供应商时，Key 轮换屏障在 prepareKeySource 内
// 主动停止远端 Agent 并发布 runtimeRestarted，这发生在 config/batchWrite 之前。
// 旧实现收到事件立刻换读投影代际，面板持有的旧写入闭包随即被身份守卫作废：
// prepareKeySource / finishKeySource 双双 OK、本机凭据与注册表已写，但 config/batchWrite
// 从未发出，远端 config.toml 一步未改，供应商在重读后消失，UI 无任何提示。
import { act, renderHook, waitFor } from "@testing-library/react";
import { Emitter } from "@codez/rpc";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useCodexSettings } from "@/hooks/useCodexSettings.js";

const restartEvents = new Emitter<{ workspaceKey: string }>();
const invalidateCodexModelCatalog = vi.fn();
const warn = vi.fn();

vi.mock("@/logger.js", () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: (...args: unknown[]) => warn(...args),
    error: vi.fn(),
  },
}));

vi.mock("@/hooks/useCodexModelCatalog.js", () => ({
  invalidateCodexModelCatalog: () => invalidateCodexModelCatalog(),
}));

// 读投影的 zod 解析不是本回归的对象；只验证 scope/代际与写入身份的时序契约。
vi.mock("@/settings/codex/codexSettingsData.js", () => ({
  readCodexResource: vi.fn(async () => ({ data: [] })),
}));

const harness = {
  resolution: {
    services: {} as never,
    remoteSessionId: null as string | null,
    isRemoteTarget: true,
    connectionKind: "remote-ready" as const,
    rpcReady: true,
  },
};

vi.mock("@/hooks/useWorkspaceServices.js", () => ({
  useWorkspaceServicesResolution: () => harness.resolution,
}));

const REMOTE_PATH = "/home/linuxtest/szs/test/linux-ut";
const REMOTE_IDENTITY = "remote:server:d4f31cae:/home/linuxtest/szs/test/linux-ut";
const WRITE_OK = {
  status: "ok",
  version: "v2",
  filePath: "/home/linuxtest/.codex/config.toml",
  overriddenMetadata: null,
};

function installAgent(behavior: (params: { method: string }) => Promise<unknown>) {
  const codexRequest = vi.fn(async (params: { request: { method: string } }) =>
    behavior(params.request),
  );
  harness.resolution.services = {
    codezAgentService: {
      codexRequest,
      onAgentRuntimeRestarted: (listener: (event: { workspaceKey: string }) => void) =>
        restartEvents.event(listener),
    },
  } as never;
  return codexRequest;
}

/** 让 React 处理挂起的状态更新与 effect（非嵌套 act，嵌套不会 flush）。 */
const flush = () => act(async () => {});

beforeEach(() => {
  vi.clearAllMocks();
  harness.resolution.rpcReady = true;
  harness.resolution.remoteSessionId = null;
  harness.resolution.services = {} as never;
});

describe("useCodexSettings 保存事务与 Agent 重启", () => {
  it("事务中屏障触发的 runtimeRestarted 不作废在途 config/batchWrite，锁释放后才换代", async () => {
    const codexRequest = installAgent(async () => WRITE_OK);
    const hook = renderHook(() =>
      useCodexSettings({ workspacePath: REMOTE_PATH, workspaceIdentity: REMOTE_IDENTITY }),
    );
    await waitFor(() => expect(hook.result.current.enabled).toBe(true));
    const formKeyBefore = hook.result.current.formKey;
    // 面板在点击时捕获写入闭包并全程复用，与 CodexProvidersPanel.submitProvider 一致。
    const runBefore = hook.result.current.run;
    const requestBefore = hook.result.current.request;

    // 门控等价 prepareKeySource：锁已持有、屏障尚未结束。
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let runPromise!: Promise<boolean>;
    act(() => {
      runPromise = runBefore(async () => {
        await gate;
        await requestBefore({ method: "config/batchWrite", params: { edits: [] } });
      });
    });

    // beginRotation 停止远端 Agent，事件落在写入之前；这正是生产日志的时序。
    restartEvents.fire({ workspaceKey: REMOTE_IDENTITY });
    await flush();
    // 换代必须被推迟，否则下面这次写入会被守卫在发出 RPC 前作废。
    expect(hook.result.current.formKey).toBe(formKeyBefore);

    release();
    const ok = await act(async () => runPromise);

    expect(
      codexRequest.mock.calls.some((call) => call[0].request.method === "config/batchWrite"),
    ).toBe(true);
    expect(ok).toBe(true);
    expect(hook.result.current.error).toBeUndefined();
    // 锁释放后统一应用换代，面板按新配置重读。
    await waitFor(() => expect(hook.result.current.formKey).not.toBe(formKeyBefore));
  });

  it("写入失败时错误跨换代可见，不被静默丢弃", async () => {
    installAgent(async ({ method }) => {
      if (method === "config/batchWrite") throw new Error("configVersionConflict");
      return {};
    });
    const hook = renderHook(() =>
      useCodexSettings({ workspacePath: REMOTE_PATH, workspaceIdentity: REMOTE_IDENTITY }),
    );
    await waitFor(() => expect(hook.result.current.enabled).toBe(true));
    const runBefore = hook.result.current.run;
    const requestBefore = hook.result.current.request;

    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let runPromise!: Promise<boolean>;
    act(() => {
      runPromise = runBefore(async () => {
        await gate;
        await requestBefore({ method: "config/batchWrite", params: { edits: [] } });
      });
    });
    restartEvents.fire({ workspaceKey: REMOTE_IDENTITY });
    await flush();
    release();
    const ok = await act(async () => runPromise);

    expect(ok).toBe(false);
    // 旧实现在这里因「代际已换代」丢弃错误，UI 完全静默。
    await waitFor(() => expect(hook.result.current.error).toContain("configVersionConflict"));
    expect(warn).not.toHaveBeenCalled();
  });

  it("真正切换 workspace 时才作废在途写入，并留 warn 而非静默", async () => {
    installAgent(async () => WRITE_OK);
    const hook = renderHook(
      ({ workspacePath }: { workspacePath: string }) =>
        useCodexSettings({ workspacePath, workspaceIdentity: REMOTE_IDENTITY }),
      { initialProps: { workspacePath: REMOTE_PATH } },
    );
    await waitFor(() => expect(hook.result.current.enabled).toBe(true));
    const runBefore = hook.result.current.run;
    const requestBefore = hook.result.current.request;

    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let runPromise!: Promise<boolean>;
    act(() => {
      runPromise = runBefore(async () => {
        await gate;
        await requestBefore({ method: "config/batchWrite", params: { edits: [] } });
      });
    });

    // 写入在途时用户切到另一个 workspace：写入目标身份真的变了，守卫必须拦住。
    act(() => {
      hook.rerender({ workspacePath: "/home/linuxtest/other" });
    });
    release();
    const ok = await act(async () => runPromise);

    expect(ok).toBe(false);
    expect(warn).toHaveBeenCalledWith(
      "codex-settings.mutation_failed_without_ui_surface",
      expect.objectContaining({ error: expect.stringContaining("workspace changed") }),
    );
  });
});
