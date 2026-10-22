import assert from "node:assert/strict";
import test from "node:test";
import { codexModelSchema } from "@codez/shared";
import {
  createComposerSubmissionConfig,
  freezeSubmissionMode,
} from "@/v4/composer/composerSubmissionConfig.js";
import { codexQuestionAnswer, readCodexQuestions } from "./codexQuestions.js";
import { resolveDesktopRuntimePreferences } from "./codexRuntimePreferences.js";
import {
  codexSubmissionSettingsAllowed,
  isCodexComposerBusy,
  isQueueSendNowAvailable,
  resolveCodexPrewarmConfig,
} from "./codexSubmissionSettings.js";
import type { ConversationSnapshot } from "@codez/shared/codez-protocol-v4";
import {
  readCodexModelCatalog,
  resolveCodexSelection,
  isCodexSelectionReady,
  resolveCodexComposerThoughtOption,
} from "./codexModelCatalog.js";
import {
  CODEX_CATALOG_TRANSIENT_RETRY_DELAYS_MS,
  isTransientCodexCatalogReadError,
  readCodexModelCatalogWithTransientRetry,
} from "@/hooks/useCodexModelCatalog.js";
import {
  resolveAppFollowupMode,
  resolveCodexFollowupIntent,
  resolveComposerFollowupDelivery,
} from "@/v4/composer/followupModeSettings.js";

const nativeModel = codexModelSchema.parse({
  id: "catalog-id",
  model: "native",
  displayName: "Native",
  description: "fixture",
  hidden: false,
  isDefault: true,
  defaultReasoningEffort: "medium",
  supportedReasoningEfforts: [
    { reasoningEffort: "medium", description: "Balanced" },
    { reasoningEffort: "high", description: "Detailed" },
  ],
});

test("native queue immediate action respects native availability; legacy behavior is unchanged", () => {
  assert.equal(
    isQueueSendNowAvailable(true, { allowed: false, reasonCode: "guard.codex.activeTurn" }),
    false,
  );
  assert.equal(isQueueSendNowAvailable(true, undefined), false);
  assert.equal(isQueueSendNowAvailable(true, { allowed: true }), true);
  assert.equal(isQueueSendNowAvailable(false, { allowed: false, reasonCode: "fixture" }), true);
});

test("native follow-up choice is per-send; idle and legacy submissions retain their routing", () => {
  const base = { nativeCodex: true, busy: true, nativeIntent: "queue" as const };
  assert.equal(resolveComposerFollowupDelivery({ ...base, reverse: false }), "queue");
  assert.equal(resolveComposerFollowupDelivery({ ...base, reverse: true }), "startNow");
  assert.equal(
    resolveComposerFollowupDelivery({ ...base, nativeIntent: "guide", reverse: false }),
    "guide",
  );
  assert.equal(
    resolveComposerFollowupDelivery({ ...base, nativeIntent: "guide", reverse: true }),
    "queue",
  );
  assert.equal(
    resolveComposerFollowupDelivery({ ...base, busy: false, reverse: false }),
    undefined,
  );
  assert.equal(resolveComposerFollowupDelivery({ ...base, busy: false, reverse: true }), undefined);
  assert.equal(
    resolveComposerFollowupDelivery({
      ...base,
      nativeCodex: false,
      followupMode: "queue",
      reverse: false,
    }),
    undefined,
  );
  assert.equal(
    resolveComposerFollowupDelivery({
      ...base,
      nativeCodex: false,
      followupMode: "guide",
      reverse: true,
    }),
    "queue",
  );
});

