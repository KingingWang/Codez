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
  classifyCodexNativeBrowserCua,
  codexNativeBrowserCuaLegacyCleanupRequest,
  cleanupCodexNativeBrowserCuaLegacyMcp,
  getCodexNativeBrowserCuaLegacyRegistration,
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
  for (const route of ["computerUse", "migration"])
    assert.equal(isCodexUnsupportedSection(route), true);
  // 定时任务在 Codex 适配器已支持（spec: codex-desktop-automations UI surfacing），
  // 自动化分区不能再落入“不支持”列表。
  assert.equal(isCodexUnsupportedSection("automations"), false);
  // 浏览器控制在 Codex 适配器已支持（spec: codex-desktop-native-browser-cua
  // 「Settings Browser section surfacing」），不能再落入“不支持”列表。
  assert.equal(isCodexUnsupportedSection("browser"), false);
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

const nativeDescriptor = {
  runtimeInstalled: true,
  serviceRunning: true,
  executable: "/fixture/electron",
  bridgePath: "/fixture/bridge.cjs",
  endpoint: "/tmp/codez-native-browser-cua-test.sock",
  tokenFile: "/user/codez-native-browser-cua-test.token",
  browserAvailable: true,
  cuaAvailable: false,
  cuaReason: "codez-cua.runtime_unavailable",
};

function nativeLegacyConfig(registration: unknown, version = "v1") {
  const mcpServers = {
    "other-mcp": { command: "/fixture/other" },
    ...(registration === undefined ? {} : { "codez-desktop-browser-cua": registration }),
  };
  return codexConfigResponseSchema.parse({
    config: { mcp_servers: mcpServers },
    origins: {},
    layers: [
      {
        name: { type: "user", file: "/fixture/config.toml", profile: null },
        version,
        config: { mcp_servers: mcpServers },
      },
    ],
  });
}

const nativeLegacyValue = {
  command: nativeDescriptor.executable,
  args: [nativeDescriptor.bridgePath, "native-browser-cua-mcp"],
  env: {
    ELECTRON_RUN_AS_NODE: "1",
    CODEZ_NATIVE_BROWSER_CUA_ENDPOINT: nativeDescriptor.endpoint,
    CODEZ_NATIVE_BROWSER_CUA_TOKEN_FILE: nativeDescriptor.tokenFile,
  },
};

test("legacy native Browser/CUA cleanup rereads, deletes only the exact value, then reloads and reads all pages", async () => {
  const target = { filePath: "/fixture/config.toml", expectedVersion: "v2" };
  const request = codexNativeBrowserCuaLegacyCleanupRequest(target);
  assert.equal(request.method, "config/batchWrite");
  assert.deepEqual(request.params, {
    ...target,
    edits: [
      {
        keyPath: "mcp_servers.codez-desktop-browser-cua",
        value: null,
        mergeStrategy: "replace",
      },
    ],
  });
  const calls: CodexRequest[] = [];
  await cleanupCodexNativeBrowserCuaLegacyMcp(
    {
      async request(value) {
        calls.push(value);
        if (value.method === "config/read") return nativeLegacyConfig(nativeLegacyValue, "v2");
        if (value.method === "mcpServerStatus/list")
          return {
            data: [],
            nextCursor:
              calls.filter((entry) => entry.method === "mcpServerStatus/list").length === 1
                ? "next"
                : null,
          };
        return {};
      },
    },
    nativeDescriptor,
  );
  assert.equal(calls.length, 5);
  assert.deepEqual(calls[0], {
    method: "config/read",
    params: { includeLayers: true },
  });
  assert.deepEqual(calls[1], request);
  assert.deepEqual(calls[2], { method: "config/mcpServer/reload" });
  assert.deepEqual(calls[3]?.params, {});
  assert.deepEqual(calls[4]?.params, { cursor: "next" });
});

test("session-only browser override is not mistaken for a user-level legacy registration", () => {
  const config = nativeLegacyConfig(undefined);
  config.config.mcp_servers = { "codez-desktop-browser-cua": nativeLegacyValue };
  assert.equal(getCodexNativeBrowserCuaLegacyRegistration(config, nativeDescriptor), "none");
});

test("legacy native Browser/CUA cleanup fails closed on stale version and customized value", async () => {
  const calls: CodexRequest[] = [];
  await assert.rejects(
    cleanupCodexNativeBrowserCuaLegacyMcp(
      {
        async request(value) {
          calls.push(value);
          return nativeLegacyConfig({ ...nativeLegacyValue, args: ["/custom/bridge.cjs"] });
        },
      },
      nativeDescriptor,
    ),
    /Customized native browser registration was left unchanged/u,
  );
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], {
    method: "config/read",
    params: { includeLayers: true },
  });
});

test("native Browser/CUA classification fails closed before descriptor and configuration", () => {
  assert.equal(
    classifyCodexNativeBrowserCua({
      capability: undefined,
      remote: false,
    }),
    "unsupported",
  );
  assert.equal(
    classifyCodexNativeBrowserCua({ capability: "degraded", remote: true }),
    "unsupported",
  );
  assert.equal(
    classifyCodexNativeBrowserCua({
      capability: "degraded",
      remote: false,
      descriptorError: "command failed",
    }),
    "descriptor-unavailable",
  );
  assert.equal(
    classifyCodexNativeBrowserCua({
      capability: "degraded",
      remote: false,
    }),
    "descriptor-unavailable",
  );
  assert.equal(
    classifyCodexNativeBrowserCua({
      capability: "degraded",
      remote: false,
      descriptor: {
        runtimeInstalled: false,
        serviceRunning: false,
        executable: "/fixture/electron",
        browserAvailable: false,
        cuaAvailable: false,
        cuaReason: "codez-cua.runtime_unavailable",
      },
    }),
    "runtime-missing",
  );
  assert.equal(
    classifyCodexNativeBrowserCua({
      capability: "degraded",
      remote: false,
      descriptor: { ...nativeDescriptor, browserAvailable: false },
    }),
    "runtime-missing",
  );
  assert.equal(
    classifyCodexNativeBrowserCua({
      capability: "supported",
      remote: false,
      descriptor: nativeDescriptor,
    }),
    "active",
  );
});

