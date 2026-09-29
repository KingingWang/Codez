/**
 * ZCode 官方插件目录 → Codex 本地市场物化器。
 *
 * 刷新管线（spec: codex-zcode-plugin-compatibility「Compatibility pipeline」）：
 *   CDN catalog → 逐插件下载 zip（SHA-256 校验）→ 安全解压 → 转译 →
 *   暂存区组装 plugins/<name>/<version> + marketplace.json + 桥侧车元数据 → 原子换入。
 * Codex 只读生成的 marketplace.json（local source）；转译结果与诊断只进侧车文件。
 * 任何完整性失败（哈希不符/zip 损坏）使整个刷新失败并保留上一份快照；
 * 单个插件的转译降级只影响该插件（fail-visible）。
 */
import { resolveRuntimeCodezEndpointOrigin } from "@codez/shared/codezEndpoint";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { z } from "zod";
import type { OfficialCatalogFetcher } from "./official-plugin-package.js";
import {
  DefaultOfficialCatalogFetcher,
  extractOfficialPluginZip,
  verifySha256,
} from "./official-plugin-package.js";
import { transpileOfficialPlugin } from "./official-plugin-transpile.js";
import {
  OFFICIAL_CATALOG_URL,
  OFFICIAL_NATIVE_NAME,
  OFFICIAL_SOURCE_NAME,
  generatedMarketplaceSchema,
  sidecarMetaSchema,
  sourceCatalogSchema,
} from "./official-plugin-catalog.js";
import type {
  OfficialCatalog,
  OfficialCatalogPlugin,
  OfficialPluginCatalogSource,
  SidecarMeta,
} from "./official-plugin-catalog.js";

export type {
  OfficialCatalog,
  OfficialCatalogPlugin,
  OfficialPluginCatalogSource,
} from "./official-plugin-catalog.js";

/** 刷新时逐插件下载/转译的并发上限。 */
const PLUGIN_CONCURRENCY = 4;

/** 供刷新 GC 查询「仍被 Codex 安装引用」的官方插件版本。 */
export type OfficialInstalledVersionsProvider = () => Promise<
  Array<{ name: string; version: string }>
>;

function jsonText(value: unknown) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

