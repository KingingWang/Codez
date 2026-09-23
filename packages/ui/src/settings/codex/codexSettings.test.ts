import assert from "node:assert/strict";
import test from "node:test";
import {
  codexRequestSchema,
  codexAccountReadResponseSchema,
  codexConfigEditsSchema,
  codexConfigResponseSchema,
  codexLoginResponseSchema,
  codexModelSchema,
  codexPluginsResponseSchema,
  type CodexRequest,
} from "@codez/shared";
import {
  codexAuthorizationUrl,
  codexModelEdits,
  codexPluginInstallRequest,
  codexUserConfigTarget,
  readCodexResource,
  codexReadRequest,
  isCodexSettingsSection,
  isCodexUnsupportedSection,
} from "./codexSettingsData.js";
import { roleFormToWriteInput } from "./CodexAgentsPanel.js";

const model = codexModelSchema.parse({
  id: "catalog-id",
  model: "test-model",
  displayName: "Test model",
  description: "Fixture",
  hidden: false,
  isDefault: true,
  defaultReasoningEffort: "medium",
  supportedReasoningEfforts: [{ reasoningEffort: "medium", description: "Balanced" }],
});
const plugin = {
  id: "sample@market",
  name: "sample",
  installed: false,
  enabled: false,
  availability: "AVAILABLE" as const,
  installPolicy: "AVAILABLE" as const,
  mustShowInstallationInterstitial: false,
};

test("settings allowlist rejects execution, filesystem and unknown methods", () => {
  for (const method of [
    "command/exec",
    "fs/writeFile",
    "turn/start",
    "initialize",
    "plugin/marketplace/add",
    "unknown",
  ]) {
    assert.equal(codexRequestSchema.safeParse({ method }).success, false, method);
  }
  for (const method of [
    "account/read",
    "account/login/start",
    "account/login/cancel",
    "account/logout",
    "model/list",
    "config/read",
    "config/value/write",
    "config/batchWrite",
    "configRequirements/read",
    "skills/list",
    "skills/config/write",
    "mcpServerStatus/list",
    "mcpServer/oauth/login",
    "config/mcpServer/reload",
    "plugin/list",
    "plugin/install",
    "plugin/uninstall",
    "marketplace/add",
    "marketplace/remove",
    "marketplace/upgrade",
  ]) {
    assert.equal(codexRequestSchema.safeParse({ method }).success, true, method);
  }
  assert.equal(
    codexRequestSchema.safeParse({ method: "account/read", id: "injected" }).success,
    false,
  );
  assert.deepEqual(
    codexRequestSchema.parse({ method: "config/read", params: { cwd: "/fixture" } }),
    { method: "config/read", params: { cwd: "/fixture" } },
  );
});

test("account parsing accepts native variants without inventing a logged-in state", () => {
  assert.equal(
    codexAccountReadResponseSchema.parse({ account: null, requiresOpenaiAuth: false }).account,
    null,
  );
  assert.equal(
    codexAccountReadResponseSchema.parse({
      account: { type: "chatgpt", email: null, planType: "unknown" },
      requiresOpenaiAuth: true,
    }).account?.type,
    "chatgpt",
  );
  assert.equal(
    codexAccountReadResponseSchema.safeParse({ account: { email: "fixture" } }).success,
    false,
  );
  assert.equal(
    codexLoginResponseSchema.safeParse({ type: "chatgpt", authUrl: "https://example.com" }).success,
    false,
  );
  const login = codexLoginResponseSchema.parse({
    type: "chatgptDeviceCode",
    loginId: "fixture",
    verificationUrl: "https://example.com",
    userCode: "TEST-CODE",
  });
  assert.equal(login.type, "chatgptDeviceCode");
});

test("authorization URLs reject privileged schemes, credentials and insecure remote origins", () => {
  for (const url of [
    "javascript:alert(1)",
    "file:///fixture",
    "data:text/html,test",
    "https://user:secret@example.com",
    "http://example.com",
    "not a URL",
  ]) {
    assert.throws(() => codexAuthorizationUrl(url), url);
  }
  assert.equal(codexAuthorizationUrl("https://example.com/login"), "https://example.com/login");
  assert.equal(codexAuthorizationUrl("http://localhost:1455/auth"), "http://localhost:1455/auth");
});

test("writes use the base native user layer, not a project/profile origin version", () => {
  const config = codexConfigResponseSchema.parse({
    config: {},
    origins: {},
    layers: [
      { name: { type: "project" }, version: "project-v1", config: {}, disabledReason: null },
      {
        name: { type: "user", file: "/fixture/profile.toml", profile: "work" },
        version: "profile-v2",
        config: {},
        disabledReason: null,
      },
      {
        name: { type: "user", file: "/fixture/config.toml", profile: null },
        version: "user-v3",
        config: {},
        disabledReason: null,
      },
    ],
  });
  assert.deepEqual(codexUserConfigTarget(config), {
    filePath: "/fixture/config.toml",
    expectedVersion: "user-v3",
  });
  assert.equal(codexUserConfigTarget({ ...config, layers: null }), null);
  assert.equal(codexUserConfigTarget(undefined), null);
});

test("native config layers may omit disabledReason", () => {
  assert.equal(
    codexConfigResponseSchema.safeParse({
      config: {},
      origins: {},
      layers: [{ name: { type: "user", file: "/fixture/config.toml" }, version: "v1", config: {} }],
    }).success,
    true,
  );
});

