import assert from "node:assert/strict";
import test from "node:test";
import * as s from "@codez/shared";
import type { CodexRpcPort } from "../src/contract.js";
import { handleControlRequest } from "../src/control-plane.js";

const workspace = { workspacePath: "/workspace", workspaceKey: "/workspace" };

function fixture(remote = false) {
  const calls: { method: string; params: Record<string, unknown> }[] = [];
  const plugin = {
    id: "example@market",
    name: "example",
    installed: true,
    enabled: true,
    version: "2.0",
    localVersion: "1.0",
    installedAt: 1000,
    source: remote ? { type: "remote" } : { type: "local", path: "/plugins/example" },
    interface: {
      displayName: "Example",
      shortDescription: "Example plugin",
      category: "Coding",
      composerIconUrl: "https://example.invalid/icon.png",
      defaultPrompt: ["Try this"],
    },
  };
  const market = {
    name: "market",
    path: remote ? null : "/market/.agents/plugins/marketplace.json",
    plugins: [plugin],
  };
  const catalog = {
    marketplaces: [market],
    marketplaceLoadErrors: [],
    featuredPluginIds: [plugin.id],
  };
  const detail = () => ({
    plugin: {
      marketplaceName: market.name,
      marketplacePath: market.path,
      summary: { ...plugin },
      description: "Detailed",
      skills: [
        {
          name: "review",
          description: "Review",
          path: "/plugins/example/skills/review/SKILL.md",
          enabled: true,
        },
      ],
      hooks: [{ key: "session-start", eventName: "SessionStart" }],
      mcpServers: ["example-mcp"],
    },
  });
  const replies: Record<string, (params: Record<string, unknown>) => unknown> = {
    "plugin/list": () => structuredClone(catalog),
    "plugin/installed": () =>
      structuredClone({
        marketplaces: [{ ...market, plugins: market.plugins.filter((entry) => entry.installed) }],
        marketplaceLoadErrors: [],
      }),
    "plugin/read": () => detail(),
    "config/value/write": (params) => {
      plugin.enabled = Boolean(params.value);
      return {
        status: "ok",
        version: "v1",
        filePath: "/isolated/config.toml",
        overriddenMetadata: null,
      };
    },
    "plugin/install": () => {
      plugin.installed = true;
      return { authPolicy: "ON_INSTALL", appsNeedingAuth: [] };
    },
    "plugin/uninstall": () => {
      plugin.installed = false;
      return {};
    },
    "marketplace/add": () => ({
      marketplaceName: market.name,
      installedRoot: "/market",
      alreadyAdded: false,
    }),
    "marketplace/remove": () => ({ marketplaceName: market.name, installedRoot: "/market" }),
    "marketplace/upgrade": () => ({
      selectedMarketplaces: [market.name],
      upgradedRoots: ["/market"],
      errors: [],
    }),
  };
  const rpc: CodexRpcPort = {
    async request<T>(method: string, params: unknown): Promise<T> {
      calls.push({ method, params: params as Record<string, unknown> });
      assert.ok(replies[method], `Unexpected RPC ${method}`);
      return replies[method]!(params as Record<string, unknown>) as T;
    },
    async respond() {},
    async respondError() {},
  };
  return { context: { rpc, cwd: workspace.workspacePath }, calls, plugin, market, replies };
}

test("plugin read surfaces parse real Codez result schemas", async () => {
  const { context } = fixture();
  const list = s.codezPluginsListResultSchema.parse(
    await handleControlRequest("plugins/list", { workspace }, context),
  );
  assert.equal(list.plugins[0]?.skillCount, 1);
  assert.deepEqual(list.plugins[0]?.mcpServerNames, ["example-mcp"]);
  const overview = s.codezPluginsOverviewResultSchema.parse(
    await handleControlRequest("plugins/overview", { workspace }, context),
  );
  assert.equal(overview.availablePlugins[0]?.version, "2.0");
  assert.equal(overview.installedPlugins[0]?.version, "1.0");
  assert.equal(overview.marketplaces[0]?.isOfficial, undefined);
  assert.deepEqual(overview.marketplaces[0]?.featured, ["example@market"]);
  const catalog = s.codezPluginsReferenceCatalogResultSchema.parse(
    await handleControlRequest("plugins/referenceCatalogWithCategory", { workspace }, context),
  );
  assert.deepEqual(catalog.plugins[0]?.skillQualifiedNames, ["example:review"]);
  assert.equal(catalog.plugins[0]?.category, "Coding");
  const described = s.codezPluginsDescribeResultSchema.parse(
    await handleControlRequest(
      "plugins/describe",
      { workspace, pluginName: "example", marketplace: "market" },
      context,
    ),
  );
  assert.equal(
    described.components.find((component) => component.kind === "hook")?.items[0]?.name,
    "session-start",
  );
});

test("local and remote installs address actual Codex schemas, not marketplace IDs", async () => {
  for (const remote of [false, true]) {
    const { context, plugin, calls } = fixture(remote);
    plugin.installed = false;
    const result = s.codezPluginsInstallResultSchema.parse(
      await handleControlRequest(
        "plugins/install",
        {
          workspace,
          pluginName: "example",
          marketplace: "market",
          operationId: "attempt-1",
          scope: "user",
        },
        context,
      ),
    );
    assert.equal(result.installedPlugins[0]?.id, plugin.id);
    assert.deepEqual(calls.find((call) => call.method === "plugin/install")?.params, {
      pluginName: "example",
      installAttemptId: "attempt-1",
      ...(remote
        ? { remoteMarketplaceName: "market" }
        : { marketplacePath: "/market/.agents/plugins/marketplace.json" }),
    });
  }
});

