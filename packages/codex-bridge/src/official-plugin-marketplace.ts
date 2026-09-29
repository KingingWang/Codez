import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { z } from "zod";

const OFFICIAL_SOURCE_NAME = "zcode-plugins-official";
const OFFICIAL_NATIVE_NAME = "codez-plugins-official";
const OFFICIAL_CATALOG_URL = "https://cdn-zcode.z.ai/zcode/official-plugin/marketplace.json";
const OFFICIAL_GIT_URL = "https://github.com/zai-org/zcode-plugins.git";
const OFFICIAL_GIT_TREE_URL = "https://api.github.com/repos/zai-org/zcode-plugins/git/trees";
const PLUGIN_NAME_PATTERN = /^[a-z0-9][a-z0-9._-]{0,127}$/u;
const VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u;
const SHA_PATTERN = /^[a-f0-9]{40}$/u;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const MCP_ONLY_PLUGINS = new Set(["finance-search", "hexin", "wind", "tianyancha"]);
const MANIFEST_CONCURRENCY = 6;
const UNSUPPORTED_MANIFEST_FIELDS = ["channels", "lspServers", "outputStyles", "settings"] as const;

export type OfficialPluginInstallation = "AVAILABLE" | "NOT_AVAILABLE";

export interface OfficialCatalogPlugin {
  name: string;
  version: string;
  policy: { installation: OfficialPluginInstallation };
  description?: string;
  displayName?: string;
  category?: string;
}

export interface OfficialCatalog {
  updatedAt?: string;
  plugins: OfficialCatalogPlugin[];
}

export interface OfficialPluginCatalogSource {
  name: string;
  plugins: Array<{
    name: string;
    version: string;
    source: {
      source: "url";
      type: "zip";
      url: string;
      sha256: string;
      path: string;
    };
    description?: string;
    displayName?: string;
    category?: string;
    policy?: { installation: OfficialPluginInstallation };
  }>;
}

export interface OfficialCodexMarketplacePlugin {
  name: string;
  version: string;
  description?: string;
  displayName?: string;
  category?: string;
  source: {
    source: "git-subdir";
    url: string;
    path: string;
    sha: string;
  };
  policy: { installation: OfficialPluginInstallation };
}

export interface OfficialCodexMarketplace {
  name: string;
  plugins: OfficialCodexMarketplacePlugin[];
}

export interface OfficialCatalogFetcher {
  fetchText(url: string): Promise<string>;
  resolveGitHead(url: string): Promise<string>;
}

const sourcePluginSchema = z.object({
  name: z.string().regex(PLUGIN_NAME_PATTERN, "Invalid official plugin name"),
  version: z.string().regex(VERSION_PATTERN, "Invalid official plugin version"),
  source: z.object({
    source: z.literal("url"),
    type: z.literal("zip"),
    url: z.string().url(),
    sha256: z.string().regex(SHA256_PATTERN, "Invalid official artifact SHA-256"),
    path: z.string(),
  }),
  description: z.string().trim().min(1).optional(),
  displayName: z.string().trim().min(1).optional(),
  category: z.string().trim().min(1).optional(),
  policy: z.object({ installation: z.enum(["AVAILABLE", "NOT_AVAILABLE"]) }).optional(),
});

const sourceCatalogSchema = z.object({
  name: z.string(),
  plugins: z.array(sourcePluginSchema).min(1),
});

const generatedSchema = z.object({
  name: z.literal(OFFICIAL_NATIVE_NAME),
  plugins: z.array(
    z.object({
      name: z.string().regex(PLUGIN_NAME_PATTERN),
      version: z.string().regex(VERSION_PATTERN),
      source: z.object({
        source: z.literal("git-subdir"),
        url: z.literal(OFFICIAL_GIT_URL),
        path: z.string().regex(/^\.\/plugins\/[a-z0-9][a-z0-9._-]{0,127}$/u),
        sha: z.string().regex(SHA_PATTERN),
      }),
      policy: z.object({ installation: z.enum(["AVAILABLE", "NOT_AVAILABLE"]) }),
      description: z.string().min(1).optional(),
      displayName: z.string().min(1).optional(),
      category: z.string().min(1).optional(),
    }),
  ),
});

const treeSchema = z.object({
  sha: z.string().regex(SHA_PATTERN),
  truncated: z.literal(false),
  tree: z.array(z.object({ path: z.string(), type: z.string() })),
});

const manifestSchema = z.object({
  name: z.string(),
  version: z.string(),
  mcpServers: z.unknown().optional(),
  hooks: z.unknown().optional(),
  channels: z.unknown().optional(),
  lspServers: z.unknown().optional(),
  outputStyles: z.unknown().optional(),
  settings: z.unknown().optional(),
});

export function verifyOfficialPluginManifest(
  name: string,
  version: string,
  manifest: { name?: unknown; version?: unknown },
): void {
  if (manifest.name !== name) throw new Error("Official plugin manifest name mismatch");
  if (manifest.version !== version) throw new Error("Official plugin manifest version mismatch");
}

