import assert from "node:assert/strict";
import test from "node:test";
import { codexConfigResponseSchema, type CodexModel, type CodexRequest } from "@codez/shared";
import {
  isModelSelectionViewForWorkspace,
  modelSelectionViewWorkspaceKey,
  type ModelSelectionView,
} from "@codez/provider";
import {
  buildCodexHostModelCatalog,
  createCodexModelSelectionService,
  resolveCodexEffectiveModelSelection,
  type CodexModelSelectionWorkspaceTarget,
} from "../src/model-provider/codexModelSelectionService.js";

const nativeModel = (
  model: string,
  options: {
    isDefault?: boolean;
    hidden?: boolean;
    efforts?: string[];
    defaultEffort?: string;
  } = {},
): CodexModel => {
  const efforts = options.efforts ?? ["low", "medium", "high"];
  return {
    id: model,
    model,
    displayName: model,
    description: "fixture",
    hidden: options.hidden ?? false,
    isDefault: options.isDefault ?? false,
    defaultReasoningEffort: options.defaultEffort ?? "medium",
    supportedReasoningEfforts: efforts.map((reasoningEffort) => ({
      reasoningEffort,
      description: "fixture",
    })),
  };
};

interface FakeCodexBackend {
  config: Record<string, unknown>;
  pages: Array<{ data: CodexModel[]; nextCursor: string | null }>;
}

function createFakeSender(backend: FakeCodexBackend) {
  const calls: Array<{ target: CodexModelSelectionWorkspaceTarget; request: CodexRequest }> = [];
  const send = async (
    params: CodexModelSelectionWorkspaceTarget & { request: CodexRequest },
  ): Promise<unknown> => {
    calls.push({ target: params, request: params.request });
    if (params.request.method === "config/read") {
      return { config: backend.config, origins: {}, layers: null };
    }
    assert.equal(params.request.method, "model/list");
    const requestParams = (params.request.params ?? {}) as { cursor?: string };
    return requestParams.cursor ? backend.pages[1] : backend.pages[0];
  };
  return { send, calls };
}

const WORKSPACE = { workspacePath: "/repo/a" };

test("codex 视图：显式配置的模型与档位优先成为 preferredSelection", async () => {
  const backend: FakeCodexBackend = {
    config: { model_provider: "openai", model: "gpt-5-codex", model_reasoning_effort: "high" },
    pages: [
      {
        data: [nativeModel("gpt-5-codex", { isDefault: true }), nativeModel("gpt-5-mini")],
        nextCursor: null,
      },
    ],
  };
  const { send } = createFakeSender(backend);
  const service = createCodexModelSelectionService({ send });

  const view = await service.getView({ selection: null, workspace: WORKSPACE });
  assert.deepEqual(view.preferredSelection, {
    providerId: "openai",
    modelId: "gpt-5-codex",
    options: { reasoningLevel: "high" },
  });
  assert.equal(view.providers.length, 1);
  assert.equal(view.providers[0]?.providerId, "openai");
  assert.deepEqual(
    view.providers[0]?.models.map((model) => model.modelId),
    ["gpt-5-codex", "gpt-5-mini"],
  );
  assert.deepEqual(view.providers[0]?.models[0]?.config.optionSpecs.reasoningLevel.values, [
    "low",
    "medium",
    "high",
  ]);
  service.dispose();
});

test("codex 视图：无显式模型时回落目录默认模型与默认档位", async () => {
  const backend: FakeCodexBackend = {
    config: {},
    pages: [
      {
        data: [nativeModel("gpt-5-codex"), nativeModel("gpt-5-mini", { isDefault: true })],
        nextCursor: null,
      },
    ],
  };
  const { send } = createFakeSender(backend);
  const service = createCodexModelSelectionService({ send });
  const view = await service.getView({ selection: null, workspace: WORKSPACE });
  assert.deepEqual(view.preferredSelection, {
    providerId: "openai",
    modelId: "gpt-5-mini",
    options: { reasoningLevel: "medium" },
  });
  service.dispose();
});

