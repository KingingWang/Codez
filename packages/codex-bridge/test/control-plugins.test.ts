import assert from "node:assert/strict";
import test from "node:test";
import { join, resolve } from "node:path";
import * as s from "@codez/shared";
import type { CodexRpcPort } from "../src/contract.js";
import type { OfficialPluginMarketplace } from "../src/official-plugin-marketplace.js";
import { handleControlRequest } from "../src/control-plane.js";
import { ensureOfficialRegistered } from "../src/control-official-plugins.js";
import { handleCodexNativeRequest } from "../src/request-scope.js";

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
      if (typeof params.value === "boolean") plugin.enabled = params.value;
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
    "hooks/list": () => ({ data: [] }),
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

test("native-qualified skill names are not prefixed a second time", async () => {
  const { context, replies } = fixture();
  const original = replies["plugin/read"]!;
  replies["plugin/read"] = (params) => {
    const detail = original(params) as { plugin: { skills: { name: string }[] } };
    detail.plugin.skills[0]!.name = "example:review";
    return detail;
  };
  const catalog = s.codezPluginsReferenceCatalogResultSchema.parse(
    await handleControlRequest("plugins/referenceCatalog", { workspace }, context),
  );
  assert.deepEqual(catalog.plugins[0]?.skillQualifiedNames, ["example:review"]);
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

test("official catalog is visible before native registration, and install is a verified user-level native write", async () => {
  const { context, calls, replies } = fixture();
  const source = resolve("/isolated/official");
  const path = join(source, ".agents", "plugins", "marketplace.json");
  const official = {
    path,
    catalog: {
      name: s.CODEZ_OFFICIAL_PLUGIN_MARKETPLACE_ID,
      plugins: [
        {
          name: "github",
          version: "0.1.2",
          description: "GitHub workflows",
          policy: { installation: "AVAILABLE" },
          warnings: [],
          requiresOfficialAuth: false,
          requiresPaidPlan: false,
          hasHooks: false,
        },
        {
          name: "wind",
          version: "0.1.0",
          policy: { installation: "NOT_AVAILABLE" },
          unavailableReason: "declared MCP servers cannot be adapted to Codex transports/auth",
          warnings: [],
          requiresOfficialAuth: true,
          requiresPaidPlan: true,
          hasHooks: false,
        },
      ],
    },
  };
  const control = {
    ...context,
    officialPlugins: {
      async load() {
        return official;
      },
      async refresh() {
        return official;
      },
    } as unknown as OfficialPluginMarketplace,
  };
  const overview = s.codezPluginsOverviewResultSchema.parse(
    await handleControlRequest("plugins/overview", { workspace }, control),
  );
  assert.equal(
    overview.marketplaces.find((market) => market.id === s.CODEZ_OFFICIAL_PLUGIN_MARKETPLACE_ID)
      ?.pluginCount,
    2,
  );
  assert.equal(
    overview.availablePlugins.find((plugin) => plugin.name === "wind")
      ?.installationUnavailableReason !== undefined,
    true,
  );
  assert.equal(
    calls.some((call) => call.method === "marketplace/add"),
    false,
  );

  await assert.rejects(
    handleControlRequest(
      "plugins/install",
      {
        workspace,
        pluginName: "wind",
        marketplace: s.CODEZ_OFFICIAL_PLUGIN_MARKETPLACE_ID,
      },
      control,
    ),
    /not compatible/,
  );
  assert.equal(
    calls.some((call) => call.method === "marketplace/add"),
    false,
  );

  const existing = {
    name: s.CODEZ_OFFICIAL_PLUGIN_MARKETPLACE_ID,
    path,
    plugins: [
      {
        ...fixture().plugin,
        id: `github@${s.CODEZ_OFFICIAL_PLUGIN_MARKETPLACE_ID}`,
        name: "github",
        installed: false,
        localVersion: "0.1.2",
      },
    ],
  };
  const registration = { completed: false };
  const catalog = { marketplaces: [existing], marketplaceLoadErrors: [] };
  replies["plugin/installed"] = () => ({
    marketplaces: [{ ...existing, plugins: existing.plugins.filter((entry) => entry.installed) }],
    marketplaceLoadErrors: [],
  });
  replies["marketplace/add"] = () => {
    registration.completed = true;
    return {
      marketplaceName: existing.name,
      installedRoot: source,
      alreadyAdded: false,
    };
  };
  replies["plugin/list"] = () =>
    registration.completed
      ? structuredClone(catalog)
      : { marketplaces: [], marketplaceLoadErrors: [] };
  replies["plugin/install"] = () => {
    existing.plugins[0]!.installed = true;
    return { authPolicy: "ON_INSTALL", appsNeedingAuth: [] };
  };
  const result = s.codezPluginsInstallResultSchema.parse(
    await handleControlRequest(
      "plugins/install",
      {
        workspace,
        pluginName: "github",
        marketplace: s.CODEZ_OFFICIAL_PLUGIN_MARKETPLACE_ID,
        scope: "user",
      },
      control,
    ),
  );
  assert.equal(result.installedPlugins[0]?.id, existing.plugins[0]!.id);
  assert.deepEqual(calls.find((call) => call.method === "marketplace/add")?.params, {
    source,
  });
});

test("official marketplace identity collision cannot register or install a plugin", async () => {
  const { context, calls, market } = fixture();
  market.name = s.CODEZ_OFFICIAL_PLUGIN_MARKETPLACE_ID;
  const control = {
    ...context,
    officialPlugins: {
      async load() {
        return {
          path: "/isolated/official/.agents/plugins/marketplace.json",
          catalog: {
            plugins: [
              {
                name: "example",
                version: "2.0.0",
                policy: { installation: "AVAILABLE" },
                warnings: [],
                requiresOfficialAuth: false,
                requiresPaidPlan: false,
                hasHooks: false,
              },
            ],
          },
        };
      },
    } as unknown as OfficialPluginMarketplace,
  };
  await assert.rejects(
    handleControlRequest(
      "plugins/install",
      {
        workspace,
        marketplace: market.name,
        pluginName: "example",
      },
      control,
    ),
    /owned by another source/,
  );
  assert.equal(
    calls.some((call) => ["marketplace/add", "plugin/install"].includes(call.method)),
    false,
  );
});

test("official update reports success only after Codex confirms the published version", async () => {
  const { context, plugin, market, replies, calls } = fixture();
  market.name = s.CODEZ_OFFICIAL_PLUGIN_MARKETPLACE_ID;
  market.path = "/isolated/official/.agents/plugins/marketplace.json";
  plugin.id = `example@${market.name}`;
  plugin.version = "2.0.0";
  plugin.localVersion = "1.0.0";
  const control = {
    ...context,
    officialPlugins: {
      async load() {
        return {
          path: market.path,
          catalog: {
            plugins: [
              {
                name: "example",
                version: "2.0.0",
                policy: { installation: "AVAILABLE" },
                warnings: [],
                requiresOfficialAuth: false,
                requiresPaidPlan: false,
                hasHooks: false,
              },
            ],
          },
        };
      },
    } as unknown as OfficialPluginMarketplace,
  };
  const overview = s.codezPluginsOverviewResultSchema.parse(
    await handleControlRequest("plugins/overview", { workspace }, control),
  );
  assert.equal(overview.installedPlugins[0]?.updateStatus, "update-available");
  replies["plugin/install"] = () => ({ authPolicy: "ON_INSTALL", appsNeedingAuth: [] });
  await assert.rejects(
    handleControlRequest("plugins/update", { workspace, pluginId: plugin.id }, control),
    /did not confirm/,
  );
  plugin.localVersion = "2.0.0";
  await assert.rejects(
    handleControlRequest("plugins/update", { workspace, pluginId: plugin.id }, control),
    /already at the published version/,
  );
  assert.equal(calls.filter((call) => call.method === "plugin/install").length, 1);
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

test("official install trusts the plugin's own hooks and reports missing official auth", async () => {
  const { context, calls, replies } = fixture();
  const source = resolve("/isolated/official");
  const official = {
    path: join(source, ".agents", "plugins", "marketplace.json"),
    catalog: {
      plugins: [
        {
          name: "mimosa",
          version: "1.0.3",
          policy: { installation: "AVAILABLE" },
          warnings: ["Some features rely on ZCode node_repl tool, which Codex does not provide"],
          requiresOfficialAuth: true,
          requiresPaidPlan: true,
          hasHooks: true,
        },
      ],
    },
  };
  const registration = { completed: false };
  const existing = {
    name: s.CODEZ_OFFICIAL_PLUGIN_MARKETPLACE_ID,
    path: official.path,
    plugins: [
      {
        ...fixture().plugin,
        id: `mimosa@${s.CODEZ_OFFICIAL_PLUGIN_MARKETPLACE_ID}`,
        name: "mimosa",
        installed: false,
        localVersion: "1.0.3",
      },
    ],
  };
  replies["plugin/list"] = () =>
    registration.completed
      ? { marketplaces: [structuredClone(existing)], marketplaceLoadErrors: [] }
      : { marketplaces: [], marketplaceLoadErrors: [] };
  replies["plugin/installed"] = () => ({
    marketplaces: [{ ...existing, plugins: existing.plugins.filter((entry) => entry.installed) }],
    marketplaceLoadErrors: [],
  });
  replies["marketplace/add"] = () => {
    registration.completed = true;
    return { marketplaceName: existing.name, installedRoot: source, alreadyAdded: false };
  };
  replies["plugin/install"] = () => {
    existing.plugins[0]!.installed = true;
    return { authPolicy: "ON_INSTALL", appsNeedingAuth: [] };
  };
  replies["hooks/list"] = () => ({
    data: [
      {
        cwd: workspace.workspacePath,
        hooks: [
          {
            key: `mimosa@${s.CODEZ_OFFICIAL_PLUGIN_MARKETPLACE_ID}:hooks/hooks.json:session_start:0:0`,
            currentHash: "sha256:abc",
            trustStatus: "untrusted",
            pluginId: `mimosa@${s.CODEZ_OFFICIAL_PLUGIN_MARKETPLACE_ID}`,
          },
          {
            key: "other@market:hooks/hooks.json:stop:0:0",
            currentHash: "sha256:def",
            trustStatus: "untrusted",
            pluginId: "other@market",
          },
        ],
      },
    ],
  });
  const control = {
    ...context,
    officialPlugins: {
      async load() {
        return official;
      },
      async refresh() {
        return official;
      },
    } as unknown as OfficialPluginMarketplace,
  };

  const overview = s.codezPluginsOverviewResultSchema.parse(
    await handleControlRequest("plugins/overview", { workspace }, control),
  );
  const card = overview.availablePlugins.find((plugin) => plugin.name === "mimosa");
  assert.equal(card?.officialAuthRequired, true);
  assert.equal(card?.listing?.requiresPaidPlan, true);
  assert.deepEqual(card?.officialWarnings, official.catalog.plugins[0]!.warnings);

  const tokenBefore = process.env.CODEZ_ZAI_OFFICIAL_MCP_TOKEN;
  delete process.env.CODEZ_ZAI_OFFICIAL_MCP_TOKEN;
  try {
    const result = s.codezPluginsInstallResultSchema.parse(
      await handleControlRequest(
        "plugins/install",
        { workspace, pluginName: "mimosa", marketplace: s.CODEZ_OFFICIAL_PLUGIN_MARKETPLACE_ID },
        control,
      ),
    );
    assert.equal(result.installedPlugins[0]?.name, "mimosa");
    assert.ok(
      result.diagnostics.some((diagnostic) => diagnostic.code === "codex_official_auth_missing"),
    );
  } finally {
    if (tokenBefore !== undefined) process.env.CODEZ_ZAI_OFFICIAL_MCP_TOKEN = tokenBefore;
  }
  // 只为该官方插件的钩子写信任；其它插件的钩子绝不动。
  const trustWrites = calls.filter(
    (call) =>
      call.method === "config/value/write" &&
      typeof call.params.keyPath === "string" &&
      call.params.keyPath.startsWith("hooks.state."),
  );
  assert.equal(trustWrites.length, 1);
  assert.deepEqual(trustWrites[0]?.params, {
    keyPath: `hooks.state."mimosa@codez-plugins-official:hooks/hooks.json:session_start:0:0".trusted_hash`,
    value: "sha256:abc",
    mergeStrategy: "replace",
  });
});

/** 设置 → Codex 面板的原生透传线束：官方市场存根 + 状态化原生 plugin/list。 */
function officialNativeFixture(options?: { registered?: boolean }) {
  const OFFICIAL = s.CODEZ_OFFICIAL_PLUGIN_MARKETPLACE_ID;
  const source = resolve("/isolated/official");
  const path = join(source, ".agents", "plugins", "marketplace.json");
  const snapshot = {
    path,
    catalog: {
      plugins: [
        {
          name: "mimosa",
          version: "1.0.3",
          policy: { installation: "AVAILABLE" },
          warnings: [],
          requiresOfficialAuth: false,
          requiresPaidPlan: false,
          hasHooks: true,
        },
      ],
    },
  };
  const personal = {
    name: "market",
    path: "/market/.agents/plugins/marketplace.json",
    plugins: [
      {
        id: "example@market",
        name: "example",
        installed: false,
        enabled: true,
        version: "2.0",
        localVersion: "2.0",
        installedAt: 1000,
        source: { type: "local", path: "/plugins/example" },
        interface: null,
      },
    ],
  };
  const state = { registered: options?.registered ?? false };
  const calls: { method: string; params: Record<string, unknown> }[] = [];
  let refreshCount = 0;
  const officialPlugins = {
    path,
    async load() {
      return snapshot;
    },
    async refresh() {
      refreshCount++;
      return snapshot;
    },
  } as unknown as OfficialPluginMarketplace;
  const marketplaces = () => [
    ...(state.registered
      ? [
          {
            name: OFFICIAL,
            path,
            plugins: [
              {
                id: `mimosa@${OFFICIAL}`,
                name: "mimosa",
                installed: false,
                enabled: true,
                version: "1.0.3",
                localVersion: "1.0.3",
                installedAt: 1000,
                source: { type: "local", path },
                interface: null,
              },
            ],
          },
        ]
      : []),
    structuredClone(personal),
  ];
  const rpc: CodexRpcPort = {
    async request<T>(method: string, params: unknown): Promise<T> {
      calls.push({ method, params: params as Record<string, unknown> });
      if (method === "plugin/list")
        return { marketplaces: marketplaces(), marketplaceLoadErrors: [] } as T;
      if (method === "marketplace/add") {
        state.registered = true;
        return { marketplaceName: OFFICIAL, installedRoot: source, alreadyAdded: false } as T;
      }
      if (method === "plugin/install")
        return { authPolicy: "ON_INSTALL", appsNeedingAuth: [] } as T;
      if (method === "hooks/list")
        return {
          data: [
            {
              cwd: workspace.workspacePath,
              hooks: [
                {
                  key: `mimosa@${OFFICIAL}:hooks/hooks.json:session_start:0:0`,
                  pluginId: `mimosa@${OFFICIAL}`,
                  currentHash: "sha256:abc",
                  trustStatus: "untrusted",
                },
              ],
            },
          ],
        } as T;
      if (method === "config/value/write")
        return {
          status: "ok",
          version: "v1",
          filePath: "/isolated/config.toml",
          overriddenMetadata: null,
        } as T;
      throw new Error(`Unexpected RPC ${method}`);
    },
    async respond() {},
    async respondError() {},
  };
  const context = { rpc, cwd: workspace.workspacePath, officialPlugins };
  const publish = async () => {};
  return {
    calls,
    context,
    officialPlugins,
    path,
    source,
    publish,
    refreshCount: () => refreshCount,
  };
}

test("native plugin/list registers the built-in official marketplace exactly once", async () => {
  const h = officialNativeFixture();
  const listed = async () =>
    (
      (await handleCodexNativeRequest({ method: "plugin/list", params: {} }, h.context, h.publish))
        .result as { marketplaces: { name: string }[] }
    ).marketplaces;
  assert.ok(
    (await listed()).some((market) => market.name === s.CODEZ_OFFICIAL_PLUGIN_MARKETPLACE_ID),
  );
  assert.deepEqual(h.calls.find((call) => call.method === "marketplace/add")?.params, {
    source: h.source,
  });
  assert.ok(
    (await listed()).some((market) => market.name === s.CODEZ_OFFICIAL_PLUGIN_MARKETPLACE_ID),
  );
  assert.equal(h.calls.filter((call) => call.method === "marketplace/add").length, 1);
});

test("cached-only warm-up registers from the disk snapshot and never refreshes", async () => {
  const h = officialNativeFixture();
  assert.equal(await ensureOfficialRegistered(h.context, { cachedOnly: true }), true);
  assert.equal(h.refreshCount(), 0);
  assert.equal(h.calls.filter((call) => call.method === "marketplace/add").length, 1);
});

test("cached-only warm-up without a snapshot is a silent no-op", async () => {
  const h = officialNativeFixture();
  (h.officialPlugins as unknown as { load: () => Promise<null> }).load = async () => null;
  assert.equal(await ensureOfficialRegistered(h.context, { cachedOnly: true }), false);
  assert.equal(h.calls.length, 0);
});

test("official registration failure never breaks the native read and is retried", async () => {
  const h = officialNativeFixture();
  let failures = 0;
  (h.officialPlugins as unknown as { load: () => Promise<null> }).load = async () => null;
  (h.officialPlugins as unknown as { refresh: () => Promise<never> }).refresh = async () => {
    failures++;
    throw new Error("CDN offline");
  };
  const listed = await handleCodexNativeRequest(
    { method: "plugin/list", params: {} },
    h.context,
    h.publish,
  );
  assert.deepEqual(
    (listed.result as { marketplaces: { name: string }[] }).marketplaces.map((m) => m.name),
    ["market"],
  );
  assert.equal(failures, 1);
  assert.equal(
    h.calls.some((call) => call.method === "marketplace/add"),
    false,
  );
  await handleCodexNativeRequest({ method: "plugin/list", params: {} }, h.context, h.publish);
  assert.equal(failures, 2);
});

test("native marketplace/remove cannot drop the built-in official marketplace", async () => {
  const h = officialNativeFixture({ registered: true });
  await assert.rejects(
    handleCodexNativeRequest(
      {
        method: "marketplace/remove",
        params: { marketplaceName: s.CODEZ_OFFICIAL_PLUGIN_MARKETPLACE_ID },
      },
      h.context,
      h.publish,
    ),
    { code: -32000 },
  );
  assert.equal(h.calls.length, 0);
});

test("native marketplace/upgrade of the official marketplace runs the refresh pipeline", async () => {
  const h = officialNativeFixture({ registered: true });
  const result = await handleCodexNativeRequest(
    {
      method: "marketplace/upgrade",
      params: { marketplaceName: s.CODEZ_OFFICIAL_PLUGIN_MARKETPLACE_ID },
    },
    h.context,
    h.publish,
  );
  assert.deepEqual(result.result, {
    selectedMarketplaces: [s.CODEZ_OFFICIAL_PLUGIN_MARKETPLACE_ID],
    upgradedRoots: [],
    errors: [],
  });
  assert.equal(h.refreshCount(), 1);
  assert.equal(h.calls.length, 0);
  (h.officialPlugins as unknown as { refresh: () => Promise<never> }).refresh = async () => {
    throw new Error("tampered catalog");
  };
  await assert.rejects(
    handleCodexNativeRequest(
      {
        method: "marketplace/upgrade",
        params: { marketplaceName: s.CODEZ_OFFICIAL_PLUGIN_MARKETPLACE_ID },
      },
      h.context,
      h.publish,
    ),
    /refresh failed verification/,
  );
});

test("native install from the official marketplace path trusts only the plugin's hooks", async () => {
  const h = officialNativeFixture({ registered: true });
  const result = await handleCodexNativeRequest(
    { method: "plugin/install", params: { pluginName: "mimosa", marketplacePath: h.path } },
    h.context,
    h.publish,
  );
  assert.equal((result.result as { authPolicy: string }).authPolicy, "ON_INSTALL");
  const trustWrites = h.calls.filter((call) => call.method === "config/value/write");
  assert.equal(trustWrites.length, 1);
  assert.deepEqual(trustWrites[0]?.params, {
    keyPath: `hooks.state."mimosa@${s.CODEZ_OFFICIAL_PLUGIN_MARKETPLACE_ID}:hooks/hooks.json:session_start:0:0".trusted_hash`,
    value: "sha256:abc",
    mergeStrategy: "replace",
  });
});

test("native installs from personal marketplaces never receive official hook trust", async () => {
  const h = officialNativeFixture({ registered: true });
  await handleCodexNativeRequest(
    {
      method: "plugin/install",
      params: {
        pluginName: "example",
        marketplacePath: "/market/.agents/plugins/marketplace.json",
      },
    },
    h.context,
    h.publish,
  );
  assert.equal(
    h.calls.some((call) => call.method === "hooks/list"),
    false,
  );
  assert.equal(
    h.calls.some((call) => call.method === "config/value/write"),
    false,
  );
});
