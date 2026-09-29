import assert from "node:assert/strict";
import test from "node:test";
import {
  codezWorkspacePresentationSchema,
  nativeBrowserCuaMcpEndpointPath,
  nativeBrowserCuaMcpTokenFilePath,
  codezSessionSettingsStateSchema,
  codezSkillsReferenceCatalogResultSchema,
  codezProviderUpdateAccountConfigResultSchema,
  codezRuntimeCapabilitiesSchema,
  codezWorkspaceUpdateInteractionPreferencesResultSchema,
  codezWorkspaceUpdateModelIoPreferencesResultSchema,
} from "@codez/shared";
import type { CodexRpcPort } from "../src/contract.js";
import {
  bridgeCodexFeatureCapabilities,
  handleControlRequest,
  supportsControlMethod,
} from "../src/control-plane.js";
import { readControlModelSettings } from "../src/control-presentation.js";

test("native Browser/CUA paths are deterministic per desktop flavor", () => {
  assert.equal(
    nativeBrowserCuaMcpEndpointPath({
      platform: "linux",
      flavor: "Prod Flavor",
      temporaryDirectory: "/tmp/",
    }),
    "/tmp/codez-native-browser-cua-prodflavor.sock",
  );
  assert.equal(
    nativeBrowserCuaMcpEndpointPath({ platform: "win32", flavor: "prod-flavor" }),
    "\\\\.\\pipe\\codez-native-browser-cua-prod-flavor",
  );
  assert.equal(
    nativeBrowserCuaMcpTokenFilePath({ flavor: "Prod Flavor", userDataPath: "/user/data/" }),
    "/user/data/codez-native-browser-cua-prodflavor.token",
  );
});

const workspace = {
  workspacePath: "/workspace",
  workspaceKey: "remote-key",
  workspaceIdentity: "remote-identity",
  remoteSessionId: "remote-session",
};
function fixture(overrides: Record<string, unknown> = {}) {
  const calls: { method: string; params: unknown }[] = [];
  const responses: Record<string, unknown> = {
    "config/read": {
      config: {
        model: "test-model",
        model_provider: "fixture",
        model_reasoning_effort: "high",
        sandbox_mode: "workspace-write",
        approval_policy: "on-request",
      },
    },
    // autoReviewApprovals 探测端点：guardian approval 已启用、组织策略不限制审批人。
    "experimentalFeature/list": {
      data: [{ name: "guardian_approval", enabled: true }],
      nextCursor: null,
    },
    "configRequirements/read": { requirements: null },
    "model/list": {
      data: [
        {
          id: "catalog-id",
          model: "test-model",
          displayName: "Test Model",
          description: "Fixture",
          hidden: false,
          isDefault: true,
          inputModalities: ["text", "image"],
          defaultReasoningEffort: "medium",
          supportedReasoningEfforts: [
            { reasoningEffort: "medium", description: "Medium" },
            { reasoningEffort: "high", description: "High" },
          ],
        },
      ],
      nextCursor: null,
    },
    "skills/list": {
      data: [
        {
          cwd: "/workspace",
          errors: [],
          skills: [
            {
              name: "example",
              description: "Example skill",
              path: "/workspace/.agents/skills/example/SKILL.md",
              scope: "repo",
              enabled: true,
              pluginId: null,
            },
            {
              name: "disabled",
              description: "Hidden",
              path: "/disabled",
              scope: "user",
              enabled: false,
              pluginId: null,
            },
          ],
        },
      ],
    },
    ...overrides,
  };
  const rpc: CodexRpcPort = {
    async request<T>(method: string, params: unknown): Promise<T> {
      calls.push({ method, params });
      assert.ok(method in responses, `Unexpected RPC: ${method}`);
      return responses[method] as T;
    },
    async respond() {},
    async respondError() {},
  };
  const auxiliary = { supports: (method: string) => method === "workspace/generateText" };
  return { context: { rpc, cwd: "/workspace", auxiliary }, calls };
}

test("presentation parses the real strict schema, preserving remote identity", async () => {
  const { context, calls } = fixture();
  const result = codezWorkspacePresentationSchema.parse(
    await handleControlRequest("workspace/readPresentation", { workspace }, context),
  );
  assert.deepEqual(result.workspace, workspace);
  // 全局 config 投影恒为 custom 档（specs/codex-permission-modes.md）。
  assert.equal(result.mode, "custom");
  assert.ok(result.slashCommands.some((command) => command.name === "example"));
  assert.ok(!result.slashCommands.some((command) => command.name === "disabled"));
  assert.deepEqual(
    new Set(calls.map((call) => call.method)),
    new Set(["config/read", "model/list", "skills/list"]),
  );
});