function trustedArtifactUrl(name: string, version: string) {
  return `https://cdn-zcode.z.ai/zcode/official-plugin/plugins/${encodeURIComponent(name)}/${encodeURIComponent(version)}/plugin.zip`;
}

function metadata(plugin: z.infer<typeof sourcePluginSchema>) {
  return {
    ...(plugin.description ? { description: plugin.description } : {}),
    ...(plugin.displayName ? { displayName: plugin.displayName } : {}),
    ...(plugin.category ? { category: plugin.category } : {}),
  };
}

export function buildOfficialCodexMarketplace(
  catalog: OfficialPluginCatalogSource,
  sha: string,
): OfficialCodexMarketplace {
  if (catalog.name !== OFFICIAL_SOURCE_NAME)
    throw new Error("Untrusted official marketplace identity");
  if (!SHA_PATTERN.test(sha)) throw new Error("Official marketplace requires a resolved commit");

  const source = sourceCatalogSchema.parse(catalog);
  const names = new Set<string>();
  return {
    name: OFFICIAL_NATIVE_NAME,
    plugins: source.plugins.map((plugin) => {
      if (names.has(plugin.name)) throw new Error("Duplicate official plugin name");
      names.add(plugin.name);
      if (plugin.source.url !== trustedArtifactUrl(plugin.name, plugin.version))
        throw new Error(`Official plugin ${plugin.name} uses an untrusted source`);
      if (plugin.source.path !== plugin.name)
        throw new Error(`Official plugin ${plugin.name} has a mismatched source path`);
      const installation =
        plugin.policy?.installation ??
        (isStructurallyPortablePluginName(plugin.name) ? "AVAILABLE" : "NOT_AVAILABLE");
      return {
        name: plugin.name,
        version: plugin.version,
        ...metadata(plugin),
        source: {
          source: "git-subdir" as const,
          url: OFFICIAL_GIT_URL,
          path: `./plugins/${plugin.name}`,
          sha,
        },
        policy: {
          installation: MCP_ONLY_PLUGINS.has(plugin.name) ? "NOT_AVAILABLE" : installation,
        },
      };
    }),
  };
}

class DefaultOfficialCatalogFetcher implements OfficialCatalogFetcher {
  async fetchText(url: string): Promise<string> {
    const response = await fetch(url, { redirect: "error" });
    if (!response.ok) throw new Error(`Official catalog request failed: ${response.status}`);
    return await response.text();
  }

  async resolveGitHead(url: string): Promise<string> {
    if (url !== OFFICIAL_GIT_URL) throw new Error("Untrusted official Git source");
    const output = await promisify(execFile)("git", ["ls-remote", url, "HEAD"], {
      maxBuffer: 1024,
    });
    const match = /^([a-f0-9]{40})\tHEAD$/mu.exec(output.stdout.trim());
    if (!match) throw new Error("Could not resolve official Git HEAD");
    return match[1]!;
  }
}

function jsonText(value: unknown) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function treePathMatches(path: string, expected: string) {
  return path === expected || path.startsWith(`${expected}/`);
}

function isStructurallyPortablePluginName(name: string) {
  // The generator can still mark a supplied policy, but refresh only promotes a name after
  // pinned tree plus manifest validation. This legacy-safe list keeps pure build calls honest.
  return name === "github";
}