test("enablement writes only the exact quoted plugin key and confirms effective state", async () => {
  const { context, calls } = fixture();
  const result = s.codezPluginsSetEnabledResultSchema.parse(
    await handleControlRequest(
      "plugins/setEnabled",
      { workspace, pluginId: "example@market", enabled: false },
      context,
    ),
  );
  assert.equal(result.enabled, false);
  assert.equal(result.plugin.enabled, false);
  assert.deepEqual(calls.find((call) => call.method === "config/value/write")?.params, {
    keyPath: 'plugins."example@market".enabled',
    value: false,
    mergeStrategy: "replace",
  });
});

test("higher-priority overridden enablement rejects instead of claiming success", async () => {
  const { context, replies, calls } = fixture();
  replies["config/value/write"] = () => ({
    status: "okOverridden",
    version: "v1",
    filePath: "/isolated/config.toml",
  });
  await assert.rejects(
    handleControlRequest(
      "plugins/setEnabled",
      { workspace, pluginId: "example@market", enabled: false },
      context,
    ),
    { code: -32000 },
  );
  assert.equal(calls.filter((call) => call.method === "config/value/write").length, 1);
});

test("uninstall translates compound identity to native pluginId and verifies removal", async () => {
  const { context, calls } = fixture();
  const result = s.codezPluginsUninstallResultSchema.parse(
    await handleControlRequest(
      "plugins/uninstall",
      { workspace, pluginName: "example", marketplace: "market" },
      context,
    ),
  );
  assert.equal(result.removedPlugin?.id, "example@market");
  assert.deepEqual(calls.find((call) => call.method === "plugin/uninstall")?.params, {
    pluginId: "example@market",
  });
});

test("marketplace operations map to add/remove/upgrade and parse the result schema", async () => {
  const { context, calls } = fixture();
  for (const [method, params] of [
    ["plugins/marketplace/add", { workspace, source: "org/fixture" }],
    ["plugins/marketplace/remove", { workspace, marketplace: "market" }],
    ["plugins/marketplace/update", { workspace, marketplace: "market" }],
  ] as const) {
    s.codezPluginsMarketplaceMutationResultSchema.parse(
      await handleControlRequest(method, params, context),
    );
  }
  assert.deepEqual(calls.find((call) => call.method === "marketplace/add")?.params, {
    source: "org/fixture",
  });
  assert.deepEqual(calls.find((call) => call.method === "marketplace/remove")?.params, {
    marketplaceName: "market",
  });
  assert.deepEqual(calls.find((call) => call.method === "marketplace/upgrade")?.params, {
    marketplaceName: "market",
  });
});

test("unsupported dry-run/scope, session catalogs, unknown controls make no RPC mutations", async () => {
  const { context, calls } = fixture();
  for (const [method, params] of [
    ["plugins/install", { workspace, marketplace: "market", pluginName: "example", dryRun: true }],
    [
      "plugins/install",
      { workspace, marketplace: "market", pluginName: "example", scope: "workspace" },
    ],
    ["plugins/marketplace/add", { workspace, source: "org/fixture", dryRun: true }],
    ["plugins/referenceCatalog", { workspace, sessionId: "old" }],
    ["plugins/update", { workspace, pluginId: "example@market" }],
    ["plugins/cancelOperation", { operationId: "unknown" }],
    ["plugins/resetConfig", { workspace, pluginId: "example@market" }],
  ] as const) {
    await assert.rejects(handleControlRequest(method, params, context), { code: -32601 });
  }
  assert.equal(calls.length, 0);
});

test("upgrade errors, uncertain installs, malformed replies never produce success or retries", async () => {
  const { context, replies, calls, plugin } = fixture();
  replies["marketplace/upgrade"] = () => ({
    selectedMarketplaces: ["market"],
    upgradedRoots: [],
    errors: [{ marketplaceName: "market", message: "offline" }],
  });
  await assert.rejects(handleControlRequest("plugins/marketplace/update", { workspace }, context), {
    code: -32000,
  });
  plugin.installed = false;
  replies["plugin/install"] = () => {
    throw new Error("connection lost after mutation");
  };
  await assert.rejects(
    handleControlRequest(
      "plugins/install",
      { workspace, marketplace: "market", pluginName: "example" },
      context,
    ),
    { code: -32000 },
  );
  assert.equal(calls.filter((call) => call.method === "plugin/install").length, 1);
  replies["plugin/list"] = () => ({ data: [] });
  await assert.rejects(handleControlRequest("plugins/overview", { workspace }, context), {
    code: -32000,
  });
});

test("marketplace mismatched mutation receipts fail without retrying", async () => {
  const { context, replies, calls } = fixture();
  replies["marketplace/remove"] = () => ({ marketplaceName: "wrong", installedRoot: null });
  await assert.rejects(
    handleControlRequest(
      "plugins/marketplace/remove",
      { workspace, marketplace: "market" },
      context,
    ),
    { code: -32000 },
  );
  replies["marketplace/upgrade"] = () => ({
    selectedMarketplaces: [],
    upgradedRoots: [],
    errors: [],
  });
  await assert.rejects(
    handleControlRequest(
      "plugins/marketplace/update",
      { workspace, marketplace: "market" },
      context,
    ),
    { code: -32000 },
  );
  assert.equal(calls.filter((call) => call.method === "marketplace/remove").length, 1);
  assert.equal(calls.filter((call) => call.method === "marketplace/upgrade").length, 1);
});