test("codex 视图：配置模型不在目录中时保留配置事实为 preferredSelection", async () => {
  const backend: FakeCodexBackend = {
    config: {
      model_provider: "custom-native",
      model: "configured-only",
      model_reasoning_effort: "xhigh",
    },
    pages: [{ data: [nativeModel("other-model", { isDefault: true })], nextCursor: null }],
  };
  const { send } = createFakeSender(backend);
  const service = createCodexModelSelectionService({ send });
  const view = await service.getView({ selection: null, workspace: WORKSPACE });
  assert.deepEqual(view.preferredSelection, {
    providerId: "custom-native",
    modelId: "configured-only",
    options: { reasoningLevel: "xhigh" },
  });
  // 配置档位已知：作为单档事实进入候选，/model 菜单可见且可校验。
  assert.deepEqual(
    view.providers[0]?.models.map((model) => model.modelId),
    ["other-model", "configured-only"],
  );
  service.dispose();
});

test("codex 视图：无 workspace 返回空视图（与 codex 模式空 Registry 口径一致）", async () => {
  const { send, calls } = createFakeSender({ config: {}, pages: [] });
  const service = createCodexModelSelectionService({ send });
  const view = await service.getView();
  assert.equal(view.providers.length, 0);
  assert.equal(view.preferredSelection, undefined);
  assert.equal(calls.length, 0);
  service.dispose();
});

test("codex effective 解析：provider 不匹配 / 模型缺失 / 档位缺省补齐 / 档位不支持", async () => {
  const backend: FakeCodexBackend = {
    config: {},
    pages: [
      {
        data: [
          nativeModel("gpt-5-codex", {
            isDefault: true,
            efforts: ["low", "high"],
            defaultEffort: "high",
          }),
        ],
        nextCursor: null,
      },
    ],
  };
  const { send } = createFakeSender(backend);
  const service = createCodexModelSelectionService({ send });

  const wrongProvider = await service.getView({
    selection: { providerId: "glm", modelId: "gpt-5-codex" },
    workspace: WORKSPACE,
  });
  assert.equal(wrongProvider.effectiveSelection, null);
  assert.equal(wrongProvider.selectionIssue, "provider-not-found");

  const missingModel = await service.getView({
    selection: { providerId: "openai", modelId: "gone" },
    workspace: WORKSPACE,
  });
  assert.equal(missingModel.effectiveSelection, null);
  assert.equal(missingModel.selectionIssue, "model-not-found");

  // 缺档位：补目录默认档，不产生 selectionIssue（与 UI resolveCodexSelection 一致）。
  const filled = await service.getView({
    selection: { providerId: "openai", modelId: "gpt-5-codex" },
    workspace: WORKSPACE,
  });
  assert.deepEqual(filled.effectiveSelection, {
    providerId: "openai",
    modelId: "gpt-5-codex",
    options: { reasoningLevel: "high" },
  });
  assert.equal(filled.selectionIssue, undefined);

  const unsupported = await service.getView({
    selection: {
      providerId: "openai",
      modelId: "gpt-5-codex",
      options: { reasoningLevel: "xhigh" },
    },
    workspace: WORKSPACE,
  });
  assert.equal(unsupported.selectionIssue, "reasoning-level-not-supported");
  assert.deepEqual(unsupported.effectiveSelection, {
    providerId: "openai",
    modelId: "gpt-5-codex",
  });

  const ok = await service.getView({
    selection: {
      providerId: "openai",
      modelId: "gpt-5-codex",
      options: { reasoningLevel: "low" },
    },
    workspace: WORKSPACE,
  });
  assert.equal(ok.selectionIssue, undefined);
  assert.deepEqual(ok.effectiveSelection, {
    providerId: "openai",
    modelId: "gpt-5-codex",
    options: { reasoningLevel: "low" },
  });
  service.dispose();
});

test("codex effective 解析：配置模型不在目录时按配置事实直传", () => {
  const catalog = buildCodexHostModelCatalog(
    { model_provider: "custom-native", model: "configured-only", model_reasoning_effort: "high" },
    [nativeModel("other-model", { isDefault: true })],
  );
  assert.equal(catalog.configuredSelection?.modelId, "configured-only");
  // 显式档位保留用户选择；缺省回退配置档位。能力不可校验，不出 selectionIssue。
  const explicit = resolveCodexEffectiveModelSelection(catalog, {
    providerId: "custom-native",
    modelId: "configured-only",
    options: { reasoningLevel: "low" },
  });
  assert.deepEqual(explicit.effectiveSelection, {
    providerId: "custom-native",
    modelId: "configured-only",
    options: { reasoningLevel: "low" },
  });
  assert.equal(explicit.selectionIssue, undefined);
  const fallback = resolveCodexEffectiveModelSelection(catalog, {
    providerId: "custom-native",
    modelId: "configured-only",
  });
  assert.deepEqual(fallback.effectiveSelection, {
    providerId: "custom-native",
    modelId: "configured-only",
    options: { reasoningLevel: "high" },
  });
});

