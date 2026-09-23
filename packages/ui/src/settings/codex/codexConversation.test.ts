import assert from "node:assert/strict";
import test from "node:test";
import { codexModelSchema } from "@codez/shared";
import { createComposerSubmissionConfig } from "@/v4/composer/composerSubmissionConfig.js";
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
} from "./codexModelCatalog.js";

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