test("native Browser/CUA legacy comparison recognizes only exact generated values and pagination detects cursor loops", async () => {
  assert.equal(
    getCodexNativeBrowserCuaLegacyRegistration(
      nativeLegacyConfig(undefined),
      nativeDescriptor as never,
    ),
    "none",
  );
  assert.equal(
    getCodexNativeBrowserCuaLegacyRegistration(nativeLegacyConfig(null), nativeDescriptor as never),
    "none",
  );
  assert.equal(
    getCodexNativeBrowserCuaLegacyRegistration(
      nativeLegacyConfig(nativeLegacyValue),
      nativeDescriptor as never,
    ),
    "codez-generated",
  );
  // 旧全局安装使用共享 token 文件；新 descriptor.tokenFile 带 windowId 后缀。
  assert.equal(
    getCodexNativeBrowserCuaLegacyRegistration(
      nativeLegacyConfig({
        ...nativeLegacyValue,
        env: {
          ...nativeLegacyValue.env,
          CODEZ_NATIVE_BROWSER_CUA_TOKEN_FILE: "/user/codez-native-browser-cua-default.token",
        },
      }),
      { ...nativeDescriptor, tokenFile: "/user/codez-native-browser-cua-default-7.token" } as never,
    ),
    "codez-generated",
  );
  // shared flavor 允许连字符；不能把 flavor/windowId 边界误判为未知路径。
  assert.equal(
    getCodexNativeBrowserCuaLegacyRegistration(
      nativeLegacyConfig({
        ...nativeLegacyValue,
        env: {
          ...nativeLegacyValue.env,
          CODEZ_NATIVE_BROWSER_CUA_TOKEN_FILE: "/user/codez-native-browser-cua-dev-build.token",
        },
      }),
      {
        ...nativeDescriptor,
        tokenFile: "/user/codez-native-browser-cua-dev-build-12.token",
      } as never,
    ),
    "codez-generated",
  );

  // Codex config/read 的规范化回读会补充默认键（GUI 实测：enabled/environment_id/
  // tool_timeout_sec），这些不算漂移。
  assert.equal(
    getCodexNativeBrowserCuaLegacyRegistration(
      nativeLegacyConfig({
        ...nativeLegacyValue,
        enabled: true,
        environment_id: "local",
        tool_timeout_sec: null,
      }),
      nativeDescriptor as never,
    ),
    "codez-generated",
  );
  // 用户停用（enabled: false）与未知额外键都要按未配置处理，保留修复入口。
  assert.equal(
    getCodexNativeBrowserCuaLegacyRegistration(
      nativeLegacyConfig({ ...nativeLegacyValue, enabled: false }),
      nativeDescriptor as never,
    ),
    "customized",
  );
  assert.equal(
    getCodexNativeBrowserCuaLegacyRegistration(
      nativeLegacyConfig({ ...nativeLegacyValue, customKey: "user-edit" }),
      nativeDescriptor as never,
    ),
    "customized",
  );
  assert.equal(
    getCodexNativeBrowserCuaLegacyRegistration(
      nativeLegacyConfig({ ...nativeLegacyValue, command: "/custom/electron" }),
      nativeDescriptor as never,
    ),
    "customized",
  );
  // 受控还原只改变 token 文件的 windowId 后缀；未知 token 路径仍然是用户数据。
  assert.equal(
    getCodexNativeBrowserCuaLegacyRegistration(
      nativeLegacyConfig({
        ...nativeLegacyValue,
        env: {
          ...nativeLegacyValue.env,
          CODEZ_NATIVE_BROWSER_CUA_TOKEN_FILE: "/user/custom.token",
        },
      }),
      { ...nativeDescriptor, tokenFile: "/user/codez-native-browser-cua-default-7.token" } as never,
    ),
    "customized",
  );

  const calls: CodexRequest[] = [];
  const failedCalls: CodexRequest[] = [];
  await assert.rejects(
    cleanupCodexNativeBrowserCuaLegacyMcp(
      {
        async request(value) {
          failedCalls.push(value);
          throw new Error("config read failed");
        },
      },
      nativeDescriptor,
    ),
    /config read failed/u,
  );
  assert.equal(failedCalls.length, 1);
  let configs = 0;
  await assert.rejects(
    cleanupCodexNativeBrowserCuaLegacyMcp(
      {
        async request(value) {
          calls.push(value);
          if (value.method === "config/read")
            return nativeLegacyConfig(nativeLegacyValue, `v${++configs}`);
          if (value.method === "mcpServerStatus/list") return { data: [], nextCursor: "loop" };
          return {};
        },
      },
      nativeDescriptor,
    ),
    /Invalid Codex pagination cursor/u,
  );
  assert.equal(calls.filter((entry) => entry.method === "mcpServerStatus/list").length, 2);
});