function structuralCompatibility(entries: readonly { path: string; type: string }[], name: string) {
  const root = `plugins/${name}`;
  const own = entries.filter((entry) => treePathMatches(entry.path, root));
  const manifest = own.some((entry) => entry.path === `${root}/.claude-plugin/plugin.json`);
  const skills = own.some((entry) => treePathMatches(entry.path, `${root}/skills`));
  const mcp = own.some((entry) => entry.path === `${root}/.mcp.json`);
  const hooks = own.some((entry) => entry.path === `${root}/hooks/hooks.json`);
  return { manifest, skills, mcp, hooks, portable: manifest && skills && !mcp && !hooks };
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
  readonly #marketplacePath: string;
  readonly #fetcher: OfficialCatalogFetcher;
  #refreshTail: Promise<unknown> = Promise.resolve();

  constructor(baseDir: string, fetcher?: OfficialCatalogFetcher) {
    if (!baseDir.trim()) throw new Error("Official marketplace base directory is required");
    this.#marketplacePath = join(resolve(baseDir), ".agents", "plugins", "marketplace.json");
    this.#fetcher = fetcher ?? new DefaultOfficialCatalogFetcher();
  }

  get path() {
    return this.#marketplacePath;
  }

  async load(): Promise<{ path: string; catalog: OfficialCatalog; updatedAt?: string } | null> {
    let raw: string;
    let modifiedAt: Date;
    try {
      [raw, { mtime: modifiedAt }] = await Promise.all([
        readFile(this.#marketplacePath, "utf8"),
        stat(this.#marketplacePath),
      ]);
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return null;
      throw error;
    }
    return {
      path: this.#marketplacePath,
      catalog: {
        updatedAt: modifiedAt.toISOString(),
        plugins: this.#catalogPlugins(generatedSchema.parse(JSON.parse(raw))),
      },
    };
  }

  async refresh(): Promise<{ path: string; catalog: OfficialCatalog; updatedAt?: string }> {
    const refresh = this.#refreshTail.catch(() => undefined).then(() => this.#refresh());
    this.#refreshTail = refresh;
    return await refresh;
  }

  #catalogPlugins(marketplace: OfficialCodexMarketplace): OfficialCatalogPlugin[] {
    const sha = marketplace.plugins[0]?.source.sha;
    const names = new Set<string>();
    return marketplace.plugins.map((plugin) => {
      if (names.has(plugin.name))
        throw new Error("Official marketplace cache contains duplicate plugins");
      names.add(plugin.name);
      // Revalidate cached native sources; a tampered path or divergent pin must never authorize Git IO.
      if (!sha || plugin.source.sha !== sha || plugin.source.path !== `./plugins/${plugin.name}`)
        throw new Error("Official marketplace cache contains an untrusted Git source");
      return {
        name: plugin.name,
        version: plugin.version,
        policy: plugin.policy,
        ...(plugin.description ? { description: plugin.description } : {}),
        ...(plugin.displayName ? { displayName: plugin.displayName } : {}),
        ...(plugin.category ? { category: plugin.category } : {}),
      };
    });
  }

  async #refresh(): Promise<{ path: string; catalog: OfficialCatalog; updatedAt?: string }> {
    const source = sourceCatalogSchema.parse(
      JSON.parse(await this.#fetcher.fetchText(OFFICIAL_CATALOG_URL)),
    );
    if (source.name !== OFFICIAL_SOURCE_NAME)
      throw new Error("Untrusted official marketplace identity");
    const sha = await this.#fetcher.resolveGitHead(OFFICIAL_GIT_URL);
    const treeUrl = `${OFFICIAL_GIT_TREE_URL}/${sha}?recursive=1`;
    const tree = treeSchema.parse(JSON.parse(await this.#fetcher.fetchText(treeUrl)));
    const compatibility = new Map(
      source.plugins.map((plugin) => [
        plugin.name,
        structuralCompatibility(tree.tree, plugin.name),
      ]),
    );
    const candidates = source.plugins.filter(
      (plugin) => !MCP_ONLY_PLUGINS.has(plugin.name) && compatibility.get(plugin.name)!.portable,
    );
    const manifests = await mapBounded(candidates, MANIFEST_CONCURRENCY, async (plugin) => {
      const manifestUrl = `https://raw.githubusercontent.com/zai-org/zcode-plugins/${sha}/plugins/${plugin.name}/.claude-plugin/plugin.json`;
      try {
        const manifest = manifestSchema.parse(
          JSON.parse(await this.#fetcher.fetchText(manifestUrl)),
        );
        verifyOfficialPluginManifest(plugin.name, plugin.version, manifest);
        if (
          manifest.mcpServers !== undefined ||
          manifest.hooks !== undefined ||
          UNSUPPORTED_MANIFEST_FIELDS.some((field) => manifest[field] !== undefined)
        )
          return false;
        return true;
      } catch {
        // 目录可信，但单个 manifest 不兼容时只降级该插件，不让整个目录刷新失败。
        return false;
      }
    });
    const available = new Set(
      candidates.filter((_, index) => manifests[index]).map((plugin) => plugin.name),
    );
    const marketplace = buildOfficialCodexMarketplace(
      {
        ...source,
        plugins: source.plugins.map((plugin) => ({
          ...plugin,
          policy: {
            installation: available.has(plugin.name) ? "AVAILABLE" : "NOT_AVAILABLE",
          },
        })),
      },
      sha,
    );
    await this.#writeAtomic(marketplace);
    return {
      path: this.#marketplacePath,
      catalog: { updatedAt: new Date().toISOString(), plugins: this.#catalogPlugins(marketplace) },
    };
  }

  async #writeAtomic(marketplace: OfficialCodexMarketplace): Promise<void> {
    await mkdir(dirname(this.#marketplacePath), { recursive: true });
    const temporary = join(
      dirname(this.#marketplacePath),
      `.marketplace-${process.pid}-${randomUUID()}.tmp`,
    );
    try {
      await writeFile(temporary, jsonText(marketplace), "utf8");
      // Windows rename-over-file can fail; atomic-replace semantics are recovered without
      // ever exposing a partial file.
      await rename(temporary, this.#marketplacePath);
    } catch (error) {
      await rm(temporary, { force: true }).catch(() => undefined);
      throw error;
    }
  }
}