test("model settings use model identity, complete format properties and reasoning refs", async () => {
  const { context } = fixture();
  const settings = codezSessionSettingsStateSchema.parse(await readControlModelSettings(context));
  assert.deepEqual(settings.model.current, {
    providerId: "fixture",
    modelId: "test-model",
    options: { reasoningLevel: "high" },
  });
  assert.equal(settings.model.available[0]?.ref.modelId, "test-model");
  assert.equal(settings.model.available[0]?.properties.inputFormat.supportsImage, true);
  assert.equal(settings.thoughtLevel.current, "high");
});

test("capabilities expose native independent plan state without inventing execution capability", async () => {
  const { context, calls } = fixture();
  const raw = await handleControlRequest("runtime/capabilities", {}, context);
  assert.deepEqual(raw, codezRuntimeCapabilitiesSchema.parse(raw));
  assert.deepEqual(raw, {
    independentPlanState: true,
    codex: bridgeCodexFeatureCapabilities(context.auxiliary, undefined, "supported"),
  });
  // 探测只走两个只读端点，且按 bridge 进程缓存：第二次读取不再触发 RPC。
  assert.deepEqual(
    calls.map((call) => call.method),
    ["experimentalFeature/list", "configRequirements/read"],
  );
  const again = await handleControlRequest("runtime/capabilities", {}, context);
  assert.deepEqual(again, raw);
  assert.equal(calls.length, 2);
});

test("autoReviewApprovals fails closed without guardian approval or reviewer allowance", async () => {
  const guardianDisabled = fixture({
    "experimentalFeature/list": {
      data: [{ name: "guardian_approval", enabled: false }],
      nextCursor: null,
    },
  });
  assert.equal(
    codezRuntimeCapabilitiesSchema.parse(
      await handleControlRequest("runtime/capabilities", {}, guardianDisabled.context),
    ).codex?.autoReviewApprovals,
    "unsupported",
  );
  // 旧原生缺失 guardian_approval 条目 → 不猜测可用。
  const guardianMissing = fixture({
    "experimentalFeature/list": { data: [], nextCursor: null },
  });
  assert.equal(
    codezRuntimeCapabilitiesSchema.parse(
      await handleControlRequest("runtime/capabilities", {}, guardianMissing.context),
    ).codex?.autoReviewApprovals,
    "unsupported",
  );
  // 组织策略白名单不含 auto_review → unsupported。
  const restricted = fixture({
    "configRequirements/read": { requirements: { allowedApprovalsReviewers: ["user"] } },
  });
  assert.equal(
    codezRuntimeCapabilitiesSchema.parse(
      await handleControlRequest("runtime/capabilities", {}, restricted.context),
    ).codex?.autoReviewApprovals,
    "unsupported",
  );
  // 探测响应损坏（schema 校验失败）→ fail-closed，不冒 supported。
  const broken = fixture({ "experimentalFeature/list": { unexpected: true } });
  assert.equal(
    codezRuntimeCapabilitiesSchema.parse(
      await handleControlRequest("runtime/capabilities", {}, broken.context),
    ).codex?.autoReviewApprovals,
    "unsupported",
  );
});

test("bridge capability authority is runtime-dispatch-derived and exposes every required state", async () => {
  const capabilities = bridgeCodexFeatureCapabilities(
    { supports: (method) => method === "workspace/generateText" },
    undefined,
    "supported",
  );
  assert.deepEqual(
    Object.values(capabilities).sort(),
    ["degraded", ...Array(7).fill("supported"), ...Array(2).fill("unsupported")].sort(),
  );
  assert.equal(capabilities.auxiliaryTextGeneration, "supported");
  assert.equal(capabilities.scheduledPromptAutomations, "supported");
  assert.equal(capabilities.legacyWorkflowRuns, "unsupported");
  // 缺省第三参 = 旧 peer 语义：autoReviewApprovals 投影为 unsupported。
  assert.equal(
    bridgeCodexFeatureCapabilities({ supports: () => false }).autoReviewApprovals,
    "unsupported",
  );
  const { context } = fixture();
  const result = codezRuntimeCapabilitiesSchema.parse(
    await handleControlRequest(
      "runtime/capabilities",
      {},
      {
        ...context,
        auxiliary: { supports: () => true },
      },
    ),
  );
  assert.deepEqual(result.codex, capabilities);
  assert.deepEqual(
    bridgeCodexFeatureCapabilities({ supports: () => false }).auxiliaryTextGeneration,
    "unsupported",
  );
  assert.equal(
    bridgeCodexFeatureCapabilities(
      { supports: () => false },
      {
        browserAvailable: true,
        cuaAvailable: false,
      },
    ).nativeBrowserCuaMcp,
    "degraded",
  );
  assert.equal(
    bridgeCodexFeatureCapabilities(
      { supports: () => false },
      {
        browserAvailable: false,
        cuaAvailable: true,
      },
    ).nativeBrowserCuaMcp,
    "unsupported",
  );
});

