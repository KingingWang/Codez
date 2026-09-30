import { dirname, resolve } from "node:path";
import { z } from "zod";
import * as s from "@codez/shared";
import { CODEZ_OFFICIAL_PLUGIN_MARKETPLACE_ID } from "@codez/shared";
import type { CodezPluginDiagnostic } from "@codez/shared";
import type { BridgeControlContext } from "./contract.js";
import type { OfficialPluginMarketplace } from "./official-plugin-marketplace.js";
import { ControlError, checkWorkspace, input, unsupported } from "./control-common.js";
import { marketplaceSummary, readPluginCatalog } from "./control-plugin-data.js";

export const OFFICIAL = CODEZ_OFFICIAL_PLUGIN_MARKETPLACE_ID;
export type OfficialSnapshot = Awaited<ReturnType<OfficialPluginMarketplace["refresh"]>>;

export async function officialSnapshot(
  context: BridgeControlContext,
): Promise<{ snapshot: OfficialSnapshot | null; diagnostics: CodezPluginDiagnostic[] }> {
  if (!context.officialPlugins) return { snapshot: null, diagnostics: [] };
  try {
    const snapshot =
      (await context.officialPlugins.load()) ?? (await context.officialPlugins.refresh());
    return { snapshot, diagnostics: [] };
  } catch {
    // 网络或版本校验失败不得覆盖已验证快照，更不能把远端异常原文（含 URL）透传。
    const snapshot = await context.officialPlugins.load().catch(() => null);
    return {
      snapshot,
      diagnostics: [
        {
          code: "codex_official_catalog_unavailable",
          message: snapshot
            ? "Official ZCode catalog could not be verified; showing the last valid snapshot"
            : "Official ZCode catalog could not be verified",
          severity: "error",
        },
      ],
    };
  }
}

export function officialEntry(snapshot: OfficialSnapshot | null, name: string) {
  return snapshot?.catalog.plugins.find((entry) => entry.name === name);
}

export function projectOfficialCatalog(
  snapshot: OfficialSnapshot | null,
  nativeNames: readonly string[],
) {
  const marketplace = snapshot && {
    id: OFFICIAL,
    name: OFFICIAL,
    pluginCount: snapshot.catalog.plugins.length,
    source: { type: "local", path: snapshot.path },
    isOfficial: true,
    ...(snapshot.catalog.updatedAt ? { lastUpdated: snapshot.catalog.updatedAt } : {}),
  };
  const availablePlugins =
    snapshot?.catalog.plugins
      .filter((entry) => !nativeNames.includes(entry.name))
      .map((entry) => officialAvailableEntry(entry)) ?? [];
  return { marketplace, availablePlugins };
}

function failure(method: string, reason: string): never {
  throw new ControlError(-32000, `${method}: ${reason}`, { method, reason });
}

export async function registerOfficial(
  method: string,
  context: BridgeControlContext,
  snapshot: OfficialSnapshot,
): Promise<void> {
  const catalog = await readPluginCatalog(context);
  const existing = catalog.marketplaces.find((market) => market.name === OFFICIAL);
  if (existing) {
    if (!existing.path || resolve(existing.path) !== resolve(snapshot.path))
      failure(method, "Official marketplace name is already owned by another source");
    return;
  }
  const result = z
    .object({
      marketplaceName: z.string(),
      installedRoot: z.string(),
      alreadyAdded: z.boolean(),
    })
    .parse(
      await context.rpc.request("marketplace/add", {
        source: resolve(dirname(snapshot.path), "../.."),
      }),
    );
  if (result.marketplaceName !== OFFICIAL)
    failure(method, "Codex registered a different marketplace");
  const after = await readPluginCatalog(context);
  const registered = after.marketplaces.find((market) => market.name === OFFICIAL);
  if (!registered?.path || resolve(registered.path) !== resolve(snapshot.path))
    failure(method, "Codex did not confirm the official marketplace source");
}