test("native follow-up intent defaults to codezInteractionBehavior setting and preserves per-scope override until reset", () => {
  assert.equal(
    resolveCodexFollowupIntent({
      scopeKey: "/ws\0s1",
      followupChoice: null,
      defaultFollowupIntent: resolveAppFollowupMode({ codezInteractionBehavior: "guide" } as never),
    }),
    "guide",
  );
  assert.equal(
    resolveCodexFollowupIntent({
      scopeKey: "/ws\0s1",
      followupChoice: null,
      defaultFollowupIntent: resolveAppFollowupMode({ codezInteractionBehavior: "queue" } as never),
    }),
    "queue",
  );
  assert.equal(
    resolveCodexFollowupIntent({
      scopeKey: "/ws\0s1",
      followupChoice: { scopeKey: "/ws\0s1", intent: "queue" },
      defaultFollowupIntent: "guide",
    }),
    "queue",
  );
  assert.equal(
    resolveCodexFollowupIntent({
      scopeKey: "/ws\0s2",
      followupChoice: { scopeKey: "/ws\0s1", intent: "queue" },
      defaultFollowupIntent: "guide",
    }),
    "guide",
  );
});

test("Codex runtime preferences never auto-answer or enable unsupported retention; Web is unchanged", () => {
  const legacy = { askUserQuestionAutoResolutionEnabled: true, modelIoFullRetentionEnabled: true };
  assert.deepEqual(resolveDesktopRuntimePreferences(legacy, true), {
    askUserQuestionAutoResolutionEnabled: false,
    modelIoFullRetentionEnabled: false,
  });
  assert.equal(resolveDesktopRuntimePreferences(legacy, false), legacy);
  assert.equal(legacy.askUserQuestionAutoResolutionEnabled, true);
});
test("native prewarm omits empty display fields and waits for explicit selection", () => {
  assert.equal(
    resolveCodexPrewarmConfig({ mode: "build", provider: "", model: "", thought: "" }),
    undefined,
  );
  const modelSelection = { providerId: "ui_qa", modelId: "ui-qa-offline" };
  assert.deepEqual(
    resolveCodexPrewarmConfig({
      mode: "build",
      planEnabled: false,
      modelSelection,
      provider: "",
      thought: "",
    }),
    {
      mode: "build",
      planEnabled: false,
      modelSelection,
      provider: "ui_qa",
      model: "ui-qa-offline",
    },
  );
  assert.equal(
    resolveCodexPrewarmConfig({
      mode: "build",
      modelSelection: { ...modelSelection, options: { reasoningLevel: "high" } },
    })?.thought,
    "high",
  );
});
const selection = {
  providerId: "native-provider",
  modelId: "native",
  options: { reasoningLevel: "medium" },
};
const catalog = {
  providerId: "native-provider",
  models: [nativeModel],
  groups: [
    { providerId: "native-provider", providerName: "native-provider", models: [nativeModel] },
  ],
  preferredSelection: selection,
};

test("native config and catalog determine provider/model/effort, without legacy provider view", async () => {
  const calls: string[] = [];
  const result = await readCodexModelCatalog("/native/workspace", async (request) => {
    calls.push(request.method);
    if (request.method === "config/read") {
      assert.deepEqual(request.params, { cwd: "/native/workspace", includeLayers: true });
      return {
        config: {
          model_provider: "native-provider",
          model: "native",
          model_reasoning_effort: "high",
        },
        origins: {},
        layers: [],
      };
    }
    return { data: [nativeModel], nextCursor: null };
  });
  assert.deepEqual(calls.sort(), ["config/read", "model/list"]);
  assert.equal(result.preferredSelection?.options?.reasoningLevel, "high");
  assert.ok(
    createComposerSubmissionConfig(
      { mode: "build", modelSelection: result.preferredSelection! },
      null,
      result,
    ),
  );
});

