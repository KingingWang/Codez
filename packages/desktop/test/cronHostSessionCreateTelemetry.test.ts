import { readFile } from "node:fs/promises";
import ts from "typescript";
import { beforeAll, describe, expect, it, vi } from "vitest";

let createDispatch: (
  deps: Record<string, unknown>,
) => (request: Record<string, unknown>) => Promise<unknown>;
beforeAll(async () => {
  // 装载生产函数，隔离 host 启动副作用；不复制派发实现。
  const path = new URL("../src/host/index.ts", import.meta.url);
  const source = ts.createSourceFile(
    path.pathname,
    await readFile(path, "utf8"),
    ts.ScriptTarget.Latest,
    true,
  );
  const fn = source.statements.find(
    (node): node is ts.FunctionDeclaration =>
      ts.isFunctionDeclaration(node) && node.name?.text === "dispatchCronRun",
  );
  if (!fn) throw new Error("dispatchCronRun missing");
  const code = ts.transpileModule(fn.getText(source), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
  }).outputText;
  createDispatch = (deps) =>
    new Function(...Object.keys(deps), `${code}; return dispatchCronRun;`)(...Object.values(deps));
});
function setup() {
  const service = {
    createTask: vi.fn(async () => ({ taskId: "new-session" })),
    resumeTask: vi.fn(async () => {}),
    sendPrompt: vi.fn(async () => {}),
  };
  const report = vi.fn();
  const taskKey = Symbol(),
    modelKey = Symbol(),
    botsKey = Symbol(),
    agentKey = Symbol();
  const selection = { providerId: "test", modelId: "test" };
  const inFlight = new Set();
  const assertCapability = vi.fn(async () => {});
  const resolveModel = vi.fn(async () => selection);
  const correlations = new Map<string, { state: string }>();
  const reconcileExisting = vi.fn(async () => ({
    taskId: "new-session",
    sessionId: "new-session",
  }));
  const repo = {
    getRun: vi.fn(async () => null),
    fixRunModelSelection: async () => selection,
    getCodexAutomationCorrelation: async ({ runId }: { runId: string }) =>
      correlations.get(runId) ?? null,
    prepareCodexAutomationCorrelation: async ({ runId }: { runId: string }) => {
      if (correlations.has(runId)) return { created: false };
      correlations.set(runId, { state: "pending" });
      return { created: true };
    },
    transitionCodexAutomationCorrelation: vi.fn(
      async ({ runId, to }: { runId: string; to: string }) => {
        correlations.set(runId, { state: to });
      },
    ),
  };
  const resolveTarget = vi.fn(() => ({
    getOptional: (key: symbol) =>
      key === taskKey ? service : key === modelKey || key === agentKey ? {} : undefined,
  }));
  const dispatch = createDispatch({
    ICodezTaskService: taskKey,
    IModelSelectionService: modelKey,
    IBotsService: botsKey,
    ICodezAgentService: agentKey,
    codexAutomationRunInFlight: inFlight,
    assertCodexScheduledPromptCapability: assertCapability,
    resolveAutomationTargetServices: resolveTarget,
    cronAutomationRepo: repo,
    resolveAutomationSubmissionModelSelection: resolveModel,
    dispatchExistingCronRunCorrelation: reconcileExisting,
    resolveWorkspaceKey: () => "workspace",
    formatModelPickerValue: () => "test/test",
    parseCronRunScheduledAt: () => 1,
    applyCronRunConfigToExistingTask: async () => {},
    cronRunSubscriptionKey: () => "key",
    trackCronRunOutcome: vi.fn(),
    disposeCronRunSubscription: vi.fn(),
    markCronRunOutcome: vi.fn(),
    reportHostSessionCreate: report,
    parentPort: {},
  });
  const request = {
    automationId: "a1",
    runId: "a1:1000",
    workspacePath: "/private",
    workspaceIdentity: "remote:ssh:host:/private",
    prompt: "prompt",
  };
  return {
    service,
    report,
    dispatch,
    request,
    inFlight,
    resolveTarget,
    assertCapability,
    resolveModel,
    repo,
    correlations,
    reconcileExisting,
  };
}
describe("定时任务的 Session 创建口径", () => {
  it.each(["a1:1000", "a1:manual:1000"])("新建会话 %s 首发 accepted 后才报告", async (runId) => {
    const state = setup();
    let accept!: () => void;
    state.service.sendPrompt.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          accept = resolve;
        }),
    );
    const dispatched = state.dispatch({ ...state.request, runId });
    await vi.waitFor(() => expect(state.service.sendPrompt).toHaveBeenCalledOnce());
    expect(state.report).not.toHaveBeenCalled();
    accept();
    await dispatched;
    expect(state.report).toHaveBeenCalledExactlyOnceWith(
      {},
      {
        sessionId: "new-session",
        messageId: runId,
        source: "automation_scheduled",
        workspaceIdentity: state.request.workspaceIdentity,
      },
    );
  });
  it("prompt 创建的任务绑定原会话，多次追加都不报告", async () => {
    const state = setup();
    await state.dispatch({ ...state.request, targetTaskId: "existing" });
    await state.dispatch({ ...state.request, runId: "a1:2000", targetTaskId: "existing" });
    expect(state.service.createTask).not.toHaveBeenCalled();
    expect(state.service.resumeTask).toHaveBeenCalledTimes(2);
    expect(state.service.sendPrompt).toHaveBeenCalledTimes(2);
    expect(state.report).not.toHaveBeenCalled();
  });
  it("新建后首发拒绝不报告", async () => {
    const state = setup();
    state.service.sendPrompt.mockRejectedValue(new Error("rejected"));
    await expect(state.dispatch(state.request)).rejects.toThrow("rejected");
    expect(state.report).not.toHaveBeenCalled();
    expect(state.inFlight.size).toBe(0);
  });

  it.each(["target", "capability", "model", "ledger"] as const)(
    "%s 首读失败释放 runId；恢复后同轮只发送一次",
    async (stage) => {
      const state = setup();
      const error = new Error("temporary failure");
      if (stage === "target")
        state.resolveTarget.mockImplementationOnce(() => {
          throw error;
        });
      if (stage === "capability") state.assertCapability.mockRejectedValueOnce(error);
      if (stage === "model") state.resolveModel.mockRejectedValueOnce(error);
      if (stage === "ledger") state.repo.getRun.mockRejectedValueOnce(error);
      await expect(state.dispatch(state.request)).rejects.toThrow("temporary failure");
      expect(state.inFlight.size).toBe(0);
      expect(state.service.sendPrompt).not.toHaveBeenCalled();
      await state.dispatch(state.request);
      expect(state.service.sendPrompt).toHaveBeenCalledOnce();
      expect(state.inFlight.size).toBe(0);
    },
  );

  it("派发在途仍拒绝并发重复 runId，迟到错误不能释放原派发的 guard", async () => {
    const state = setup();
    let accept!: () => void;
    state.service.sendPrompt.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          accept = resolve;
        }),
    );
    const first = state.dispatch(state.request);
    await vi.waitFor(() => expect(state.service.sendPrompt).toHaveBeenCalledOnce());
    await expect(state.dispatch(state.request)).rejects.toThrow("already dispatching");
    expect(state.inFlight.has(state.request.runId)).toBe(true);
    accept();
    await first;
    expect(state.inFlight.size).toBe(0);
    expect(state.service.sendPrompt).toHaveBeenCalledOnce();
  });

  it.each(["accepted", "unknown"] as const)(
    "guard 释放后 %s 台账仍只允许恢复历史，不能重发原生输入",
    async (status) => {
      const state = setup();
      if (status === "unknown") {
        state.service.sendPrompt.mockRejectedValueOnce(new Error("ACK lost"));
        await expect(state.dispatch(state.request)).rejects.toThrow("ACK lost");
      } else await state.dispatch(state.request);
      expect(state.correlations.get(state.request.runId)?.state).toBe(status);
      expect(state.inFlight.size).toBe(0);
      await state.dispatch(state.request);
      expect(state.reconcileExisting).toHaveBeenCalledOnce();
      expect(state.service.createTask).toHaveBeenCalledOnce();
      expect(state.service.sendPrompt).toHaveBeenCalledOnce();
    },
  );
});
