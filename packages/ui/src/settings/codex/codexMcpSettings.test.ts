import assert from "node:assert/strict";
import test from "node:test";
import { codexConfigResponseSchema, type CodexRequest } from "@codez/shared";
import {
  codexMcpConfigToForm,
  codexMcpDeleteEdits,
  codexMcpFormToConfig,
  codexMcpSetEnabledEdits,
  codexMcpUpsertEdits,
  codexProjectRootFromDotFolder,
  codexProjectTrustEdits,
  deleteCodexUserMcpServer,
  listCodexMcpServers,
  readCodexMcpProjectLayers,
  saveCodexUserMcpServer,
  setCodexUserMcpServerEnabled,
  trustCodexProject,
} from "./codexMcpSettings.js";

const USER_FILE = "/home/tester/.codex/config.toml";

function configFixture(overrides?: {
  effective?: Record<string, unknown>;
  userServers?: Record<string, unknown>;
  projectLayers?: Array<{
    dotCodexFolder: string;
    disabledReason?: string | null;
    servers?: Record<string, unknown>;
  }>;
  origins?: Record<string, { type: string; dotCodexFolder?: string }>;
}) {
  const layers: unknown[] = [
    ...(overrides?.projectLayers ?? []).map((layer) => ({
      name: { type: "project", dotCodexFolder: layer.dotCodexFolder },
      version: "pv",
      config: { mcp_servers: layer.servers ?? {} },
      disabledReason: layer.disabledReason ?? null,
    })),
    {
      name: { type: "user", file: USER_FILE, profile: null },
      version: "uv1",
      config: { mcp_servers: overrides?.userServers ?? {} },
      disabledReason: null,
    },
  ];
  return codexConfigResponseSchema.parse({
    config: { mcp_servers: overrides?.effective ?? {} },
    origins: Object.fromEntries(
      Object.entries(overrides?.origins ?? {}).map(([key, value]) => [
        key,
        {
          name: {
            type: value.type,
            ...(value.type === "user" ? { file: USER_FILE, profile: null } : {}),
            ...(value.dotCodexFolder ? { dotCodexFolder: value.dotCodexFolder } : {}),
          },
          version: "v",
        },
      ]),
    ),
    layers,
  });
}

test("lists user and project servers with origins-based ownership", () => {
  const config = configFixture({
    effective: {
      globalDocs: { command: "npx", enabled: true },
      projApi: { url: "https://example.com/mcp", enabled: false },
      injected: { command: "internal" },
    },
    userServers: { globalDocs: { command: "npx" } },
    projectLayers: [
      {
        dotCodexFolder: "/ws/.codex",
        servers: { projApi: { url: "https://example.com/mcp", enabled: false } },
      },
    ],
    origins: {
      "mcp_servers.globalDocs.command": { type: "user" },
      "mcp_servers.projApi.url": { type: "project", dotCodexFolder: "/ws/.codex" },
      "mcp_servers.injected.command": { type: "sessionFlags" },
    },
  });
  const entries = listCodexMcpServers(config, new Map());
  assert.deepEqual(
    entries.map((entry) => [entry.name, entry.scope, entry.enabled, entry.manageable]),
    [
      ["projApi", "project", false, true],
      ["globalDocs", "user", true, true],
      ["injected", "builtin", true, false],
    ],
  );
  const project = entries.find((entry) => entry.name === "projApi");
  assert.equal(project?.dotCodexFolder, "/ws/.codex");
  // 编辑用原文条目（含 enabled:false），不是有效配置的规范化投影。
  assert.deepEqual(project?.rawConfig, { url: "https://example.com/mcp", enabled: false });
});

test("disabled project layer servers are listed as unmanaged-by-runtime but editable files", () => {
  const config = configFixture({
    effective: {},
    projectLayers: [
      {
        dotCodexFolder: "/ws/.codex",
        disabledReason: "not trusted",
        servers: { hiddenProj: { command: "echo" } },
      },
    ],
  });
  const entries = listCodexMcpServers(config, new Map());
  assert.equal(entries.length, 1);
  assert.equal(entries[0]?.scope, "project");
  assert.equal(entries[0]?.layerDisabled, true);
  assert.equal(entries[0]?.enabled, true);
  assert.equal(entries[0]?.dotCodexFolder, "/ws/.codex");
});