test("codex submission freezes custom and maps a stale plan mode onto custom", () => {
  // custom 是 Codex 权限档位（跟随 config.toml），必须能通过提交冻结面。
  const custom = createComposerSubmissionConfig(
    { mode: "custom", planEnabled: false, modelSelection: selection },
    null,
    catalog,
  );
  assert.equal(custom?.mode, "custom");
  // 旧草稿的 mode:"plan"（plan 现为独立勾选维度）在 Codex 链路落到 custom，
  // 而不是 Codez Agent 的 build（specs/codex-permission-modes.md）。
  const stalePlan = createComposerSubmissionConfig(
    { mode: "plan", planEnabled: true, modelSelection: selection },
    null,
    catalog,
  );
  assert.equal(stalePlan?.mode, "custom");
  assert.equal(stalePlan?.planEnabled, true);
});

test("non-codex submissions never carry the codex-only custom mode", () => {
  // custom 只属于 Codex 链路；运行时切换等残留草稿落到非 Codex 提交面时回退 build，
  // 防止 Codez Agent 协议面收到不认识的档位（其 admission 会显式拒绝）。
  assert.equal(freezeSubmissionMode("custom", undefined), "build");
  assert.equal(freezeSubmissionMode("custom", catalog), "custom");
  assert.equal(freezeSubmissionMode("plan", undefined), "build");
  assert.equal(freezeSubmissionMode("plan", catalog), "custom");
  assert.equal(freezeSubmissionMode("build", undefined), "build");
  assert.equal(freezeSubmissionMode("yolo", catalog), "yolo");
});

test("legacy recent selection migrates, explicit native selection and native effort are preserved", () => {
  assert.deepEqual(
    resolveCodexSelection(catalog, { providerId: "zai", modelId: "old" }),
    selection,
  );
  assert.deepEqual(
    resolveCodexSelection(catalog, { providerId: "native-provider", modelId: "native" }),
    selection,
  );
  const explicit = { ...selection, options: { reasoningLevel: "high" } };
  assert.equal(resolveCodexSelection(catalog, explicit), explicit);
  assert.equal(resolveCodexSelection(catalog, { ...selection, modelId: "removed" }), null);
});

test("codex catalog groups models by catalog provider and heals stale provider identity", async () => {
  const otherModel = codexModelSchema.parse({
    ...nativeModel,
    id: "other-id",
    model: "other",
    displayName: "Other",
  });
  const result = await readCodexModelCatalog(
    "/native/workspace",
    async (request) =>
      request.method === "config/read"
        ? {
            config: {
              model_provider: "native-provider",
              model: "native",
              model_providers: {
                "native-provider": { name: "Native" },
                "other-provider": { name: "Other API" },
              },
            },
            origins: {},
            layers: [],
          }
        : { data: [nativeModel, otherModel], nextCursor: null },
    async () => ({
      path: "/catalog.json",
      models: [{ slug: "other", provider: "other-provider" }],
    }),
  );
  assert.deepEqual(
    result.groups.map((group) => [group.providerId, group.models.map((m) => m.model)]),
    [
      ["native-provider", ["native"]],
      ["other-provider", ["other"]],
    ],
  );
  assert.equal(result.groups[1]?.providerName, "Other API");
  // 修复前存储的「激活 provider + 其他组模型」旧值被治愈为实际归属组。
  assert.deepEqual(
    resolveCodexSelection(result, {
      providerId: "native-provider",
      modelId: "other",
      options: { reasoningLevel: "medium" },
    }),
    { providerId: "other-provider", modelId: "other", options: { reasoningLevel: "medium" } },
  );
  // 完全陌生的 provider 不猜归属：迁移到首选。
  assert.equal(
    resolveCodexSelection(result, { providerId: "zai", modelId: "other" }),
    result.preferredSelection,
  );
  // 已知组内模型被移除 = 明确无效；其他组的模型按归属组就绪。
  assert.equal(
    isCodexSelectionReady(result, { providerId: "other-provider", modelId: "removed" }),
    false,
  );
  assert.equal(
    isCodexSelectionReady(result, {
      providerId: "other-provider",
      modelId: "other",
      options: { reasoningLevel: "medium" },
    }),
    true,
  );
});

