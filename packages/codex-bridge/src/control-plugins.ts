import { z } from "zod";
import * as s from "@zcode/shared";
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

function failure(method: string, reason: string): never {
  throw new ControlError(-32000, `${method}: ${reason}`, { method, reason });
}

export async function handlePluginRequest(
  method: string,
  params: unknown,
  context: BridgeControlContext,
): Promise<unknown> {
  if (method === "plugins/overview") {
    const p = input(s.zcodePluginsOverviewParamsSchema, params, method);
    checkWorkspace(p.workspace, context, method);
    if (p.configScope === "workspace")
      unsupported(method, "Workspace-only plugin configuration is not exposed by Codex");
    const catalog = await readPluginCatalog(context);
    const installed = await readPluginCatalog(context, true);
    return s.zcodePluginsOverviewResultSchema.parse({
      marketplaces: catalog.marketplaces.map((market) =>
        marketplaceSummary(market, catalog.featuredPluginIds),
      ),
      availablePlugins: catalog.rows.map(({ market, plugin }) => ({
        id: plugin.id,
        name: plugin.name,
        marketplace: market.name,
        installed: plugin.installed,
        version: plugin.version ?? undefined,
        description: plugin.interface?.shortDescription ?? undefined,
        listing: pluginListing(plugin),
      })),
      installedPlugins: installed.rows.filter((row) => row.plugin.installed).map(installedPlugin),
      restorableBuiltins: [],
      diagnostics: [...catalog.diagnostics, ...installed.diagnostics],
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
      ? input(s.zcodePluginsListParamsSchema, params, method)
      : input(s.zcodePluginsReferenceCatalogParamsSchema, params, method);
    checkWorkspace(p.workspace, context, method);
    if ("sessionId" in p && p.sessionId)
      unsupported(method, "Frozen session plugin catalogs are not exposed by Codex");
    if ("configScope" in p && p.configScope === "workspace")
      unsupported(method, "Workspace-only plugin configuration is not exposed by Codex");
    const catalog = await readPluginCatalog(context, true);
    const rows = catalog.rows.filter((row) => row.plugin.installed);
    const details = await Promise.all(rows.map((row) => readPluginDetail(context, row)));
    if (isList)
      return s.zcodePluginsListResultSchema.parse({
        plugins: rows.map((row, index) => pluginInfo(row, details[index]!)),
        diagnostics: catalog.diagnostics,
      });
    if (catalog.diagnostics.length)
      failure(method, "Plugin discovery failed; a complete reference catalog is unavailable");
    return s.zcodePluginsReferenceCatalogResultSchema.parse({
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
        skillQualifiedNames: details[index]!.skills.filter((skill) => skill.enabled).map(
          (skill) => `${plugin.name}:${skill.name}`,
        ),
        mcpServerNames: details[index]!.mcpServers,
        subagentNames: [],
      })),
    });
  }
  if (method === "plugins/describe") {
    const p = input(s.zcodePluginsDescribeParamsSchema, params, method);
    checkWorkspace(p.workspace, context, method);
    const catalog = await readPluginCatalog(context);
    const detail = await readPluginDetail(context, findPlugin(catalog.rows, method, p));
    return s.zcodePluginsDescribeResultSchema.parse({
      components: pluginComponents(detail),
      diagnostics: catalog.diagnostics,
    });
  }
  if (method === "plugins/setEnabled") {
    const p = input(s.zcodePluginsSetEnabledParamsSchema, params, method);
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
    return s.zcodePluginsSetEnabledResultSchema.parse({
      plugin: pluginInfo(refreshed, detail),
      enabled: p.enabled,
    });
  }
  if (method === "plugins/install") {
    const p = input(s.zcodePluginsInstallParamsSchema, params, method);
    checkWorkspace(p.workspace, context, method);
    if (p.scope === "workspace" || p.dryRun)
      unsupported(method, "Codex plugin/install has no workspace scope or dry-run contract");
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
    return s.zcodePluginsInstallResultSchema.parse({
      installedPlugins: [installedPlugin(refreshed)],
      dependencyClosure: [refreshed.plugin.id],
      diagnostics: [
        ...after.diagnostics,
        ...(installed.appsNeedingAuth.length
          ? [
              {
                code: "codex_plugin_auth_required",
                message: "Installed plugin requires app authentication in Codex",
                severity: "warning",
              },
            ]
          : []),
      ],
    });
  }
  if (method === "plugins/uninstall") {
    const p = input(s.zcodePluginsUninstallParamsSchema, params, method);
    checkWorkspace(p.workspace, context, method);
    if (p.removeCache !== undefined)
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
    return s.zcodePluginsUninstallResultSchema.parse({
      removedPlugin: installedPlugin(row),
      diagnostics: [],
    });
  }
  if (method.startsWith("plugins/marketplace/"))
    return handleMarketplaceRequest(method, params, context);
  return unsupported(method, "No faithful Codex control-plane mapping");
}

async function handleMarketplaceRequest(
  method: string,
  params: unknown,
  context: BridgeControlContext,
) {
  let selected: string | undefined;
  if (method === "plugins/marketplace/add") {
    const p = input(s.zcodePluginsMarketplaceAddParamsSchema, params, method);
    checkWorkspace(p.workspace, context, method);
    if (p.dryRun) unsupported(method, "Codex marketplace/add does not support dry-run");
    const added = z
      .object({ marketplaceName: z.string(), installedRoot: z.string(), alreadyAdded: z.boolean() })
      .parse(await context.rpc.request("marketplace/add", { source: p.source }));
    selected = added.marketplaceName;
  } else if (method === "plugins/marketplace/remove") {
    const p = input(s.zcodePluginsMarketplaceRemoveParamsSchema, params, method);
    checkWorkspace(p.workspace, context, method);
    const removed = z
      .object({ marketplaceName: z.string(), installedRoot: z.string().nullable() })
      .parse(await context.rpc.request("marketplace/remove", { marketplaceName: p.marketplace }));
    if (removed.marketplaceName !== p.marketplace)
      failure(method, "Codex confirmed removal of a different marketplace");
  } else if (method === "plugins/marketplace/update") {
    const p = input(s.zcodePluginsMarketplaceUpdateParamsSchema, params, method);
    checkWorkspace(p.workspace, context, method);
    const result = z
      .object({
        selectedMarketplaces: z.array(z.string()),
        upgradedRoots: z.array(z.string()),
        errors: z.array(z.object({ marketplaceName: z.string(), message: z.string() })),
      })
      .parse(
        await context.rpc.request(
          "marketplace/upgrade",
          p.marketplace ? { marketplaceName: p.marketplace } : {},
        ),
      );
    if (result.errors.length)
      failure(
        method,
        result.errors.map((error) => `${error.marketplaceName}: ${error.message}`).join("; "),
      );
    if (p.marketplace && !result.selectedMarketplaces.includes(p.marketplace))
      failure(method, "Codex did not select the requested marketplace for upgrade");
    selected = p.marketplace;
  } else return unsupported(method, "Unknown marketplace operation");
  const catalog = await readPluginCatalog(context);
  const marketplaces = catalog.marketplaces.map((market) =>
    marketplaceSummary(market, catalog.featuredPluginIds),
  );
  const marketplace = marketplaces.find((market) => market.name === selected);
  if (selected && !marketplace)
    failure(method, "Mutated marketplace is not visible in Codex catalog");
  return s.zcodePluginsMarketplaceMutationResultSchema.parse({
    marketplace,
    marketplaces,
    diagnostics: catalog.diagnostics,
  });
}
