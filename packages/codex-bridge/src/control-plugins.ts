import { z } from "zod";
import * as s from "@codez/shared";
import type { BridgeControlContext } from "./contract.js";
import { checkWorkspace, ControlError, input, unsupported } from "./control-common.js";
import {
  findPlugin,
  installedPlugin,
  marketplaceSummary,
  pluginAddress,
  pluginComponents,
  pluginInfo,
  pluginListing,
  readPluginCatalog,
  readPluginDetail,
} from "./control-plugin-data.js";
import {
  OFFICIAL,
  handleMarketplaceRequest,
  officialEntry,
  officialSnapshot,
  projectOfficialCatalog,
  registerOfficial,
  trustOfficialPluginHooks,
} from "./control-official-plugins.js";

function failure(method: string, reason: string): never {
  throw new ControlError(-32000, `${method}: ${reason}`, { method, reason });
}

export async function handlePluginRequest(
  method: string,
  params: unknown,
  context: BridgeControlContext,
): Promise<unknown> {
  if (method === "plugins/overview") {
    const p = input(s.codezPluginsOverviewParamsSchema, params, method);
    checkWorkspace(p.workspace, context, method);
    if (p.configScope === "workspace")
      unsupported(method, "Workspace-only plugin configuration is not exposed by Codex");
    const catalog = await readPluginCatalog(context);
    const installed = await readPluginCatalog(context, true);
    const official = await officialSnapshot(context);
    const nativeOfficial = catalog.marketplaces.find((market) => market.name === OFFICIAL);
    const officialView = projectOfficialCatalog(
      official.snapshot,
      nativeOfficial?.plugins.map((plugin) => plugin.name) ?? [],
    );
    return s.codezPluginsOverviewResultSchema.parse({
      marketplaces: [
        ...catalog.marketplaces
          .map((market) => marketplaceSummary(market, catalog.featuredPluginIds))
          .map((market) => (market.id === OFFICIAL ? { ...market, isOfficial: true } : market)),
        ...(!nativeOfficial && officialView.marketplace ? [officialView.marketplace] : []),
      ],
      availablePlugins: [
        ...catalog.rows.map(({ market, plugin }) => {
          const officialMeta =
            market.name === OFFICIAL ? officialEntry(official.snapshot, plugin.name) : undefined;
          return {
            id: plugin.id,
            name: plugin.name,
            marketplace: market.name,
            installed: plugin.installed,
            version: plugin.version ?? undefined,
            description: plugin.interface?.shortDescription ?? undefined,
            listing: pluginListing(plugin),
            ...(officialMeta?.policy.installation === "NOT_AVAILABLE"
              ? {
                  installationUnavailableReason:
                    officialMeta.unavailableReason ??
                    "This ZCode plugin requires components unsupported by Codex",
                }
              : {}),
            ...(officialMeta && officialMeta.warnings.length
              ? { officialWarnings: officialMeta.warnings }
              : {}),
            ...(officialMeta?.requiresOfficialAuth ? { officialAuthRequired: true as const } : {}),
          };
        }),
        ...officialView.availablePlugins,
      ],
      installedPlugins: installed.rows
        .filter((row) => row.plugin.installed)
        .map((row) => {
          const result = installedPlugin(row);
          const latest =
            row.market.name === OFFICIAL
              ? officialEntry(official.snapshot, row.plugin.name)?.version
              : undefined;
          if (latest && result.version && latest !== result.version)
            return { ...result, latestVersion: latest, updateStatus: "update-available" as const };
          return result;
        }),
      restorableBuiltins: [],
      diagnostics: [...catalog.diagnostics, ...installed.diagnostics, ...official.diagnostics],
      capability: { supported: true },
    });
  }
  if (
    method === "plugins/list" ||
    method === "plugins/referenceCatalog" ||
    method === "plugins/referenceCatalogWithCategory"
  ) {
    const isList = method === "plugins/list";
    const p = isList
      ? input(s.codezPluginsListParamsSchema, params, method)
      : input(s.codezPluginsReferenceCatalogParamsSchema, params, method);
    checkWorkspace(p.workspace, context, method);
    if ("sessionId" in p && p.sessionId)
      unsupported(method, "Frozen session plugin catalogs are not exposed by Codex");
    if ("configScope" in p && p.configScope === "workspace")
      unsupported(method, "Workspace-only plugin configuration is not exposed by Codex");
    const catalog = await readPluginCatalog(context, true);
    const rows = catalog.rows.filter((row) => row.plugin.installed);
    const details = await Promise.all(rows.map((row) => readPluginDetail(context, row)));
    if (isList)
      return s.codezPluginsListResultSchema.parse({
        plugins: rows.map((row, index) => pluginInfo(row, details[index]!)),
        diagnostics: catalog.diagnostics,
      });
    if (catalog.diagnostics.length)
      failure(method, "Plugin discovery failed; a complete reference catalog is unavailable");
    return s.codezPluginsReferenceCatalogResultSchema.parse({
      authority: "workspace",
      plugins: rows.map(({ plugin, market }, index) => ({
        pluginId: plugin.id,
        name: plugin.name,
        marketplace: market.name,
        enabled: plugin.enabled,
        description: plugin.interface?.shortDescription ?? undefined,
        displayName: plugin.interface?.displayName ?? undefined,
        icon: pluginListing(plugin)?.icon,
        ...(method.endsWith("WithCategory") && plugin.interface?.category
          ? { category: plugin.interface.category }
          : {}),
        conflictingPluginIds: plugin.enabled
          ? rows
              .filter(
                (row) =>
                  row.plugin.enabled &&
                  row.plugin.name === plugin.name &&
                  row.plugin.id !== plugin.id,
              )
              .map((row) => row.plugin.id)
          : [],
        skillQualifiedNames: details[index]!.skills.filter((skill) => skill.enabled).map((skill) =>
          skill.name.startsWith(`${plugin.name}:`) ? skill.name : `${plugin.name}:${skill.name}`,
        ),
        mcpServerNames: details[index]!.mcpServers,
        subagentNames: [],
      })),
    });
  }
  if (method === "plugins/describe") {
    const p = input(s.codezPluginsDescribeParamsSchema, params, method);
    checkWorkspace(p.workspace, context, method);
    const catalog = await readPluginCatalog(context);
    if (
      p.marketplace === OFFICIAL &&
      !catalog.rows.some((row) => row.market.name === OFFICIAL && row.plugin.name === p.pluginName)
    ) {
      const { snapshot } = await officialSnapshot(context);
      if (!officialEntry(snapshot, p.pluginName))
        failure(method, "Official plugin is not present in the verified catalog");
      return s.codezPluginsDescribeResultSchema.parse({
        components: [],
        diagnostics: [],
      });
    }
    const detail = await readPluginDetail(context, findPlugin(catalog.rows, method, p));
    return s.codezPluginsDescribeResultSchema.parse({
      components: pluginComponents(detail),
      diagnostics: catalog.diagnostics,
    });
  }
  if (method === "plugins/setEnabled") {
    const p = input(s.codezPluginsSetEnabledParamsSchema, params, method);
    checkWorkspace(p.workspace, context, method);
    if (p.scope === "workspace")
      unsupported(method, "Workspace-scoped plugin writes are not mapped");
    const before = await readPluginCatalog(context, true);
    const row = findPlugin(before.rows, method, p);
    if (!row.plugin.installed) failure(method, "Plugin is not installed");
    const written = z
      .object({ status: z.enum(["ok", "okOverridden"]), version: z.string(), filePath: z.string() })
      .parse(
        await context.rpc.request("config/value/write", {
          keyPath: `plugins.${JSON.stringify(row.plugin.id)}.enabled`,
          value: p.enabled,
          mergeStrategy: "replace",
        }),
      );
    if (written.status !== "ok")
      failure(method, "Plugin enablement was overridden by a higher-priority configuration");
    const after = await readPluginCatalog(context, true);
    const refreshed = findPlugin(after.rows, method, p);
    const detail = await readPluginDetail(context, refreshed);
    if (detail.summary.enabled !== p.enabled)
      failure(method, "Codex has not confirmed the requested enablement");
    return s.codezPluginsSetEnabledResultSchema.parse({
      plugin: pluginInfo(refreshed, detail),
      enabled: p.enabled,
    });
  }
  if (method === "plugins/install") {
    const p = input(s.codezPluginsInstallParamsSchema, params, method);
    checkWorkspace(p.workspace, context, method);
    if (p.scope === "workspace" || p.dryRun)
      unsupported(method, "Codex plugin/install has no workspace scope or dry-run contract");
    let officialVersion: string | undefined;
    let officialMeta: ReturnType<typeof officialEntry>;
    if (p.marketplace === OFFICIAL && context.officialPlugins) {
      const { snapshot } = await officialSnapshot(context);
      if (!snapshot) failure(method, "Official catalog is not available");
      const entry = officialEntry(snapshot, p.pluginName);
      if (!entry) failure(method, "Plugin is not in the verified official catalog");
      if (entry.policy.installation !== "AVAILABLE")
        failure(method, "This plugin is not compatible with Codex");
      officialVersion = entry.version;
      officialMeta = entry;
      await registerOfficial(method, context, snapshot);
    }
    const catalog = await readPluginCatalog(context);
    const row = findPlugin(catalog.rows, method, p);
    const installed = z
      .object({ authPolicy: z.string(), appsNeedingAuth: z.array(z.unknown()) })
      .parse(
        await context.rpc.request("plugin/install", {
          ...pluginAddress(row),
          ...(p.operationId ? { installAttemptId: p.operationId } : {}),
        }),
      );
    const after = await readPluginCatalog(context, true);
    const refreshed = findPlugin(after.rows, method, { pluginId: row.plugin.id });
    if (!refreshed.plugin.installed) failure(method, "Codex has not confirmed installation");
    if (
      officialVersion &&
      (refreshed.plugin.localVersion ?? refreshed.plugin.version) !== officialVersion
    )
      failure(method, "Codex did not confirm the published plugin version");
    const hookDiagnostics = officialMeta?.hasHooks
      ? await trustOfficialPluginHooks(context, refreshed.plugin.id)
      : [];
    return s.codezPluginsInstallResultSchema.parse({
      installedPlugins: [installedPlugin(refreshed)],
      dependencyClosure: [refreshed.plugin.id],
      diagnostics: [
        ...after.diagnostics,
        ...hookDiagnostics,
        ...(officialMeta?.requiresOfficialAuth && !process.env.CODEZ_ZAI_OFFICIAL_MCP_TOKEN
          ? [
              {
                code: "codex_official_auth_missing",
                message:
                  "This plugin's official data services require a signed-in z.ai account; sign in and reopen the workspace",
                severity: "warning" as const,
              },
            ]
          : []),
        ...(installed.appsNeedingAuth.length
          ? [
              {
                code: "codex_plugin_auth_required",
                message: "Installed plugin requires app authentication in Codex",
                severity: "warning" as const,
              },
            ]
          : []),
      ],
    });
  }
  if (method === "plugins/update") {
    const p = input(s.codezPluginsUpdateParamsSchema, params, method);
    checkWorkspace(p.workspace, context, method);
    const { snapshot } = await officialSnapshot(context);
    if (!snapshot || !p.pluginId)
      unsupported(method, "Only verified official plugin updates are supported");
    const before = await readPluginCatalog(context, true);
    const row = findPlugin(before.rows, method, p);
    if (row.market.name !== OFFICIAL || !row.plugin.installed)
      unsupported(method, "Only installed official plugins can be updated");
    const entry = officialEntry(snapshot, row.plugin.name);
    if (!entry || entry.policy.installation !== "AVAILABLE")
      failure(method, "The published plugin is not compatible with Codex");
    const current = row.plugin.localVersion ?? row.plugin.version;
    if (current === entry.version)
      failure(method, "The installed plugin is already at the published version");
    z.object({ authPolicy: z.string(), appsNeedingAuth: z.array(z.unknown()) }).parse(
      await context.rpc.request("plugin/install", pluginAddress(row)),
    );
    const after = await readPluginCatalog(context, true);
    const refreshed = findPlugin(after.rows, method, { pluginId: row.plugin.id });
    if (
      !refreshed.plugin.installed ||
      (refreshed.plugin.localVersion ?? refreshed.plugin.version) !== entry.version
    )
      failure(method, "Codex did not confirm the plugin update; previous install remains visible");
    // 更新改变了钩子哈希；同一信任流程重新落信任，失败只降级为警告。
    const hookDiagnostics = entry.hasHooks
      ? await trustOfficialPluginHooks(context, refreshed.plugin.id)
      : [];
    return s.codezPluginsInstallResultSchema.parse({
      installedPlugins: [installedPlugin(refreshed)],
      dependencyClosure: [refreshed.plugin.id],
      diagnostics: [...after.diagnostics, ...hookDiagnostics],
    });
  }
  if (method === "plugins/uninstall") {
    const p = input(s.codezPluginsUninstallParamsSchema, params, method);
    checkWorkspace(p.workspace, context, method);
    if (p.removeCache === false)
      unsupported(method, "Codex does not expose cache-retention control");
    const before = await readPluginCatalog(context, true);
    const row = findPlugin(before.rows, method, p);
    if (!row.plugin.installed) failure(method, "Plugin is not installed");
    z.object({})
      .strict()
      .parse(await context.rpc.request("plugin/uninstall", { pluginId: row.plugin.id }));
    const after = await readPluginCatalog(context, true);
    if (
      after.diagnostics.length ||
      after.rows.some((entry) => entry.plugin.id === row.plugin.id && entry.plugin.installed)
    )
      failure(method, "Codex has not confirmed removal");
    return s.codezPluginsUninstallResultSchema.parse({
      removedPlugin: installedPlugin(row),
      diagnostics: [],
    });
  }
  if (method.startsWith("plugins/marketplace/"))
    return handleMarketplaceRequest(method, params, context);
  return unsupported(method, "No faithful Codex control-plane mapping");
}