test("unavailable catalog, removed models and unsupported native effort block submission", () => {
  for (const value of [
    undefined,
    { ...selection, modelId: "missing" },
    { ...selection, options: { reasoningLevel: "unsupported" } },
    { ...selection, providerId: "other-host" },
  ]) {
    assert.equal(isCodexSelectionReady(catalog, value), false);
    assert.equal(
      createComposerSubmissionConfig({ mode: "build", modelSelection: value }, null, catalog),
      null,
    );
  }
  assert.equal(
    createComposerSubmissionConfig({ mode: "build", modelSelection: selection }, null),
    null,
  );
  const frozen = createComposerSubmissionConfig(
    { mode: "build", modelSelection: selection },
    null,
    catalog,
  )!;
  assert.ok(Object.isFrozen(frozen.modelSelection.options));
});

test("empty capability table models are selection-ready without an effort dimension", () => {
  // 空能力表 = 模型没有档位维度（spec：CodexSettings.spec.md）：不就绪校验不适用
  // 档位匹配，否则该模型会永久阻断发送。
  const plainModel = codexModelSchema.parse({
    ...nativeModel,
    id: "plain-id",
    model: "plain",
    defaultReasoningEffort: "",
    supportedReasoningEfforts: [],
  });
  const plainCatalog = {
    ...catalog,
    models: [plainModel],
    groups: [
      { providerId: "native-provider", providerName: "native-provider", models: [plainModel] },
    ],
  };
  const plainSelection = { providerId: "native-provider", modelId: "plain" };
  assert.equal(isCodexSelectionReady(plainCatalog, plainSelection), true);
  const frozen = createComposerSubmissionConfig(
    { mode: "build", modelSelection: plainSelection },
    null,
    plainCatalog,
  );
  assert.equal(frozen?.modelSelection.modelId, "plain");
  assert.equal(frozen?.modelSelection.options, undefined);
  // Composer 档位控件不伪造可选列表：有当前档位时渲染只读单档，当前/默认都缺时不渲染。
  assert.deepEqual(
    resolveCodexComposerThoughtOption({
      model: plainModel,
      configuredSelected: false,
      current: "xhigh",
      label: "Reasoning effort",
    }),
    {
      id: "codex-reasoning-effort",
      name: "Reasoning effort",
      type: "select",
      currentValue: "xhigh",
      options: [{ value: "xhigh", name: "xhigh" }],
    },
  );
  assert.equal(
    resolveCodexComposerThoughtOption({
      model: plainModel,
      configuredSelected: false,
      current: "",
      label: "Reasoning effort",
    }),
    null,
  );
  // 有能力表的模型不受影响：档位选项原样展开。
  assert.equal(
    resolveCodexComposerThoughtOption({
      model: nativeModel,
      configuredSelected: false,
      current: "medium",
      label: "Reasoning effort",
    })?.options?.length,
    2,
  );
});

test("mapped preferred models are ready even when the config provider owns no models", async () => {
  for (const configuredModel of [undefined, "native"]) {
    const result = await readCodexModelCatalog(
      "/native/workspace",
      async (request) =>
        request.method === "config/read"
          ? {
              config: {
                model_provider: "config-provider",
                ...(configuredModel ? { model: configuredModel } : {}),
                model_reasoning_effort: "high",
              },
              origins: {},
              layers: [],
            }
          : { data: [nativeModel], nextCursor: null },
      async () => ({ models: [{ slug: "native", provider: "model-owner" }] }),
    );
    const expected = {
      providerId: "model-owner",
      modelId: "native",
      options: { reasoningLevel: "high" },
    };
    assert.deepEqual(result.preferredSelection, expected);
    assert.deepEqual(resolveCodexSelection(result), expected);
    assert.equal(isCodexSelectionReady(result, expected), true);
    assert.deepEqual(
      createComposerSubmissionConfig(
        { mode: "yolo", planEnabled: true, modelSelection: resolveCodexSelection(result)! },
        null,
        result,
      ),
      { mode: "yolo", planEnabled: true, modelSelection: expected },
    );
  }
});

