import { dirname } from "node:path";
import { z } from "zod";
import {
  zcodePluginInfoSchema,
  zcodeInstalledPluginSummarySchema,
  type ZCodePluginComponentGroup,
} from "@zcode/shared";
import type { BridgeControlContext } from "./contract.js";
import { ControlError } from "./control-common.js";

const nullableText = z.string().nullable().optional();
const summarySchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  installed: z.boolean(),
  enabled: z.boolean(),
  version: nullableText,
  localVersion: nullableText,
  installedAt: z.number().nullable().optional(),
  source: z.discriminatedUnion("type", [
    z.object({ type: z.literal("local"), path: z.string() }),
    z.object({
      type: z.literal("git"),
      url: z.string(),
      path: z.string().nullable(),
      refName: nullableText,
      sha: nullableText,
    }),
    z.object({
      type: z.literal("npm"),
      package: z.string(),
      version: nullableText,
      registry: nullableText,
    }),
    z.object({ type: z.literal("remote") }),
  ]),
  interface: z
    .object({
      displayName: nullableText,
      shortDescription: nullableText,
      longDescription: nullableText,
      developerName: nullableText,
      category: nullableText,
      websiteUrl: nullableText,
      privacyPolicyUrl: nullableText,
      termsOfServiceUrl: nullableText,
      composerIcon: nullableText,
      composerIconUrl: nullableText,
      logoUrl: nullableText,
      defaultPrompt: z.array(z.string()).nullable().optional(),
    })
    .nullable(),
});
const marketplaceSchema = z.object({
  name: z.string().min(1),
  path: z.string().nullable(),
  plugins: z.array(summarySchema),
});
const catalogSchema = z.object({
  marketplaces: z.array(marketplaceSchema),
  marketplaceLoadErrors: z.array(z.object({ marketplacePath: z.string(), message: z.string() })),
  featuredPluginIds: z.array(z.string()).optional(),
});
const detailSchema = z.object({
  plugin: z.object({
    marketplaceName: z.string(),
    marketplacePath: z.string().nullable(),
    summary: summarySchema,
    description: z.string().nullable(),
    skills: z.array(
      z.object({
        name: z.string(),
        description: z.string(),
        path: z.string().nullable(),
        enabled: z.boolean(),
      }),
    ),
    hooks: z.array(z.object({ key: z.string(), eventName: z.string() })),
    mcpServers: z.array(z.string()),
  }),
});
export type PluginRow = {
  market: z.infer<typeof marketplaceSchema>;
  plugin: z.infer<typeof summarySchema>;
};
type PluginDetail = z.infer<typeof detailSchema>["plugin"];

export async function readPluginCatalog(context: BridgeControlContext, installedOnly = false) {
  const result = catalogSchema.parse(
    await context.rpc.request(installedOnly ? "plugin/installed" : "plugin/list", {
      cwds: [context.cwd],
    }),
  );
  return {
    ...result,
    rows: result.marketplaces.flatMap((market) =>
      market.plugins.map((plugin) => ({ market, plugin })),
    ),
    diagnostics: result.marketplaceLoadErrors.map((error) => ({
      code: "codex_marketplace_load_failed",
      message: error.message,
      severity: "error" as const,
    })),
  };
}

export function findPlugin(
  rows: PluginRow[],
  method: string,
  identity: { pluginId?: string; pluginName?: string; marketplace?: string },
): PluginRow {
  if (!identity.pluginId && !(identity.pluginName && identity.marketplace)) {
    throw new ControlError(-32602, "Specify pluginId or pluginName and marketplace", {
      method,
      reason: "missing_plugin_identity",
    });
  }
  const matches = rows.filter(
    ({ market, plugin }) =>
      (!identity.pluginId || plugin.id === identity.pluginId) &&
      (!identity.pluginName || plugin.name === identity.pluginName) &&
      (!identity.marketplace || market.name === identity.marketplace),
  );
  if (matches.length !== 1)
    throw new ControlError(-32000, "Plugin identity is missing or ambiguous", {
      method,
      reason: "plugin_not_unique",
    });
  return matches[0]!;
}