test("model selection writes the native model name and rejects unsupported effort", () => {
  assert.deepEqual(codexModelEdits(model, "medium"), [
    { keyPath: "model", value: "test-model", mergeStrategy: "replace" },
    { keyPath: "model_reasoning_effort", value: "medium", mergeStrategy: "replace" },
  ]);
  assert.throws(() => codexModelEdits(model, "xhigh"));
  assert.equal(
    codexConfigEditsSchema.safeParse([
      { keyPath: "model", value: "fixture", mergeStrategy: "replace" },
    ]).success,
    true,
  );
  assert.equal(
    codexConfigEditsSchema.safeParse([{ keyPath: "", value: "fixture", mergeStrategy: "replace" }])
      .success,
    false,
  );
  assert.equal(
    codexConfigEditsSchema.safeParse([
      { keyPath: "model", value: undefined, mergeStrategy: "replace" },
    ]).success,
    false,
  );
});

test("native plugin parsing and install selectors distinguish local and remote marketplaces", () => {
  const response = codexPluginsResponseSchema.parse({
    marketplaces: [{ name: "market", path: null, plugins: [plugin] }],
    marketplaceLoadErrors: [],
    featuredPluginIds: [],
  });
  assert.equal(response.marketplaces[0]?.plugins[0]?.id, plugin.id);
  assert.equal(codexPluginsResponseSchema.safeParse({ data: [plugin] }).success, false);
  assert.deepEqual(
    codexPluginInstallRequest({ name: "market", path: null, plugins: [] }, plugin).params,
    { pluginName: "sample", remoteMarketplaceName: "market" },
  );
  assert.deepEqual(
    codexPluginInstallRequest({ name: "market", path: "/fixture/market.json", plugins: [] }, plugin)
      .params,
    { pluginName: "sample", marketplacePath: "/fixture/market.json" },
  );
  assert.throws(() =>
    codexPluginInstallRequest(
      { name: "market", path: null, plugins: [] },
      { ...plugin, mustShowInstallationInterstitial: true },
    ),
  );
  assert.throws(() =>
    codexPluginInstallRequest(
      { name: "market", path: null, plugins: [] },
      { ...plugin, availability: "DISABLED_BY_ADMIN" },
    ),
  );
});

test("model and MCP readers consume all native pages and reject looping cursors", async () => {
  const calls: CodexRequest[] = [];
  const data = await readCodexResource("models", "/fixture", async (request) => {
    calls.push(request);
    return {
      data: [{ ...model, id: String(calls.length) }],
      nextCursor: calls.length === 1 ? "next" : null,
    };
  });
  assert.equal(data.data.length, 2);
  assert.deepEqual(calls[1]?.params, { includeHidden: false, cursor: "next" });
  let page = 0;
  const mcp = await readCodexResource("mcp", "/fixture", async () => ({
    data: [],
    nextCursor: page++ === 0 ? "next" : null,
  }));
  assert.equal(mcp.nextCursor, null);
  await assert.rejects(
    readCodexResource("mcp", "/fixture", async () => ({ data: [], nextCursor: "loop" })),
    /cursor/,
  );
});

test("workspace reads carry native cwd and malformed lists fail rather than look empty", async () => {
  assert.deepEqual(codexReadRequest("config", "/fixture").params, {
    cwd: "/fixture",
    includeLayers: true,
  });
  assert.deepEqual(codexReadRequest("skills", "/fixture").params, {
    cwds: ["/fixture"],
    forceReload: true,
  });
  await assert.rejects(
    readCodexResource("skills", "/fixture", async () => ({ data: [{ skills: [] }] })),
  );
  await assert.rejects(
    readCodexResource("mcp", "/fixture", async () => ({
      data: [{ name: "fixture" }],
      nextCursor: null,
    })),
  );
});

test("legacy settings routes resolve to Codex or explicit unsupported capability notices", () => {
  for (const route of ["codex", "modelProvider", "skill", "subagents", "mcp", "plugin"])
    assert.equal(isCodexSettingsSection(route), true);
  for (const route of ["automations", "computerUse", "browser", "migration"])
    assert.equal(isCodexUnsupportedSection(route), true);
  assert.equal(isCodexUnsupportedSection("appearance"), false);
  assert.equal(isCodexSettingsSection("general"), false);
});

test("agent role form validates like the bridge and omits blank optional fields", () => {
  const base = {
    scope: "user" as const,
    name: " researcher ",
    description: "  Reads code  ",
    model: " ",
    effort: "high",
    instructions: " You research. ",
    nicknames: "scout, deep-dive",
  };
  assert.deepEqual(roleFormToWriteInput(base), {
    name: "researcher",
    description: "Reads code",
    modelReasoningEffort: "high",
    developerInstructions: "You research.",
    nicknameCandidates: ["scout", "deep-dive"],
  });
  // 可选字段全部留空 = 省略（bridge 语义：清除该 key）。
  assert.deepEqual(
    roleFormToWriteInput({
      ...base,
      description: " ",
      effort: " ",
      nicknames: " , ,",
    }),
    { name: "researcher", developerInstructions: "You research." },
  );
  // 编辑（originalName 存在）时不走新建字符集校验，名称保持锁定值。
  assert.equal(roleFormToWriteInput({ ...base, originalName: "researcher" }).name, "researcher");
  for (const bad of [
    { ...base, name: " " },
    { ...base, name: "has.dot" },
    { ...base, name: "has/slash" },
    { ...base, instructions: " " },
    { ...base, nicknames: "a, a" },
    { ...base, nicknames: "nön-ascii" },
  ]) {
    assert.throws(() => roleFormToWriteInput(bad));
  }
  // 编辑既有非常规字符集角色：bridge 按原名定位，不重新派生文件名。
  assert.equal(
    roleFormToWriteInput({ ...base, name: "weird—name", originalName: "weird—name" }).name,
    "weird—name",
  );
});