test("stale config-provider drafts heal without resetting a non-default model or high effort", () => {
  const second = { ...nativeModel, model: "second", isDefault: false };
  const mapped = {
    ...catalog,
    providerId: "config-provider",
    models: [nativeModel, second],
    groups: [{ providerId: "model-owner", providerName: "Owner", models: [nativeModel, second] }],
    preferredSelection: { ...selection, providerId: "model-owner" },
  };
  const stale = {
    providerId: "config-provider",
    modelId: "second",
    options: { reasoningLevel: "high" },
  };
  const healed = resolveCodexSelection(mapped, stale);
  assert.deepEqual(healed, { ...stale, providerId: "model-owner" });
  assert.equal(healed?.options, stale.options);
  assert.equal(isCodexSelectionReady(mapped, healed), true);
  assert.equal(resolveCodexSelection(mapped, healed), healed);
  assert.equal(isCodexSelectionReady(mapped, stale), false, "raw stale identity is not ready");
  assert.equal(resolveCodexSelection(mapped, { ...stale, modelId: "removed" }), null);
  assert.equal(
    resolveCodexSelection(mapped, { ...stale, providerId: "foreign-host" }),
    mapped.preferredSelection,
  );
  assert.equal(
    isCodexSelectionReady(
      mapped,
      resolveCodexSelection(mapped, { ...stale, options: { reasoningLevel: "unsupported" } }),
    ),
    false,
  );
  const ambiguous = {
    ...mapped,
    groups: [
      ...mapped.groups,
      { providerId: "another-owner", providerName: "Other", models: [second] },
    ],
  };
  assert.equal(resolveCodexSelection(ambiguous, stale), null);
});

test("native answers use IDs or string indices, never question text or nested answers", () => {
  const questions = readCodexQuestions({
    questions: [
      { id: "target", header: "Target", question: "Duplicate text" },
      { id: "", header: "Secret", question: "Duplicate text", isSecret: true },
    ],
  })!;
  assert.equal(codexQuestionAnswer(questions, { "0": "staging" }), null);
  assert.deepEqual(codexQuestionAnswer(questions, { "0": "staging", "1": "fixture" }), {
    target: ["staging"],
    "1": ["fixture"],
  });
  assert.equal(readCodexQuestions({ questions: [{ question: "legacy without id" }] }), null);
});

test("explicit native custom model survives incomplete discovery without invented reasoning", async () => {
  for (const effort of [undefined, "custom-effort"]) {
    const result = await readCodexModelCatalog("/native/custom", async (request) =>
      request.method === "config/read"
        ? {
            config: {
              model_provider: "custom",
              model: "vendor/private",
              ...(effort ? { model_reasoning_effort: effort } : {}),
            },
            origins: {},
            layers: [],
          }
        : { data: [nativeModel], nextCursor: null },
    );
    const expected = {
      providerId: "custom",
      modelId: "vendor/private",
      ...(effort ? { options: { reasoningLevel: effort } } : {}),
    };
    assert.deepEqual(result.preferredSelection, expected);
    assert.deepEqual(result.configuredSelection, expected);
    assert.deepEqual(result.models, [nativeModel]);
    assert.deepEqual(resolveCodexSelection(result), expected);
    assert.deepEqual(
      resolveCodexSelection(result, { providerId: "custom", modelId: "vendor/private" }),
      expected,
    );
    assert.equal(isCodexSelectionReady(result, expected), true);
    assert.deepEqual(
      createComposerSubmissionConfig({ mode: "build", modelSelection: expected }, null, result)
        ?.modelSelection,
      expected,
    );
    assert.equal(isCodexSelectionReady(result, { ...expected, modelId: "unconfigured" }), false);
    assert.equal(isCodexSelectionReady(result, { ...expected, providerId: "wrong-host" }), false);
    const explicit = { ...expected, options: { reasoningLevel: "preserved-session-effort" } };
    assert.deepEqual(resolveCodexSelection(result, explicit), explicit);
    assert.equal(isCodexSelectionReady(result, explicit), true);
  }
});