test("global config projects the custom tier regardless of sandbox policy", async () => {
  // 全局 config.toml 事实 = custom 档（跟随用户配置）；线程级 yolo/edit 投影
  // 由 projectThreadMode 负责，不在全局 presentation 上猜测（specs/codex-permission-modes.md）。
  for (const [sandbox_mode, approval_policy] of [
    ["read-only", "never"],
    ["workspace-write", "on-request"],
    ["danger-full-access", "never"],
  ]) {
    const { context } = fixture({ "config/read": { config: { sandbox_mode, approval_policy } } });
    const settings = await readControlModelSettings(context);
    assert.equal(settings.mode.current, "custom");
    const presentation = codezWorkspacePresentationSchema.parse(
      await handleControlRequest("workspace/readPresentation", { workspace }, context),
    );
    assert.equal(presentation.mode, "custom");
  }
});

test("configured custom model remains selectable without invented catalog capabilities", async () => {
  for (const effort of [undefined, "custom-effort"]) {
    const { context } = fixture({
      "config/read": {
        config: {
          model: "custom/model",
          model_provider: "native-provider",
          model_reasoning_effort: effort,
        },
      },
    });
    const settings = codezSessionSettingsStateSchema.parse(await readControlModelSettings(context));
    const configured = settings.model.available.find(
      (model) => model.ref.modelId === "custom/model",
    );
    assert.ok(configured);
    assert.deepEqual(configured.ref, settings.model.current);
    assert.equal(configured.ref.providerId, "native-provider");
    assert.equal(configured.ref.options?.reasoningLevel, effort);
    assert.match(configured.label, /configured/i);
    assert.equal(configured.disabledReason, undefined);
    assert.equal(configured.reasoning, undefined);
    assert.equal(configured.contextWindow, undefined);
    assert.equal(configured.maxOutputTokens, undefined);
    assert.ok(Object.values(configured.properties.inputFormat).every((value) => value === false));
    assert.equal(configured.properties.outputFormat.supportsText, false);
    assert.deepEqual(settings.thoughtLevel.available, []);
    assert.equal(settings.thoughtLevel.defaultLevel, undefined);
    const presentation = codezWorkspacePresentationSchema.parse(
      await handleControlRequest("workspace/readPresentation", { workspace }, context),
    );
    assert.ok(
      presentation.slashCommands
        .find((command) => command.name === "model")
        ?.inputHint?.includes("native-provider/custom/model"),
    );
  }
});

test("workspace skill catalog is enabled-only; frozen session authority is not fabricated", async () => {
  const { context } = fixture();
  const result = codezSkillsReferenceCatalogResultSchema.parse(
    await handleControlRequest("skills/referenceCatalog", { workspace }, context),
  );
  assert.equal(result.authority, "workspace");
  assert.equal(result.skills.length, 1);
  assert.equal(result.skills[0]?.scope, "workspace");
  await assert.rejects(
    handleControlRequest("skills/referenceCatalog", { workspace, sessionId: "old" }, context),
    { code: -32601 },
  );
});

test("account overlay acknowledges receipt without changing Codex configuration", async () => {
  const { context, calls } = fixture();
  const result = codezProviderUpdateAccountConfigResultSchema.parse(
    await handleControlRequest(
      "provider/updateAccountConfig",
      { revision: "r1", basedOnCodezBuiltinRevision: "b1", providers: { legacy: {} }, states: {} },
      context,
    ),
  );
  assert.deepEqual(result, { receivedRevision: "r1", providerCount: 0, status: "received" });
  assert.equal(calls.length, 0);
});

test("unsupported mutations and generation fail before touching RPC", async () => {
  const { context, calls } = fixture();
  for (const [method, params] of [
    ["unknown/mutation", {}],
    ["plugins/configure", {}],
    [
      "workspace/generateText",
      {
        workspace,
        prompt: "hi",
        querySource: "git",
        selection: { providerId: "fixture", modelId: "test-model" },
      },
    ],
    [
      "workspace/updateInteractionPreferences",
      { workspace, preferences: { askUserQuestionAutoResolutionEnabled: true } },
    ],
    [
      "workspace/updateModelIoPreferences",
      { workspace, preferences: { fullRetentionEnabled: true } },
    ],
  ] as const) {
    await assert.rejects(handleControlRequest(method, params, context), (error: unknown) => {
      assert.equal((error as { code: number }).code, -32601);
      assert.equal((error as { data: { method: string } }).data.method, method);
      return true;
    });
  }
  assert.equal(calls.length, 0);
  assert.equal(supportsControlMethod("codex/request"), false);
  assert.equal(supportsControlMethod("unknown/mutation"), false);
  assert.equal(supportsControlMethod("workspace/readPresentation"), true);
});