test("statuses merge by name and unsafe names stay read-only", () => {
  const config = configFixture({
    effective: { "bad name": { command: "x" }, good: { command: "y" } },
    userServers: { "bad name": { command: "x" }, good: { command: "y" } },
  });
  const entries = listCodexMcpServers(
    config,
    new Map([
      ["good", { runtimeStatus: "connected", authStatus: "oAuth", toolCount: 3, toolsError: null }],
    ]),
  );
  const bad = entries.find((entry) => entry.name === "bad name");
  const good = entries.find((entry) => entry.name === "good");
  assert.equal(bad?.manageable, false);
  assert.equal(good?.manageable, true);
  assert.equal(good?.status?.toolCount, 3);
});

test("status-only entries survive when config data is missing", () => {
  const statuses = new Map([
    [
      "fixture-mcp",
      {
        runtimeStatus: "failed",
        authStatus: "notLoggedIn",
        toolCount: 0,
        toolsError: "Discovery failed",
      },
    ],
  ]);
  // config/read 不可用（undefined）时，运行时状态与 discovery 错误仍须可见。
  const withoutConfig = listCodexMcpServers(undefined, statuses);
  assert.equal(withoutConfig.length, 1);
  assert.equal(withoutConfig[0]?.name, "fixture-mcp");
  assert.equal(withoutConfig[0]?.scope, "builtin");
  assert.equal(withoutConfig[0]?.manageable, false);
  assert.equal(withoutConfig[0]?.status?.toolsError, "Discovery failed");
  // config 存在但条目不在有效配置中（会话注入）时同样保留。
  const config = configFixture({
    effective: { good: { command: "y" } },
    userServers: { good: { command: "y" } },
  });
  const withConfig = listCodexMcpServers(config, statuses);
  const injected = withConfig.find((entry) => entry.name === "fixture-mcp");
  assert.equal(injected?.scope, "builtin");
  assert.equal(injected?.manageable, false);
});

test("project layers expose trust state and root derivation", () => {
  const config = configFixture({
    projectLayers: [
      { dotCodexFolder: "/ws/.codex", disabledReason: "untrusted" },
      { dotCodexFolder: "/other/.codex" },
    ],
  });
  const layers = readCodexMcpProjectLayers(config);
  assert.deepEqual(layers, [
    { dotCodexFolder: "/ws/.codex", disabledReason: "untrusted" },
    { dotCodexFolder: "/other/.codex" },
  ]);
  assert.equal(codexProjectRootFromDotFolder("/ws/.codex"), "/ws");
  assert.equal(codexProjectRootFromDotFolder("C:\\ws\\.codex"), "C:\\ws");
});

test("user-layer edit builders produce whole-entry replace and sub-key deletes", () => {
  assert.deepEqual(codexMcpUpsertEdits("docs", { command: "npx" }), [
    { keyPath: "mcp_servers.docs", value: { command: "npx" }, mergeStrategy: "replace" },
  ]);
  assert.deepEqual(codexMcpDeleteEdits("docs"), [
    { keyPath: "mcp_servers.docs", value: null, mergeStrategy: "replace" },
  ]);
  assert.deepEqual(codexMcpSetEnabledEdits("docs", false), [
    { keyPath: "mcp_servers.docs.enabled", value: false, mergeStrategy: "replace" },
  ]);
  // 使能 = 删除 enabled 键恢复默认启用。
  assert.deepEqual(codexMcpSetEnabledEdits("docs", true), [
    { keyPath: "mcp_servers.docs.enabled", value: null, mergeStrategy: "replace" },
  ]);
  assert.deepEqual(codexProjectTrustEdits("/ws/root"), [
    { keyPath: 'projects."/ws/root".trust_level', value: "trusted", mergeStrategy: "replace" },
  ]);
});

function recordingSender(config: unknown) {
  const calls: CodexRequest[] = [];
  return {
    calls,
    async request(request: CodexRequest) {
      calls.push(request);
      if (request.method === "config/read") return config;
      if (request.method === "config/batchWrite")
        return { status: "ok", version: "v2", filePath: USER_FILE, overriddenMetadata: null };
      return {};
    },
  };
}