test("native busy guide and idle queue reject changed settings but allow equal settings and startNow", () => {
  const submission = { modelSelection: selection, mode: "build" as const, planEnabled: false };
  const snapshot = {
    control: { phase: "running", canStop: true, stopState: "stoppable" },
    config: {
      provider: selection.providerId,
      model: selection.modelId,
      thought: "medium",
      mode: "build",
      planEnabled: false,
    },
  } as Pick<ConversationSnapshot, "control" | "config">;
  assert.equal(isCodexComposerBusy(snapshot), true);
  assert.equal(codexSubmissionSettingsAllowed(submission, snapshot), true);
  for (const changed of [
    { ...submission, mode: "yolo" as const },
    { ...submission, planEnabled: true },
    ...[{ providerId: "other" }, { modelId: "other" }, { options: { reasoningLevel: "high" } }].map(
      (change) => ({ ...submission, modelSelection: { ...selection, ...change } }),
    ),
  ]) {
    assert.equal(codexSubmissionSettingsAllowed(changed, snapshot), false);
    assert.equal(codexSubmissionSettingsAllowed(changed, snapshot, "guide"), false);
    assert.equal(codexSubmissionSettingsAllowed(changed, snapshot, "queue"), false);
    assert.equal(codexSubmissionSettingsAllowed(changed, snapshot, "startNow"), true);
    const idle = {
      ...snapshot,
      control: {
        ...snapshot.control,
        phase: "completedSuccess" as const,
        canStop: false,
        stopState: "idle" as const,
      },
    };
    assert.equal(isCodexComposerBusy(idle), false);
    assert.equal(codexSubmissionSettingsAllowed(changed, idle, "queue"), false);
    assert.equal(codexSubmissionSettingsAllowed(changed, idle), true);
  }
  assert.equal(
    codexSubmissionSettingsAllowed(
      {
        ...submission,
        modelSelection: { providerId: selection.providerId, modelId: selection.modelId },
      },
      snapshot,
    ),
    true,
  );
  assert.equal(codexSubmissionSettingsAllowed(submission, null, "queue"), false);
  assert.equal(codexSubmissionSettingsAllowed(submission, null), true);
});

test("custom draft stays queue/guide compatible with derived relaxed mode projections", () => {
  const submission = { modelSelection: selection, mode: "custom" as const, planEnabled: false };
  const busyControl = { phase: "running", canStop: true, stopState: "stoppable" };
  const baseConfig = {
    provider: selection.providerId,
    model: selection.modelId,
    thought: "medium",
    planEnabled: false,
  };
  // bridge 重启后 remembered 档丢失：relaxed 线程推导为 yolo/edit，而持久化草稿仍是
  // 新任务默认的 custom。custom 不携带权限覆盖意图，queue/guide 必须放行
  // （specs/codex-permission-modes.md）。
  for (const projectedMode of ["custom", "yolo", "edit"] as const) {
    const snapshot = {
      control: busyControl,
      config: { ...baseConfig, mode: projectedMode },
    } as Pick<ConversationSnapshot, "control" | "config">;
    assert.equal(codexSubmissionSettingsAllowed(submission, snapshot, "guide"), true);
    assert.equal(codexSubmissionSettingsAllowed(submission, snapshot, "queue"), true);
  }
  // build 投影只来自本进程记住的显式收紧：custom 草稿与之是真实分歧，继续拒绝。
  const rememberedBuild = {
    control: busyControl,
    config: { ...baseConfig, mode: "build" },
  } as Pick<ConversationSnapshot, "control" | "config">;
  assert.equal(codexSubmissionSettingsAllowed(submission, rememberedBuild, "guide"), false);
  // 其余维度不受 custom 兼容规则影响：模型/档位/plan 变更仍拒绝。
  assert.equal(
    codexSubmissionSettingsAllowed(
      { ...submission, modelSelection: { ...selection, modelId: "other" } },
      {
        control: busyControl,
        config: { ...baseConfig, mode: "yolo" },
      } as Pick<ConversationSnapshot, "control" | "config">,
      "guide",
    ),
    false,
  );
  assert.equal(
    codexSubmissionSettingsAllowed(
      { ...submission, planEnabled: true },
      {
        control: busyControl,
        config: { ...baseConfig, mode: "yolo" },
      } as Pick<ConversationSnapshot, "control" | "config">,
      "queue",
    ),
    false,
  );
});