test("codex 视图：分页合并与游标防护", async () => {
  const backend: FakeCodexBackend = {
    config: {},
    pages: [
      { data: [nativeModel("gpt-5-codex", { isDefault: true })], nextCursor: "next" },
      { data: [nativeModel("gpt-5-mini")], nextCursor: null },
    ],
  };
  const { send } = createFakeSender(backend);
  const service = createCodexModelSelectionService({ send });
  const view = await service.getView({ selection: null, workspace: WORKSPACE });
  assert.deepEqual(
    view.providers[0]?.models.map((model) => model.modelId),
    ["gpt-5-codex", "gpt-5-mini"],
  );
  service.dispose();

  const loop = createCodexModelSelectionService({
    send: createFakeSender({
      config: {},
      pages: [
        { data: [nativeModel("gpt-5-codex", { isDefault: true })], nextCursor: "loop" },
        { data: [nativeModel("gpt-5-mini")], nextCursor: "loop" },
      ],
    }).send,
  });
  await assert.rejects(
    loop.getView({ selection: null, workspace: WORKSPACE }),
    /Invalid Codex model pagination cursor/,
  );
  loop.dispose();
});

test("codex 视图：目录变化推进 revision 并触发 onDidChange；TTL 内复用读取", async () => {
  const backend: FakeCodexBackend = {
    config: {},
    pages: [{ data: [nativeModel("gpt-5-codex", { isDefault: true })], nextCursor: null }],
  };
  const { send, calls } = createFakeSender(backend);
  let now = 1_000;
  const service = createCodexModelSelectionService({ send, now: () => now });
  const revisions: number[] = [];
  const subscription = service.onDidChange((view) => revisions.push(view.revision));

  const first = await service.getView({ selection: null, workspace: WORKSPACE });
  assert.equal(first.revision, 1);
  const cachedReads = calls.length;
  const again = await service.getView({ selection: null, workspace: WORKSPACE });
  assert.equal(again.revision, 1);
  assert.equal(calls.length, cachedReads, "TTL 内不重复读取 Codex");

  now += 10_000;
  backend.config = { model: "gpt-5-codex", model_reasoning_effort: "high" };
  const changed = await service.getView({ selection: null, workspace: WORKSPACE });
  assert.equal(changed.revision, 2);
  assert.deepEqual(revisions, [2], "只有目录变化才通知订阅者");
  subscription.dispose();
  service.dispose();
});

test("codex 视图：Codex RPC 失败时 getView 抛错，不写脏缓存", async () => {
  let fail = true;
  const service = createCodexModelSelectionService({
    send: async (params) => {
      if (fail) throw new Error("codex runtime unavailable");
      if (params.request.method === "config/read") {
        return codexConfigResponseSchema.parse({ config: {}, origins: {}, layers: null });
      }
      return { data: [nativeModel("gpt-5-codex", { isDefault: true })], nextCursor: null };
    },
  });
  await assert.rejects(
    service.getView({ selection: null, workspace: WORKSPACE }),
    /codex runtime unavailable/,
  );
  fail = false;
  const recovered = await service.getView({ selection: null, workspace: WORKSPACE });
  assert.equal(recovered.providers.length, 1);
  service.dispose();
});

test("codex 视图：不同 workspace 独立缓存与 revision", async () => {
  const backend: FakeCodexBackend = {
    config: {},
    pages: [{ data: [nativeModel("gpt-5-codex", { isDefault: true })], nextCursor: null }],
  };
  const { send, calls } = createFakeSender(backend);
  const service = createCodexModelSelectionService({ send });
  const a = await service.getView({ selection: null, workspace: { workspacePath: "/repo/a" } });
  const b = await service.getView({
    selection: null,
    workspace: { workspacePath: "/repo/b", workspaceIdentity: "ssh://host/repo/b" },
  });
  assert.equal(a.revision, 1);
  assert.equal(b.revision, 1);
  const bTarget = calls.find((call) => call.target.workspaceIdentity === "ssh://host/repo/b");
  assert.ok(bTarget, "workspaceIdentity 必须贯穿到 Codex 请求");
  assert.equal(
    (bTarget.request.params as { cwd?: string }).cwd,
    "/repo/b",
    "config/read 以 workspacePath 作为 cwd",
  );
  service.dispose();
});