export function pluginAddress(row: PluginRow) {
  // 远程目录没有本地 path，不能把 marketplace 名字伪装成文件路径。
  return {
    pluginName: row.plugin.name,
    ...(row.market.path
      ? { marketplacePath: row.market.path }
      : { remoteMarketplaceName: row.market.name }),
  };
}

export async function readPluginDetail(context: BridgeControlContext, row: PluginRow) {
  const detail = detailSchema.parse(
    await context.rpc.request("plugin/read", pluginAddress(row)),
  ).plugin;
  if (detail.summary.id !== row.plugin.id || detail.marketplaceName !== row.market.name) {
    throw new Error("Codex plugin/read returned a different plugin identity");
  }
  return detail;
}

export function pluginComponents(detail: PluginDetail): ZCodePluginComponentGroup[] {
  return [
    {
      kind: "skill",
      items: detail.skills.map((skill) => ({ name: skill.name, description: skill.description })),
    },
    { kind: "mcp", items: detail.mcpServers.map((name) => ({ name })) },
    {
      kind: "hook",
      items: detail.hooks.map((hook) => ({ name: hook.key, description: hook.eventName })),
    },
  ];
}

export function pluginListing(plugin: PluginRow["plugin"]) {
  const ui = plugin.interface;
  if (!ui) return undefined;
  return {
    displayName: ui.displayName ?? undefined,
    category: ui.category ?? undefined,
    author: ui.developerName ?? undefined,
    homepage: ui.websiteUrl ?? undefined,
    privacyPolicy: ui.privacyPolicyUrl ?? undefined,
    termsOfService: ui.termsOfServiceUrl ?? undefined,
    icon: ui.composerIconUrl ?? ui.composerIcon ?? ui.logoUrl ?? undefined,
    examplePrompts: ui.defaultPrompt ?? undefined,
  };
}

export function installedPlugin({ market, plugin }: PluginRow) {
  return zcodeInstalledPluginSummarySchema.parse({
    id: plugin.id,
    name: plugin.name,
    marketplace: market.name,
    description: plugin.interface?.shortDescription ?? undefined,
    version: plugin.localVersion ?? plugin.version ?? undefined,
    enabled: plugin.enabled,
    scope: "user",
    ...(plugin.source.type === "local" ? { installPath: plugin.source.path } : {}),
    ...(plugin.installedAt != null
      ? { installedAt: new Date(plugin.installedAt * 1000).toISOString() }
      : {}),
    listing: pluginListing(plugin),
  });
}

export function pluginInfo(row: PluginRow, detail: PluginDetail) {
  const plugin = detail.summary;
  return zcodePluginInfoSchema.parse({
    id: plugin.id,
    name: plugin.name,
    marketplace: row.market.name,
    description: detail.description ?? plugin.interface?.shortDescription ?? undefined,
    version: plugin.localVersion ?? plugin.version ?? undefined,
    enabled: plugin.enabled,
    source: plugin.source.type,
    skillCount: detail.skills.length,
    skillRootCount: new Set(
      detail.skills.flatMap((skill) => (skill.path ? [dirname(skill.path)] : [])),
    ).size,
    commandRootCount: 0,
    components: pluginComponents(detail),
    mcpServerNames: detail.mcpServers,
    rootPath: plugin.source.type === "local" ? plugin.source.path : "",
  });
}

export function marketplaceSummary(market: PluginRow["market"], featured: string[] = []) {
  return {
    id: market.name,
    name: market.name,
    pluginCount: market.plugins.length,
    source: market.path
      ? { type: "local", path: market.path }
      : { type: "remote", name: market.name },
    featured: featured.filter((id) => market.plugins.some((plugin) => plugin.id === id)),
  };
}