test("useCodexModelCatalog transient retry self-heals stdout_closed / RPC timeout and stops on non-transient or stale scope", async () => {
  for (const transientMessage of [
    "Codez agent transport closed: stdout_closed",
    "Codez Protocol client disposed",
    "Codez Protocol client is disposed",
    "Codez Agent runtime is not running",
    "Codex RPC request timed out; outcome is unknown",
    "Codez Protocol request timed out: codex/request",
  ]) {
    assert.equal(isTransientCodexCatalogReadError(new Error(transientMessage)), true);
  }
  assert.equal(isTransientCodexCatalogReadError(new Error("Invalid native settings request")), false);

  const waitedDelays: number[] = [];
  let attempts = 0;
  const recovered = await readCodexModelCatalogWithTransientRetry({
    isCurrent: () => true,
    wait: async (delayMs) => {
      waitedDelays.push(delayMs);
    },
    readOnce: async () => {
      attempts += 1;
      if (attempts === 1) throw new Error("Codex RPC request timed out; outcome is unknown");
      if (attempts === 2) throw new Error("Codez agent transport closed: stdout_closed");
      return catalog;
    },
  });
  assert.equal(recovered, catalog);
  assert.equal(attempts, 3);
  assert.deepEqual(waitedDelays, [
    CODEX_CATALOG_TRANSIENT_RETRY_DELAYS_MS[0],
    CODEX_CATALOG_TRANSIENT_RETRY_DELAYS_MS[1],
  ]);

  // 非瞬态错误不盲目重试，立即上抛。
  let permanentAttempts = 0;
  await assert.rejects(
    readCodexModelCatalogWithTransientRetry({
      isCurrent: () => true,
      wait: async () => {
        throw new Error("must not wait on non-transient error");
      },
      readOnce: async () => {
        permanentAttempts += 1;
        throw new Error("Permission denied reading model catalog");
      },
    }),
    /Permission denied reading model catalog/,
  );
  assert.equal(permanentAttempts, 1);

  // 退避耗尽后如实上抛最后一次错误。
  const exhaustedDelays: number[] = [];
  await assert.rejects(
    readCodexModelCatalogWithTransientRetry({
      isCurrent: () => true,
      wait: async (delayMs) => {
        exhaustedDelays.push(delayMs);
      },
      readOnce: async () => {
        throw new Error("Codez agent transport closed: stdout_closed");
      },
    }),
    /Codez agent transport closed: stdout_closed/,
  );
  assert.deepEqual(exhaustedDelays, [...CODEX_CATALOG_TRANSIENT_RETRY_DELAYS_MS]);

  // 退避等待期间切换工作区或 invalidate 时，立即中止且不再发起下一次请求。
  let current = true;
  let staleAttempts = 0;
  await assert.rejects(
    readCodexModelCatalogWithTransientRetry({
      isCurrent: () => current,
      wait: async () => {
        current = false;
      },
      readOnce: async () => {
        staleAttempts += 1;
        throw new Error("Codez agent transport closed: stdout_closed");
      },
    }),
    /Codex workspace changed during catalog read/,
  );
  assert.equal(staleAttempts, 1);
});