test("malformed input and workspace mismatch fail closed", async () => {
  const { context, calls } = fixture();
  await assert.rejects(handleControlRequest("workspace/readPresentation", {}, context), {
    code: -32602,
  });
  await assert.rejects(
    handleControlRequest(
      "workspace/readPresentation",
      { workspace: { ...workspace, workspacePath: "/other" } },
      context,
    ),
    { code: -32602 },
  );
  assert.equal(calls.length, 0);
});

test("malformed upstream data is not a fabricated empty catalog", async () => {
  const { context } = fixture({ "model/list": {} });
  await assert.rejects(handleControlRequest("workspace/readPresentation", { workspace }, context), {
    code: -32000,
  });
});

test("disabled compatibility preferences acknowledge zero bridge-owned sessions", async () => {
  const { context, calls } = fixture();
  const interaction = codezWorkspaceUpdateInteractionPreferencesResultSchema.parse(
    await handleControlRequest(
      "workspace/updateInteractionPreferences",
      {
        workspace,
        preferences: { askUserQuestionAutoResolutionEnabled: false },
      },
      context,
    ),
  );
  assert.equal(interaction.snoozedInteractionCount, 0);
  assert.equal(interaction.askUserQuestionAutoResolutionEnabled, false);
  const io = codezWorkspaceUpdateModelIoPreferencesResultSchema.parse(
    await handleControlRequest(
      "workspace/updateModelIoPreferences",
      {
        workspace,
        preferences: { fullRetentionEnabled: false },
      },
      context,
    ),
  );
  assert.equal(io.updatedSessionCount, 0);
  assert.equal(io.fullRetentionEnabled, false);
  assert.equal(calls.length, 0);
});

test("all model pages and the pinned audio modality are projected", async () => {
  const { context } = fixture();
  const original = context.rpc.request.bind(context.rpc);
  context.rpc.request = async <T>(method: string, params: unknown): Promise<T> => {
    if (method !== "model/list") return original<T>(method, params);
    const result = await original<{ data: Record<string, unknown>[]; nextCursor: string | null }>(
      method,
      params,
    );
    if ((params as { cursor?: string }).cursor) {
      return {
        data: [
          {
            ...result.data[0],
            id: "audio-id",
            model: "audio-model",
            inputModalities: ["text", "audio"],
            isDefault: false,
          },
        ],
        nextCursor: null,
      } as T;
    }
    return { ...result, nextCursor: "page-2" } as T;
  };
  const settings = codezSessionSettingsStateSchema.parse(await readControlModelSettings(context));
  assert.equal(settings.model.available.length, 2);
  assert.equal(settings.model.available[1]?.properties.inputFormat.supportsAudio, true);
});

test("only mapped built-ins appear and duplicate skills cannot shadow them", async () => {
  const { context } = fixture({
    "skills/list": {
      data: [
        {
          cwd: "/workspace",
          errors: [],
          skills: [
            {
              name: "model",
              description: "Not a model control",
              path: "/skill",
              scope: "repo",
              enabled: true,
              pluginId: null,
            },
          ],
        },
      ],
    },
  });
  const result = codezWorkspacePresentationSchema.parse(
    await handleControlRequest("workspace/readPresentation", { workspace }, context),
  );
  assert.deepEqual(
    result.slashCommands.map((command) => command.name),
    ["model", "mode", "compact"],
  );
  assert.ok(result.slashCommands[0]?.inputHint?.includes("fixture/test-model$medium"));
});

test("autoReviewApprovals accepts the guardian_subagent reviewer alias in the org allowlist", async () => {
  // guardian_subagent 是 auto_review 的旧别名；组织白名单只列旧别名时也应判 supported。
  const { context } = fixture({
    "configRequirements/read": {
      requirements: { allowedApprovalsReviewers: ["guardian_subagent"] },
    },
  });
  assert.equal(
    codezRuntimeCapabilitiesSchema.parse(
      await handleControlRequest("runtime/capabilities", {}, context),
    ).codex?.autoReviewApprovals,
    "supported",
  );
});

test("autoReviewApprovals fails closed and caches when configRequirements/read rejects", async () => {
  const { context } = fixture();
  let reviewerProbes = 0;
  const original = context.rpc.request.bind(context.rpc);
  context.rpc.request = async <T>(method: string, params: unknown): Promise<T> => {
    if (method === "configRequirements/read") {
      reviewerProbes++;
      throw new Error("configRequirements unavailable");
    }
    return original<T>(method, params);
  };
  assert.equal(
    codezRuntimeCapabilitiesSchema.parse(
      await handleControlRequest("runtime/capabilities", {}, context),
    ).codex?.autoReviewApprovals,
    "unsupported",
  );
  // 探测失败结果同样按 bridge 进程缓存：第二次 dispatch 不再触发 configRequirements/read。
  await handleControlRequest("runtime/capabilities", {}, context);
  assert.equal(reviewerProbes, 1);
});