test("codex 视图：selection 为 null 的读取携带 selection-missing 口径外的干净视图", async () => {
  const backend: FakeCodexBackend = {
    config: {},
    pages: [{ data: [nativeModel("gpt-5-codex", { isDefault: true })], nextCursor: null }],
  };
  const { send } = createFakeSender(backend);
  const service = createCodexModelSelectionService({ send });
  const view = await service.getView({ selection: null, workspace: WORKSPACE });
  assert.equal(view.effectiveSelection, undefined);
  assert.equal(view.selectionIssue, undefined);
  service.dispose();
});

function createPerWorkspaceSender(backends: Map<string, FakeCodexBackend>) {
  const send = async (
    params: CodexModelSelectionWorkspaceTarget & { request: CodexRequest },
  ): Promise<unknown> => {
    const backend = backends.get(params.workspacePath);
    assert.ok(backend, `未登记的 workspace: ${params.workspacePath}`);
    if (params.request.method === "config/read") {
      return { config: backend.config, origins: {}, layers: null };
    }
    return backend.pages[0];
  };
  return { send };
}

test("codex 视图：变更事件携带来源 workspace；跨 workspace 事件不推进彼此 revision", async () => {
  const backends = new Map<string, FakeCodexBackend>([
    [
      "/repo/a",
      {
        config: {},
        pages: [{ data: [nativeModel("model-a", { isDefault: true })], nextCursor: null }],
      },
    ],
    [
      "/repo/b",
      {
        config: {},
        pages: [{ data: [nativeModel("model-b", { isDefault: true })], nextCursor: null }],
      },
    ],
  ]);
  const { send } = createPerWorkspaceSender(backends);
  let now = 1_000;
  const service = createCodexModelSelectionService({ send, now: () => now });
  const events: ModelSelectionView[] = [];
  service.onDidChange((view) => events.push(view));

  const aFirst = await service.getView({
    selection: null,
    workspace: { workspacePath: "/repo/a" },
  });
  const bFirst = await service.getView({
    selection: null,
    workspace: { workspacePath: "/repo/b" },
  });
  assert.equal(aFirst.revision, 1);
  assert.equal(bFirst.revision, 1);
  assert.equal(aFirst.workspace?.workspacePath, "/repo/a");

  // B 的目录变化：事件携带 B 的 workspace 身份，A 的读取与 revision 不受影响。
  backends.get("/repo/b")!.config = { model: "model-b", model_reasoning_effort: "high" };
  now += 10_000;
  const bSecond = await service.getView({
    selection: null,
    workspace: { workspacePath: "/repo/b" },
  });
  assert.equal(bSecond.revision, 2);
  assert.equal(events.length, 1);
  assert.equal(events[0]?.workspace?.workspacePath, "/repo/b");

  const aAgain = await service.getView({
    selection: null,
    workspace: { workspacePath: "/repo/a" },
  });
  assert.equal(aAgain.revision, 1, "B 的变化不能推进 A 的 revision");
  assert.equal(aAgain.preferredSelection?.modelId, "model-a");
  assert.equal(events.length, 1, "A 的缓存命中读取不产生事件");
  service.dispose();
});

test("workspace 身份过滤：legacy 全局事件总是接受；跨 workspace 事件在比较 revision 前被拦截", () => {
  const view = {
    revision: 2,
    providers: [],
    workspace: { workspacePath: "/repo/b" },
  } satisfies ModelSelectionView;
  assert.equal(modelSelectionViewWorkspaceKey(view), "/repo/b");
  assert.equal(isModelSelectionViewForWorkspace(view, "/repo/b"), true);
  assert.equal(isModelSelectionViewForWorkspace(view, "/repo/a"), false);
  // 消费者没有 workspace 上下文时不接管别处事实。
  assert.equal(isModelSelectionViewForWorkspace(view, undefined), false);

  const identityView = {
    revision: 1,
    providers: [],
    workspace: { workspacePath: "/repo/b", workspaceIdentity: "ssh://host/repo/b" },
  } satisfies ModelSelectionView;
  assert.equal(modelSelectionViewWorkspaceKey(identityView), "ssh://host/repo/b");
  assert.equal(isModelSelectionViewForWorkspace(identityView, "ssh://host/repo/b"), true);
  assert.equal(isModelSelectionViewForWorkspace(identityView, "/repo/b"), false);

  // legacy Registry 事件是 Host 全局事实：不携带 workspace，任何消费者都接受。
  const legacyView = { revision: 7, providers: [] } satisfies ModelSelectionView;
  assert.equal(modelSelectionViewWorkspaceKey(legacyView), undefined);
  assert.equal(isModelSelectionViewForWorkspace(legacyView, "/repo/a"), true);
  assert.equal(isModelSelectionViewForWorkspace(legacyView, undefined), true);
});