/** 官方目录条目 → 商店 availablePlugins 投影（完整 listing + 转译警告与账号要求）。 */
export function officialAvailableEntry(entry: {
  name: string;
  version: string;
  description?: string;
  descriptionI18n?: Record<string, string>;
  displayName?: string;
  displayNameI18n?: Record<string, string>;
  category?: string;
  icon?: string;
  author?: string;
  authorUrl?: string;
  policy: { installation: "AVAILABLE" | "NOT_AVAILABLE" };
  warnings: string[];
  requiresOfficialAuth: boolean;
  requiresPaidPlan: boolean;
  unavailableReason?: string;
}) {
  return {
    id: `${entry.name}@${OFFICIAL}`,
    name: entry.name,
    marketplace: OFFICIAL,
    installed: false as const,
    version: entry.version,
    description: entry.description,
    ...(entry.policy.installation === "NOT_AVAILABLE"
      ? {
          installationUnavailableReason:
            entry.unavailableReason ?? "This ZCode plugin requires components unsupported by Codex",
        }
      : {}),
    ...(entry.warnings.length ? { officialWarnings: entry.warnings } : {}),
    ...(entry.requiresOfficialAuth ? { officialAuthRequired: true as const } : {}),
    listing: {
      ...(entry.displayName ? { displayName: entry.displayName } : {}),
      ...(entry.displayNameI18n ? { displayNameI18n: entry.displayNameI18n } : {}),
      ...(entry.descriptionI18n ? { descriptionI18n: entry.descriptionI18n } : {}),
      ...(entry.category ? { category: entry.category } : {}),
      ...(entry.icon ? { icon: entry.icon } : {}),
      ...(entry.author ? { author: entry.author } : {}),
      ...(entry.authorUrl ? { authorUrl: entry.authorUrl } : {}),
      ...(entry.requiresPaidPlan ? { requiresPaidPlan: true as const } : {}),
    },
  };
}

// 注册成功按桥内的 marketplace 实例缓存，整个桥生命周期只核验一次；
// 失败不缓存，下一次调用重试。并发调用共享同一个 in-flight Promise。
const ensureOfficialDone = new WeakSet<OfficialPluginMarketplace>();
const ensureOfficialInflight = new WeakMap<OfficialPluginMarketplace, Promise<boolean>>();

/**
 * 把内置官方市场注册进 Codex 配置，使原生 plugin/list（设置 → Codex → 插件与市场
 * 直接读原生状态，不经过商店投影）始终能看到官方插件。注册幂等、路径冲突不覆盖；
 * 任何失败都降级为 false，由下一次调用重试，绝不打断调用方的读请求。
 * cachedOnly 只用磁盘上已验证的快照（桥启动预热），不触发 CDN 刷新。
 */
export async function ensureOfficialRegistered(
  context: BridgeControlContext,
  options?: { cachedOnly?: boolean },
): Promise<boolean> {
  const market = context.officialPlugins;
  if (!market) return false;
  if (ensureOfficialDone.has(market)) return true;
  const existing = ensureOfficialInflight.get(market);
  if (existing) return existing;
  const task = (async () => {
    const snapshot = options?.cachedOnly
      ? await market.load()
      : (await officialSnapshot(context)).snapshot;
    if (!snapshot) return false;
    await registerOfficial("plugins/official/ensure", context, snapshot);
    ensureOfficialDone.add(market);
    return true;
  })().catch(() => false);
  ensureOfficialInflight.set(market, task);
  try {
    return await task;
  } finally {
    ensureOfficialInflight.delete(market);
  }
}

