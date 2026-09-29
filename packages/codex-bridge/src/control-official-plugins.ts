import { dirname, resolve } from "node:path";
import { z } from "zod";
import { CODEZ_OFFICIAL_PLUGIN_MARKETPLACE_ID } from "@codez/shared";
import type { CodezPluginDiagnostic } from "@codez/shared";
import type { BridgeControlContext } from "./contract.js";
import type { OfficialPluginMarketplace } from "./official-plugin-marketplace.js";
import { ControlError } from "./control-common.js";
import { readPluginCatalog } from "./control-plugin-data.js";

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
      .map((entry) => ({
        id: `${entry.name}@${OFFICIAL}`,
        name: entry.name,
        marketplace: OFFICIAL,
        installed: false,
        version: entry.version,
        description: entry.description,
        ...(entry.policy.installation === "NOT_AVAILABLE"
          ? {
              installationUnavailableReason:
                "This ZCode plugin requires components unsupported by Codex",
            }
          : {}),
        listing: {
          ...(entry.displayName ? { displayName: entry.displayName } : {}),
          ...(entry.category ? { category: entry.category } : {}),
        },
      })) ?? [];
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