/** 可在途挂起的 sender：open 后所有当前与后续请求立即按当前后端状态响应。 */
function createDeferredSender(backend: FakeCodexBackend) {
  const calls: Array<{ target: CodexModelSelectionWorkspaceTarget; request: CodexRequest }> = [];
  const pending: Array<() => void> = [];
  let open = false;
  const respond = (params: { request: CodexRequest }): unknown => {
    if (params.request.method === "config/read") {
      return { config: backend.config, origins: {}, layers: null };
    }
    return backend.pages[0];
  };
  const send = (
    params: CodexModelSelectionWorkspaceTarget & { request: CodexRequest },
  ): Promise<unknown> => {
    calls.push({ target: params, request: params.request });
    if (open) return Promise.resolve(respond(params));
    return new Promise((resolve) => pending.push(() => resolve(respond(params))));
  };
  return {
    send,
    calls,
    open(): void {
      open = true;
      for (const release of pending.splice(0)) release();
    },
  };
}

test("codex 视图：并发刷新合并为一次在途读取，配置变化后 revision 单调递增不回归", async () => {
  const backend: FakeCodexBackend = {
    config: {},
    pages: [{ data: [nativeModel("gpt-5-codex", { isDefault: true })], nextCursor: null }],
  };
  const sender = createDeferredSender(backend);
  let now = 1_000;
  const service = createCodexModelSelectionService({ send: sender.send, now: () => now });
  const configReads = () =>
    sender.calls.filter((call) => call.request.method === "config/read").length;

  // 两个并发读取共享同一在途 RPC，而不是各自发起。
  const firstPending = service.getView({ selection: null, workspace: WORKSPACE });
  const secondPending = service.getView({ selection: null, workspace: WORKSPACE });
  await Promise.resolve();
  assert.equal(configReads(), 1, "并发读取必须合并为一次在途读取");
  sender.open();
  const [first, second] = await Promise.all([firstPending, secondPending]);
  assert.equal(first.revision, 1);
  assert.equal(second.revision, 1);

  // 缓存过期 + 配置已变：新一轮并发读取同样合并，revision 推进到新配置。
  now += 10_000;
  backend.config = { model: "gpt-5-codex", model_reasoning_effort: "high" };
  const [third, fourth] = await Promise.all([
    service.getView({ selection: null, workspace: WORKSPACE }),
    service.getView({ selection: null, workspace: WORKSPACE }),
  ]);
  assert.equal(configReads(), 2, "过期后的并发刷新仍只发一次 RPC");
  assert.equal(third.revision, 2);
  assert.equal(fourth.revision, 2);
  assert.equal(third.preferredSelection?.modelId, "gpt-5-codex");

  // 不存在"旧响应后返回又写缓存"的窗口：过期重读仍是新配置，revision 不回归。
  now += 10_000;
  const fifth = await service.getView({ selection: null, workspace: WORKSPACE });
  assert.equal(fifth.revision, 2);
  assert.equal(fifth.preferredSelection?.modelId, "gpt-5-codex");
  service.dispose();
});

test("codex 视图：config/read 省略 layers 字段（includeLayers: false 的真实响应）仍可解析", async () => {
  // 真实 codex app-server 在 includeLayers: false 时不返回 layers 字段（而非 null）。
  // 严格 schema 曾因此拒绝整个响应，Bot 解析模型失败（2026-09-24 Windows 实测回归）。
  const service = createCodexModelSelectionService({
    send: async (params) => {
      if (params.request.method === "config/read") {
        return {
          config: { model: "gpt-5-codex", model_reasoning_effort: "high" },
          origins: {},
        };
      }
      return { data: [nativeModel("gpt-5-codex", { isDefault: true })], nextCursor: null };
    },
  });
  const view = await service.getView({ selection: null, workspace: WORKSPACE });
  assert.deepEqual(view.preferredSelection, {
    providerId: "openai",
    modelId: "gpt-5-codex",
    options: { reasoningLevel: "high" },
  });
  service.dispose();
});
