import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { OfficialCatalogFetcher } from "../src/official-plugin-package.js";
import { OfficialPluginMarketplace } from "../src/official-plugin-marketplace.js";
import { buildZip, zipSha256 } from "./helpers/zip-fixture.js";

const CATALOG_URL = "https://cdn-zcode.z.ai/zcode/official-plugin/marketplace.json";

interface FixturePlugin {
  name: string;
  version: string;
  files: Record<string, string>;
  displayName?: string;
}

function skillsPluginFiles(name: string, version: string): Record<string, string> {
  return {
    [`${name}/.claude-plugin/plugin.json`]: JSON.stringify({ name, version }),
    [`${name}/skills/demo/SKILL.md`]: "---\nname: demo\ndescription: demo\n---\n",
  };
}

function stdioPluginFiles(name: string, version: string): Record<string, string> {
  return {
    [`${name}/.claude-plugin/plugin.json`]: JSON.stringify({ name, version }),
    [`${name}/skills/demo/SKILL.md`]: "---\nname: demo\ndescription: demo\n---\n",
    [`${name}/.mcp.json`]: JSON.stringify({
      mcpServers: {
        [name]: {
          type: "stdio",
          command: "node",
          args: ["server.js"],
          env: { ZCODE_WORKSPACE_ROOT: "${ZCODE_PROJECT_DIR}" },
        },
      },
    }),
  };
}

function financePluginFiles(name: string, version: string): Record<string, string> {
  return {
    [`${name}/.zcode-plugin/plugin.json`]: JSON.stringify({
      name,
      version,
      displayName: "金融聚合搜索",
      requiresPaidPlan: true,
    }),
    [`${name}/.mcp.json`]: JSON.stringify({
      mcpServers: {
        "finance-search": {
          type: "http",
          url: "${ZCODE_BASE_URL}/api/v1/mcp/server/finance_search",
          auth: { type: "zcode_official", provider: "jwt_token" },
        },
      },
    }),
  };
}

function fakeFetcher(
  plugins: FixturePlugin[],
  overrides?: { zips?: Map<string, Buffer>; catalogName?: string },
): { fetcher: OfficialCatalogFetcher; zips: Map<string, Buffer> } {
  const zips =
    overrides?.zips ??
    new Map(
      plugins.map((plugin) => [
        plugin.name,
        buildZip(
          Object.entries(plugin.files).map(([name, content]) => ({
            name,
            content,
          })),
        ),
      ]),
    );
  const catalog = {
    name: overrides?.catalogName ?? "zcode-plugins-official",
    plugins: plugins.map((plugin) => ({
      name: plugin.name,
      version: plugin.version,
      source: {
        source: "url",
        type: "zip",
        url: `https://cdn-zcode.z.ai/zcode/official-plugin/plugins/${plugin.name}/${plugin.version}/plugin.zip`,
        sha256: zipSha256(zips.get(plugin.name)!),
        path: plugin.name,
      },
      ...(plugin.displayName ? { displayName: plugin.displayName } : {}),
    })),
  };
  return {
    zips,
    fetcher: {
      async fetchText(url: string) {
        if (url !== CATALOG_URL) throw new Error(`unexpected url ${url}`);
        return JSON.stringify(catalog);
      },
      async fetchBuffer(url: string) {
        const name = /plugins\/([^/]+)\//u.exec(url)?.[1];
        const zip = name ? zips.get(name) : undefined;
        if (!zip) throw new Error(`unexpected artifact ${url}`);
        return zip;
      },
    },
  };
}

async function baseDir(): Promise<string> {
  return await mkdtemp(join(tmpdir(), "official-marketplace-test-"));
}

async function marketplaceBase(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "official-marketplace-data-"));
  const base = join(root, "generated");
  const codexHome = join(root, "codex-home");
  await mkdir(base, { recursive: true });
  await mkdir(codexHome, { recursive: true });
  return root;
}