test("user-layer writes re-read for expectedVersion then batchWrite then reload", async () => {
  const sender = recordingSender(configFixture({ userServers: {} }));
  await saveCodexUserMcpServer(sender, "docs", { command: "npx" });
  assert.deepEqual(
    sender.calls.map((call) => call.method),
    ["config/read", "config/batchWrite", "config/mcpServer/reload"],
  );
  const write = sender.calls[1];
  assert.ok(write);
  assert.equal(write.method, "config/batchWrite");
  assert.deepEqual(write.params, {
    filePath: USER_FILE,
    expectedVersion: "uv1",
    edits: [{ keyPath: "mcp_servers.docs", value: { command: "npx" }, mergeStrategy: "replace" }],
  });

  const sender2 = recordingSender(configFixture());
  await deleteCodexUserMcpServer(sender2, "docs");
  await setCodexUserMcpServerEnabled(sender2, "docs", false);
  await trustCodexProject(sender2, "/ws");
  // delete + set-enabled + trust 各对应一次 reload。
  assert.equal(sender2.calls.filter((call) => call.method === "config/mcpServer/reload").length, 3);
});

test("user-layer writes fail closed when no writable user layer exists", async () => {
  const config = codexConfigResponseSchema.parse({ config: {}, origins: {}, layers: null });
  const sender = recordingSender(config);
  await assert.rejects(saveCodexUserMcpServer(sender, "docs", { command: "npx" }), /user/);
  assert.equal(
    sender.calls.some((call) => call.method === "config/batchWrite"),
    false,
  );
});

test("stdio form converts to native entry and back", () => {
  const config = codexMcpFormToConfig({
    scope: "user",
    name: "docs",
    transport: "stdio",
    command: "npx",
    argsText: "-y\n@example/docs\n\n",
    envRows: [
      { key: "API_KEY", value: "x" },
      { key: " ", value: "ignored" },
    ],
    cwd: "/work",
    url: "",
    headerRows: [],
    bearerTokenEnvVar: "",
    startupTimeoutSec: "10",
    toolTimeoutSec: "",
  });
  assert.deepEqual(config, {
    command: "npx",
    args: ["-y", "@example/docs"],
    env: { API_KEY: "x" },
    cwd: "/work",
    startup_timeout_sec: 10,
  });
  const form = codexMcpConfigToForm("docs", config, "user");
  assert.equal(form.transport, "stdio");
  assert.equal(form.command, "npx");
  assert.deepEqual(form.argsText, "-y\n@example/docs");
  assert.deepEqual(form.envRows, [{ key: "API_KEY", value: "x" }]);
  assert.equal(form.startupTimeoutSec, "10");
});

test("http form converts to native entry with headers and bearer env var", () => {
  const config = codexMcpFormToConfig({
    scope: "project",
    name: "api",
    transport: "http",
    command: "",
    argsText: "",
    envRows: [],
    cwd: "",
    url: "https://example.com/mcp",
    headerRows: [{ key: "X-Team", value: "infra" }],
    bearerTokenEnvVar: "MCP_TOKEN",
    startupTimeoutSec: "",
    toolTimeoutSec: "30",
  });
  assert.deepEqual(config, {
    url: "https://example.com/mcp",
    http_headers: { "X-Team": "infra" },
    bearer_token_env_var: "MCP_TOKEN",
    tool_timeout_sec: 30,
  });
});

test("form rejects invalid names, missing command/url and bad timeouts", () => {
  const base = {
    scope: "user" as const,
    name: "docs",
    transport: "stdio" as const,
    command: "npx",
    argsText: "",
    envRows: [],
    cwd: "",
    url: "",
    headerRows: [],
    bearerTokenEnvVar: "",
    startupTimeoutSec: "",
    toolTimeoutSec: "",
  };
  assert.throws(() => codexMcpFormToConfig({ ...base, name: "has space" }));
  assert.throws(() => codexMcpFormToConfig({ ...base, command: " " }));
  assert.throws(() => codexMcpFormToConfig({ ...base, transport: "http", url: "" }));
  assert.throws(() => codexMcpFormToConfig({ ...base, startupTimeoutSec: "-3" }));
  assert.throws(() => codexMcpFormToConfig({ ...base, toolTimeoutSec: "abc" }));
});