/** 插件市场增删刷新的控制面映射；官方市场走本地物化快照，其余透传 Codex。 */
export async function handleMarketplaceRequest(
  method: string,
  params: unknown,
  context: BridgeControlContext,
) {
  let selected: string | undefined;
  if (method === "plugins/marketplace/add") {
    const p = input(s.codezPluginsMarketplaceAddParamsSchema, params, method);
    checkWorkspace(p.workspace, context, method);
    if (p.dryRun) unsupported(method, "Codex marketplace/add does not support dry-run");
    const added = z
      .object({ marketplaceName: z.string(), installedRoot: z.string(), alreadyAdded: z.boolean() })
      .parse(await context.rpc.request("marketplace/add", { source: p.source }));
    selected = added.marketplaceName;
  } else if (method === "plugins/marketplace/remove") {
    const p = input(s.codezPluginsMarketplaceRemoveParamsSchema, params, method);
    checkWorkspace(p.workspace, context, method);
    if (p.marketplace === OFFICIAL)
      unsupported(method, "The built-in official marketplace cannot be removed");
    const removed = z
      .object({ marketplaceName: z.string(), installedRoot: z.string().nullable() })
      .parse(await context.rpc.request("marketplace/remove", { marketplaceName: p.marketplace }));
    if (removed.marketplaceName !== p.marketplace)
      failure(method, "Codex confirmed removal of a different marketplace");
  } else if (method === "plugins/marketplace/update") {
    const p = input(s.codezPluginsMarketplaceUpdateParamsSchema, params, method);
    checkWorkspace(p.workspace, context, method);
    if (context.officialPlugins && (!p.marketplace || p.marketplace === OFFICIAL)) {
      try {
        await context.officialPlugins.refresh();
      } catch {
        failure(method, "Official ZCode catalog refresh failed verification; old catalog retained");
      }
    }
    if (p.marketplace === OFFICIAL && context.officialPlugins) {
      const { snapshot } = await officialSnapshot(context);
      if (!snapshot) failure(method, "Official catalog is not available");
      return s.codezPluginsMarketplaceMutationResultSchema.parse({
        marketplace: {
          id: OFFICIAL,
          name: OFFICIAL,
          source: { type: "local", path: snapshot.path },
          pluginCount: snapshot.catalog.plugins.length,
          isOfficial: true,
          ...(snapshot.catalog.updatedAt ? { lastUpdated: snapshot.catalog.updatedAt } : {}),
        },
        diagnostics: [],
      });
    }
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
  return s.codezPluginsMarketplaceMutationResultSchema.parse({
    marketplace,
    marketplaces,
    diagnostics: catalog.diagnostics,
  });
}

/**
 * 官方插件安装/更新后，把该插件当前钩子哈希写入用户配置完成信任，
 * 语义与 Codex 对工作区上架插件的自动信任一致。信任失败只降级为警告，
 * 不影响已完成的安装结果；钩子本身保持未信任即不执行。
 */
export async function trustOfficialPluginHooks(
  context: BridgeControlContext,
  pluginId: string,
): Promise<CodezPluginDiagnostic[]> {
  const listSchema = z.object({
    data: z.array(
      z.object({
        hooks: z.array(
          z.object({
            key: z.string(),
            pluginId: z.string().nullable(),
            currentHash: z.string(),
            trustStatus: z.enum(["managed", "untrusted", "trusted", "modified"]),
          }),
        ),
      }),
    ),
  });
  let hooks: Array<{ key: string; currentHash: string; trustStatus: string }>;
  try {
    const listed = listSchema.parse(await context.rpc.request("hooks/list", { cwds: [] }));
    hooks = listed.data
      .flatMap((entry) => entry.hooks)
      .filter((hook) => hook.pluginId === pluginId)
      .filter((hook) => hook.trustStatus === "untrusted" || hook.trustStatus === "modified");
  } catch {
    return [
      {
        code: "codex_official_hook_trust_failed",
        message: "Plugin hooks could not be enumerated; hooks stay untrusted and will not run",
        severity: "warning",
      },
    ];
  }
  for (const hook of hooks) {
    try {
      const written = z.object({ status: z.enum(["ok", "okOverridden"]) }).parse(
        await context.rpc.request("config/value/write", {
          keyPath: `hooks.state.${JSON.stringify(hook.key)}.trusted_hash`,
          value: hook.currentHash,
          mergeStrategy: "replace",
        }),
      );
      if (written.status !== "ok")
        return [
          {
            code: "codex_official_hook_trust_failed",
            message:
              "Plugin hook trust was overridden by a higher-priority configuration; hooks will not run",
            severity: "warning",
          },
        ];
    } catch {
      return [
        {
          code: "codex_official_hook_trust_failed",
          message: "Plugin hooks could not be trusted; hooks stay untrusted and will not run",
          severity: "warning",
        },
      ];
    }
  }
  if (hooks.length === 0) return [];
  try {
    const verified = listSchema.parse(await context.rpc.request("hooks/list", { cwds: [] }));
    const remaining = verified.data
      .flatMap((entry) => entry.hooks)
      .filter((hook) => hook.pluginId === pluginId)
      .filter((hook) => hook.trustStatus === "untrusted" || hook.trustStatus === "modified");
    if (remaining.length > 0)
      return [
        {
          code: "codex_official_hook_trust_failed",
          message: "Codex did not confirm plugin hook trust; hooks will not run",
          severity: "warning",
        },
      ];
  } catch {
    return [
      {
        code: "codex_official_hook_trust_failed",
        message: "Plugin hook trust could not be verified; hooks may not run",
        severity: "warning",
      },
    ];
  }
  return [];
}