test("refresh materializes, transpiles and loads the official catalog", async () => {
  const dir = await baseDir();
  try {
    const plugins: FixturePlugin[] = [
      {
        name: "github",
        version: "0.1.2",
        files: stdioPluginFiles("github", "0.1.2"),
        displayName: "GitHub",
      },
      {
        name: "finance-search",
        version: "0.1.0",
        files: financePluginFiles("finance-search", "0.1.0"),
      },
    ];
    const { fetcher } = fakeFetcher(plugins);
    const market = new OfficialPluginMarketplace(dir, { fetcher });

    const snapshot = await market.refresh();
    assert.equal(snapshot.catalog.plugins.length, 2);
    const [github, finance] = snapshot.catalog.plugins;
    assert.equal(github?.policy.installation, "AVAILABLE");
    assert.equal(github?.displayName, "GitHub");
    assert.equal(finance?.requiresOfficialAuth, true);
    assert.equal(finance?.requiresPaidPlan, true);

    // Codex 只读 local source 市场文件；路径指向物化版本目录。
    const marketplace = JSON.parse(await readFile(market.path, "utf8"));
    assert.equal(marketplace.name, "codez-plugins-official");
    assert.deepEqual(marketplace.plugins[1].source, {
      source: "local",
      path: "./plugins/finance-search/0.1.0",
    });

    // 物化产物完成了官方鉴权改写与端点烘焙。
    const mcp = JSON.parse(
      await readFile(join(dir, "plugins/finance-search/0.1.0/.mcp.json"), "utf8"),
    );
    const server = mcp.mcpServers["finance-search"];
    assert.equal(server.url, "https://zcode.z.ai/api/v1/mcp/server/finance_search");
    assert.equal(server.bearer_token_env_var, "CODEZ_ZAI_OFFICIAL_MCP_TOKEN");
    const synthesized = JSON.parse(
      await readFile(join(dir, "plugins/finance-search/0.1.0/.claude-plugin/plugin.json"), "utf8"),
    );
    assert.equal(synthesized.name, "finance-search");

    // load() 回读同一份快照，不再有网络 IO。
    const loaded = await market.load();
    assert.equal(loaded?.catalog.plugins.length, 2);
    assert.equal(loaded?.catalog.plugins[1]?.requiresOfficialAuth, true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a plugin that cannot be adapted degrades to NOT_AVAILABLE without failing the refresh", async () => {
  const dir = await baseDir();
  try {
    const plugins: FixturePlugin[] = [
      {
        name: "github",
        version: "0.1.2",
        files: stdioPluginFiles("github", "0.1.2"),
      },
      {
        name: "broken",
        version: "1.0.0",
        files: { "broken/README.md": "no manifest at all" },
      },
    ];
    const { fetcher } = fakeFetcher(plugins);
    const market = new OfficialPluginMarketplace(dir, { fetcher });
    const snapshot = await market.refresh();
    const [github, broken] = snapshot.catalog.plugins;
    assert.equal(github?.policy.installation, "AVAILABLE");
    assert.equal(broken?.policy.installation, "NOT_AVAILABLE");
    assert.match(broken?.unavailableReason ?? "", /manifest/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("stdio MCP 使用稳定 native data root 且同插件跨版本与不同插件隔离", async () => {
  const root = await marketplaceBase();
  try {
    const v1: FixturePlugin[] = [
      {
        name: "github",
        version: "0.1.2",
        files: stdioPluginFiles("github", "0.1.2"),
      },
      {
        name: "mimosa",
        version: "1.0.0",
        files: stdioPluginFiles("mimosa", "1.0.0"),
      },
    ];
    const savedHome = process.env.CODEX_HOME;
    process.env.CODEX_HOME = join(root, "codex-home");
    try {
      const market = new OfficialPluginMarketplace(join(root, "generated"), {
        fetcher: fakeFetcher(v1).fetcher,
      });
      await market.refresh();
      const githubV1 = JSON.parse(
        await readFile(join(root, "generated/plugins/github/0.1.2/.mcp.json"), "utf8"),
      ).mcpServers.github;
      const mimosa = JSON.parse(
        await readFile(join(root, "generated/plugins/mimosa/1.0.0/.mcp.json"), "utf8"),
      ).mcpServers.mimosa;
      const nativeRoot = join(
        root,
        "codex-home",
        "plugins",
        "data",
        "github-codez-plugins-official",
      );
      assert.equal(githubV1.env.ZCODE_PLUGIN_DATA, nativeRoot);
      assert.equal(githubV1.env.CLAUDE_PLUGIN_DATA, nativeRoot);
      assert.equal(
        mimosa.env.ZCODE_PLUGIN_DATA,
        join(root, "codex-home", "plugins", "data", "mimosa-codez-plugins-official"),
      );
      assert.equal(
        mimosa.env.CLAUDE_PLUGIN_DATA,
        join(root, "codex-home", "plugins", "data", "mimosa-codez-plugins-official"),
      );

      const v2: FixturePlugin[] = [
        {
          name: "github",
          version: "0.1.3",
          files: stdioPluginFiles("github", "0.1.3"),
        },
      ];
      const market2 = new OfficialPluginMarketplace(join(root, "generated"), {
        fetcher: fakeFetcher(v2).fetcher,
      });
      await market2.refresh({ installedVersions: async () => [] });
      const githubV2 = JSON.parse(
        await readFile(join(root, "generated/plugins/github/0.1.3/.mcp.json"), "utf8"),
      ).mcpServers.github;
      assert.equal(githubV2.env.ZCODE_PLUGIN_DATA, githubV1.env.ZCODE_PLUGIN_DATA);
    } finally {
      if (savedHome === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = savedHome;
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("纯 Skill 插件不创建 native data root 且数据目录不可创建时仍可用", async () => {
  const root = await marketplaceBase();
  try {
    const savedHome = process.env.CODEX_HOME;
    process.env.CODEX_HOME = join(root, "codex-home");
    try {
      await mkdir(join(root, "codex-home", "plugins"), { recursive: true });
      await writeFile(join(root, "codex-home", "plugins", "data"), "not a directory", "utf8");
      const market = new OfficialPluginMarketplace(join(root, "generated"), {
        fetcher: fakeFetcher([
          {
            name: "github",
            version: "0.1.2",
            files: skillsPluginFiles("github", "0.1.2"),
          },
        ]).fetcher,
      });
      const snapshot = await market.refresh();
      assert.equal(snapshot.catalog.plugins[0]?.policy.installation, "AVAILABLE");
      assert.equal(snapshot.catalog.plugins[0]?.warnings.length, 0);
      const nativeRoot = join(
        root,
        "codex-home",
        "plugins",
        "data",
        "github-codez-plugins-official",
      );
      await assert.rejects(stat(nativeRoot), /ENOTDIR|ENOENT/);
    } finally {
      if (savedHome === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = savedHome;
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("refresh 不创建任何 native data root，父路径不可创建也不影响 availability", async () => {
  const root = await marketplaceBase();
  try {
    const plugins: FixturePlugin[] = [
      {
        name: "github",
        version: "0.1.2",
        files: stdioPluginFiles("github", "0.1.2"),
      },
      {
        name: "mimosa",
        version: "1.0.0",
        files: skillsPluginFiles("mimosa", "1.0.0"),
      },
    ];
    const savedHome = process.env.CODEX_HOME;
    process.env.CODEX_HOME = join(root, "blocked-home", "codex-home");
    try {
      await writeFile(join(root, "blocked-home"), "not a directory", "utf8");
      const market = new OfficialPluginMarketplace(join(root, "generated"), {
        fetcher: fakeFetcher(plugins).fetcher,
      });
      const snapshot = await market.refresh();
      assert.equal(
        snapshot.catalog.plugins.find((plugin) => plugin.name === "github")?.policy.installation,
        "AVAILABLE",
      );
      assert.equal(
        snapshot.catalog.plugins.find((plugin) => plugin.name === "mimosa")?.policy.installation,
        "AVAILABLE",
      );
      assert.equal(
        snapshot.catalog.plugins.every((plugin) => plugin.warnings.length === 0),
        true,
      );
      const codexHome = join(root, "blocked-home", "codex-home");
      await assert.rejects(stat(codexHome), /ENOENT|ENOTDIR/);
      await assert.rejects(stat(join(codexHome, "plugins")), /ENOENT|ENOTDIR/);
      await assert.rejects(stat(join(codexHome, "plugins", "data")), /ENOENT|ENOTDIR/);
    } finally {
      if (savedHome === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = savedHome;
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("integrity failures reject the whole refresh and preserve the last snapshot", async () => {
  const dir = await baseDir();
  try {
    const plugins: FixturePlugin[] = [
      {
        name: "github",
        version: "0.1.2",
        files: skillsPluginFiles("github", "0.1.2"),
      },
    ];
    const { fetcher } = fakeFetcher(plugins);
    const market = new OfficialPluginMarketplace(dir, { fetcher });
    const first = await market.refresh();
    assert.equal(first.catalog.plugins[0]?.version, "0.1.2");

    // 目录 sha256 与 zip 内容不符 → 完整性失败，旧快照保留。
    const tamperedCatalog = {
      name: "zcode-plugins-official",
      plugins: [
        {
          name: "github",
          version: "0.1.3",
          source: {
            source: "url",
            type: "zip",
            url: "https://cdn-zcode.z.ai/zcode/official-plugin/plugins/github/0.1.3/plugin.zip",
            sha256: "f".repeat(64),
            path: "github",
          },
        },
      ],
    };
    const tamperedFetcher: OfficialCatalogFetcher = {
      async fetchText() {
        return JSON.stringify(tamperedCatalog);
      },
      async fetchBuffer() {
        return buildZip([{ name: "github/.claude-plugin/plugin.json", content: "{}" }]);
      },
    };
    const tampered = new OfficialPluginMarketplace(dir, {
      fetcher: tamperedFetcher,
    });
    await assert.rejects(tampered.refresh(), /SHA-256/);
    const loaded = await tampered.load();
    assert.equal(loaded?.catalog.plugins[0]?.version, "0.1.2");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("zip-slip and symlink entries are rejected during extraction", async () => {
  const dir = await baseDir();
  try {
    const evil = buildZip([
      { name: "github/../../escape.txt", content: "x" },
      { name: "github/.claude-plugin/plugin.json", content: "{}" },
    ]);
    const catalog = {
      name: "zcode-plugins-official",
      plugins: [
        {
          name: "github",
          version: "0.1.2",
          source: {
            source: "url",
            type: "zip",
            url: "https://cdn-zcode.z.ai/zcode/official-plugin/plugins/github/0.1.2/plugin.zip",
            sha256: zipSha256(evil),
            path: "github",
          },
        },
      ],
    };
    const fetcher: OfficialCatalogFetcher = {
      async fetchText() {
        return JSON.stringify(catalog);
      },
      async fetchBuffer() {
        return evil;
      },
    };
    const market = new OfficialPluginMarketplace(dir, { fetcher });
    await assert.rejects(market.refresh(), /escapes|symbolic|top-level|invalid relative path/);
    assert.equal(await market.load(), null);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("untrusted catalog identity and duplicate names are rejected", async () => {
  const dir = await baseDir();
  try {
    const plugins: FixturePlugin[] = [
      {
        name: "github",
        version: "0.1.2",
        files: skillsPluginFiles("github", "0.1.2"),
      },
    ];
    const { fetcher } = fakeFetcher(plugins, {
      catalogName: "personal-market",
    });
    const market = new OfficialPluginMarketplace(dir, { fetcher });
    await assert.rejects(market.refresh(), /identity/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("refresh prunes old materialized versions but keeps installed ones", async () => {
  const dir = await baseDir();
  try {
    const v1: FixturePlugin[] = [
      {
        name: "github",
        version: "0.1.2",
        files: skillsPluginFiles("github", "0.1.2"),
      },
    ];
    const market = new OfficialPluginMarketplace(dir, {
      fetcher: fakeFetcher(v1).fetcher,
    });
    await market.refresh();
    await stat(join(dir, "plugins/github/0.1.2"));

    const v2: FixturePlugin[] = [
      {
        name: "github",
        version: "0.1.3",
        files: skillsPluginFiles("github", "0.1.3"),
      },
    ];
    const market2 = new OfficialPluginMarketplace(dir, {
      fetcher: fakeFetcher(v2).fetcher,
    });
    // 已安装 0.1.2 → 保留；未安装 → 回收。
    await market2.refresh({
      installedVersions: async () => [{ name: "github", version: "0.1.2" }],
    });
    await stat(join(dir, "plugins/github/0.1.2"));
    await stat(join(dir, "plugins/github/0.1.3"));

    const market3 = new OfficialPluginMarketplace(dir, {
      fetcher: fakeFetcher(v2).fetcher,
    });
    await market3.refresh({ installedVersions: async () => [] });
    await assert.rejects(stat(join(dir, "plugins/github/0.1.2")), /ENOENT/);
    await stat(join(dir, "plugins/github/0.1.3"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
