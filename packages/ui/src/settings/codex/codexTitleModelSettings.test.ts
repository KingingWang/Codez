import assert from "node:assert/strict";
import test from "node:test";
import {
  appSettingsPatchSchema,
  appSettingsSchema,
  DEFAULT_CODEX_TITLE_MODEL,
  resolveCodexTitleModel,
} from "@codez/shared";
import { commandPayloadSchemas } from "@codez/shared/codez-protocol-v4";

test("global default is available without configuring every workspace", () => {
  const settings = appSettingsSchema.parse({});
  assert.deepEqual(resolveCodexTitleModel(settings, "/project"), DEFAULT_CODEX_TITLE_MODEL);
  assert.deepEqual(resolveCodexTitleModel(settings, "/other"), DEFAULT_CODEX_TITLE_MODEL);
});

test("workspace override is isolated by identity and removal restores inheritance", () => {
  const global = { providerId: "custom", modelId: "global-small" };
  const remote = { providerId: "custom", modelId: "remote-small" };
  const settings = appSettingsSchema.parse({
    codexTitleDefaultModel: global,
    codexTitleWorkspaceModels: { "remote:A": remote },
  });
  assert.deepEqual(resolveCodexTitleModel(settings, "/same", "remote:A"), remote);
  assert.deepEqual(resolveCodexTitleModel(settings, "/same", "remote:B"), global);
  assert.deepEqual(resolveCodexTitleModel(settings, "/same"), global);
  assert.deepEqual(
    resolveCodexTitleModel(
      appSettingsPatchSchema.parse({ codexTitleWorkspaceModels: {} }),
      "/same",
      "remote:A",
    ),
    DEFAULT_CODEX_TITLE_MODEL,
  );
});

test("title model settings and first-input carrier reject invalid provider/model pairs", () => {
  assert.equal(
    appSettingsPatchSchema.safeParse({
      codexTitleDefaultModel: { providerId: "", modelId: "valid" },
    }).success,
    false,
  );
  assert.equal(
    appSettingsPatchSchema.safeParse({
      codexTitleWorkspaceModels: { "/project": { providerId: "p", modelId: "" } },
    }).success,
    false,
  );
  assert.equal(
    commandPayloadSchemas.sendText.safeParse({
      text: "Please investigate the build failure",
      titleGenerationModel: { providerId: "p", modelId: "m" },
    }).success,
    true,
  );
});