async function mapBounded<T, R>(
  items: readonly T[],
  limit: number,
  operation: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = Array.from({ length: items.length });
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const index = next++;
      results[index] = await operation(items[index]!);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

export class OfficialPluginMarketplace {
  readonly #baseDir: string;
  readonly #fetcher: OfficialCatalogFetcher;
  readonly #zcodeBaseUrl: string;
  #refreshTail: Promise<unknown> = Promise.resolve();

  constructor(
    baseDir: string,
    options?: { fetcher?: OfficialCatalogFetcher; zcodeBaseUrl?: string },
  ) {
    if (!baseDir.trim()) throw new Error("Official marketplace base directory is required");
    this.#baseDir = resolve(baseDir);
    this.#fetcher = options?.fetcher ?? new DefaultOfficialCatalogFetcher();
    // 默认跟随桥进程环境（CODEZ_BASE_URL/CODEZ_ENDPOINT_ORIGIN），与桌面端点解析一致；测试可注入。
    this.#zcodeBaseUrl = options?.zcodeBaseUrl?.trim() || resolveRuntimeCodezEndpointOrigin();
  }

  get path() {
    return join(this.#baseDir, ".agents", "plugins", "marketplace.json");
  }

  get #metaPath() {
    return join(this.#baseDir, ".agents", "plugins", "marketplace.codez.json");
  }

  async load(): Promise<{ path: string; catalog: OfficialCatalog; updatedAt?: string } | null> {
    let marketplaceRaw: string;
    let metaRaw: string;
    let modifiedAt: Date;
    try {
      [marketplaceRaw, metaRaw, { mtime: modifiedAt }] = await Promise.all([
        readFile(this.path, "utf8"),
        readFile(this.#metaPath, "utf8"),
        stat(this.path),
      ]);
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return null;
      throw error;
    }
    const marketplace = generatedMarketplaceSchema.parse(JSON.parse(marketplaceRaw));
    const meta = sidecarMetaSchema.parse(JSON.parse(metaRaw));
    return {
      path: this.path,
      catalog: {
        updatedAt: modifiedAt.toISOString(),
        plugins: this.#catalogPlugins(marketplace, meta),
      },
    };
  }

  async refresh(options?: {
    installedVersions?: OfficialInstalledVersionsProvider;
  }): Promise<{ path: string; catalog: OfficialCatalog; updatedAt?: string }> {
    const refresh = this.#refreshTail
      .catch(() => undefined)
      .then(() => this.#refresh(options?.installedVersions));
    this.#refreshTail = refresh;
    return await refresh;
  }

  #catalogPlugins(
    marketplace: z.infer<typeof generatedMarketplaceSchema>,
    meta: SidecarMeta,
  ): OfficialCatalogPlugin[] {
    const names = new Set<string>();
    return marketplace.plugins.map((plugin) => {
      if (names.has(plugin.name))
        throw new Error("Official marketplace cache contains duplicate plugins");
      names.add(plugin.name);
      const [, , nameSegment] = plugin.source.path.split("/");
      if (nameSegment !== plugin.name)
        throw new Error("Official marketplace cache contains an untrusted local source");
      const entryMeta = meta.plugins[plugin.name];
      if (!entryMeta) throw new Error("Official marketplace sidecar metadata is incomplete");
      return {
        name: plugin.name,
        version: entryMeta.version,
        policy: plugin.policy,
        warnings: entryMeta.warnings,
        requiresOfficialAuth: entryMeta.requiresOfficialAuth,
        requiresPaidPlan: entryMeta.requiresPaidPlan,
        hasHooks: entryMeta.hasHooks,
        ...(entryMeta.unavailableReason ? { unavailableReason: entryMeta.unavailableReason } : {}),
        ...(plugin.description ? { description: plugin.description } : {}),
        ...(plugin.displayName ? { displayName: plugin.displayName } : {}),
        ...(plugin.category ? { category: plugin.category } : {}),
        ...(entryMeta.displayNameI18n ? { displayNameI18n: entryMeta.displayNameI18n } : {}),
        ...(entryMeta.descriptionI18n ? { descriptionI18n: entryMeta.descriptionI18n } : {}),
        ...(entryMeta.icon ? { icon: entryMeta.icon } : {}),
        ...(entryMeta.author ? { author: entryMeta.author } : {}),
        ...(entryMeta.authorUrl ? { authorUrl: entryMeta.authorUrl } : {}),
      };
    });
  }

  async #refresh(
    installedVersions?: OfficialInstalledVersionsProvider,
  ): Promise<{ path: string; catalog: OfficialCatalog; updatedAt?: string }> {
    const source = sourceCatalogSchema.parse(
      JSON.parse(await this.#fetcher.fetchText(OFFICIAL_CATALOG_URL)),
    );
    if (source.name !== OFFICIAL_SOURCE_NAME)
      throw new Error("Untrusted official marketplace identity");
    const names = new Set<string>();
    for (const plugin of source.plugins) {
      if (names.has(plugin.name)) throw new Error("Duplicate official plugin name");
      names.add(plugin.name);
      if (plugin.source.path !== plugin.name)
        throw new Error(`Official plugin ${plugin.name} has a mismatched source path`);
    }

    // 暂存区：全部插件成功物化后才换入，失败插件以 NOT_AVAILABLE 降级但仍进目录。
    // 暂存区与目标同文件系统，rename 才是原子且不会 EXDEV。
    const staging = join(this.#baseDir, `.refresh-${process.pid}-${randomUUID()}`);
    const stagedPlugins: Array<{ name: string; version: string; from: string }> = [];
    try {
      const outcomes = await mapBounded(source.plugins, PLUGIN_CONCURRENCY, async (plugin) => {
        const bakedRoot = join(this.#baseDir, "plugins", plugin.name, plugin.version);
        let outcome: Awaited<ReturnType<typeof transpileOfficialPlugin>>;
        const zip = await this.#fetcher.fetchBuffer(plugin.source.url);
        verifySha256(zip, plugin.source.sha256);
        const extracted = await extractOfficialPluginZip(
          zip,
          join(staging, "extract", plugin.name),
        );
        try {
          outcome = await transpileOfficialPlugin({
            pluginDir: extracted.pluginDir,
            bakedPluginRoot: bakedRoot,
            zcodeBaseUrl: this.#zcodeBaseUrl,
            expectedName: plugin.name,
            expectedVersion: plugin.version,
          });
          const target = join(staging, "plugins", plugin.name, plugin.version);
          await mkdir(dirname(target), { recursive: true });
          await rename(extracted.pluginDir, target);
          stagedPlugins.push({ name: plugin.name, version: plugin.version, from: target });
        } finally {
          await rm(extracted.stagingRoot, { recursive: true, force: true }).catch(() => undefined);
        }
        return { plugin, outcome };
      });

      const marketplace = {
        name: OFFICIAL_NATIVE_NAME,
        plugins: outcomes.map(({ plugin, outcome }) => ({
          name: plugin.name,
          source: {
            source: "local" as const,
            path: `./plugins/${plugin.name}/${plugin.version}`,
          },
          policy: { installation: outcome.installation },
          ...(plugin.description ? { description: plugin.description } : {}),
          ...(plugin.displayName ? { displayName: plugin.displayName } : {}),
          ...(plugin.category ? { category: plugin.category } : {}),
        })),
      };
      const meta: SidecarMeta = {
        catalogUpdatedAt: new Date().toISOString(),
        plugins: Object.fromEntries(
          outcomes.map(({ plugin, outcome }) => [
            plugin.name,
            {
              version: plugin.version,
              installation: outcome.installation,
              ...(outcome.unavailableReason
                ? { unavailableReason: outcome.unavailableReason }
                : {}),
              warnings: outcome.warnings,
              requiresOfficialAuth: outcome.requiresOfficialAuth,
              requiresPaidPlan: plugin.requiresPaidPlan ?? outcome.requiresPaidPlan,
              hasHooks: outcome.hasHooks,
              ...(plugin.displayName_i18n ? { displayNameI18n: plugin.displayName_i18n } : {}),
              ...(plugin.description_i18n ? { descriptionI18n: plugin.description_i18n } : {}),
              ...(plugin.icon ? { icon: plugin.icon } : {}),
              ...(plugin.author?.name ? { author: plugin.author.name } : {}),
              ...(plugin.author?.url ? { authorUrl: plugin.author.url } : {}),
            },
          ]),
        ),
      };

      // 先落盘 marketplace + 侧车（原子），再换入插件目录，最后回收旧版本目录。
      const marketplaceDir = dirname(this.path);
      await mkdir(marketplaceDir, { recursive: true });
      await this.#writeAtomic(this.path, marketplace);
      await this.#writeAtomic(this.#metaPath, meta);
      for (const staged of stagedPlugins) {
        const destination = join(this.#baseDir, "plugins", staged.name, staged.version);
        await rm(join(this.#baseDir, "plugins", staged.name, staged.version), {
          recursive: true,
          force: true,
        }).catch(() => undefined);
        await mkdir(dirname(destination), { recursive: true });
        await rename(staged.from, destination);
      }
      await this.#collectGarbage(
        outcomes.map(({ plugin }) => `${plugin.name}/${plugin.version}`),
        installedVersions,
      );
      return {
        path: this.path,
        catalog: {
          updatedAt: meta.catalogUpdatedAt,
          plugins: this.#catalogPlugins(generatedMarketplaceSchema.parse(marketplace), meta),
        },
      };
    } finally {
      await rm(staging, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  /** 回收不再被目录或已安装实例引用的旧版本物化目录。 */
  async #collectGarbage(
    currentKeys: readonly string[],
    installedVersions?: OfficialInstalledVersionsProvider,
  ): Promise<void> {
    const keep = new Set(currentKeys);
    if (installedVersions) {
      try {
        for (const installed of await installedVersions()) {
          keep.add(`${installed.name}/${installed.version}`);
        }
      } catch {
        // 查询不到已安装列表时宁可不回收，避免删掉仍在用的物化目录。
        return;
      }
    }
    const pluginsRoot = join(this.#baseDir, "plugins");
    let pluginDirs;
    try {
      pluginDirs = await readdir(pluginsRoot, { withFileTypes: true });
    } catch {
      return;
    }
    for (const pluginDir of pluginDirs) {
      if (!pluginDir.isDirectory()) continue;
      const versionsRoot = join(pluginsRoot, pluginDir.name);
      const versionDirs = await readdir(versionsRoot, { withFileTypes: true }).catch(() => []);
      let remaining = 0;
      for (const versionDir of versionDirs) {
        if (!versionDir.isDirectory()) continue;
        if (keep.has(`${pluginDir.name}/${versionDir.name}`)) {
          remaining += 1;
          continue;
        }
        await rm(join(versionsRoot, versionDir.name), { recursive: true, force: true }).catch(
          () => undefined,
        );
      }
      if (remaining === 0) {
        await rm(versionsRoot, { recursive: true, force: true }).catch(() => undefined);
      }
    }
  }

  async #writeAtomic(path: string, value: unknown): Promise<void> {
    const temporary = join(dirname(path), `.${process.pid}-${randomUUID()}.tmp`);
    try {
      await writeFile(temporary, jsonText(value), "utf8");
      // rename 在同文件系统内是原子的；先写临时文件再替换，避免暴露半截文件。
      await rename(temporary, path);
    } catch (error) {
      await rm(temporary, { force: true }).catch(() => undefined);
      throw error;
    }
  }
}
