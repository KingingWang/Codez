import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  buildOfficialCodexMarketplace,
  OfficialPluginMarketplace,
  type OfficialCatalogFetcher,
  verifyOfficialPluginManifest,
} from "../src/official-plugin-marketplace.js";

const source = {
  name: "zcode-plugins-official",
  plugins: [
    {
      name: "github",
      version: "0.1.2",
      source: {
        source: "url" as const,
        type: "zip" as const,
        url: "https://cdn-zcode.z.ai/zcode/official-plugin/plugins/github/0.1.2/plugin.zip",
        sha256: "a".repeat(64),
        path: "github",
      },
      displayName: "GitHub",
      category: "developer-tools",
    },
    {
      name: "finance-search",
      version: "0.1.0",
      source: {
        source: "url" as const,
        type: "zip" as const,
        url: "https://cdn-zcode.z.ai/zcode/official-plugin/plugins/finance-search/0.1.0/plugin.zip",
        sha256: "b".repeat(64),
        path: "finance-search",
      },
    },
  ],
};

test("official online catalog maps only trusted versions to a pinned native marketplace", () => {
  const result = buildOfficialCodexMarketplace(source, "c".repeat(40));
  assert.equal(result.name, "codez-plugins-official");
  assert.equal(result.plugins.length, 2);
  assert.deepEqual(result.plugins[0]?.source, {
    source: "git-subdir",
    url: "https://github.com/zai-org/zcode-plugins.git",
    path: "./plugins/github",
    sha: "c".repeat(40),
  });
  assert.equal(result.plugins[0]?.policy.installation, "AVAILABLE");
  assert.equal(result.plugins[1]?.policy.installation, "NOT_AVAILABLE");
  assert.equal(result.plugins[0]?.displayName, "GitHub");
});

test("official catalog rejects source redirects, mismatched IDs and malformed names", () => {
  assert.throws(
    () => buildOfficialCodexMarketplace({ ...source, name: "personal" }, "c".repeat(40)),
    /identity/i,
  );
  assert.throws(
    () =>
      buildOfficialCodexMarketplace(
        {
          ...source,
          plugins: [
            {
              ...source.plugins[0]!,
              source: { ...source.plugins[0]!.source, url: "https://attacker.invalid/plugin.zip" },
            },
          ],
        },
        "c".repeat(40),
      ),
    /source/i,
  );
  assert.throws(() => buildOfficialCodexMarketplace(source, "main"), /commit/i);
});

test("published plugin version must match the pinned portable manifest", () => {
  assert.doesNotThrow(() =>
    verifyOfficialPluginManifest("github", "0.1.2", {
      name: "github",
      version: "0.1.2",
    }),
  );
  assert.throws(
    () => verifyOfficialPluginManifest("github", "0.1.2", { name: "github", version: "2.0" }),
    /version/i,
  );
  assert.throws(
    () => verifyOfficialPluginManifest("github", "0.1.2", { name: "other", version: "0.1.2" }),
    /name/i,
  );
});

const sha = "c".repeat(40);

function manifest(name: string, version: string) {
  return JSON.stringify({ name, version });
}

function treeFixture() {
  return {
    sha,
    truncated: false,
    tree: [
      { path: "plugins/github/.claude-plugin/plugin.json", type: "blob" },
      { path: "plugins/github/skills/setup/SKILL.md", type: "blob" },
      { path: "plugins/finance-search/.mcp.json", type: "blob" },
      { path: "plugins/finance-search/.zcode-plugin/plugin.json", type: "blob" },
    ],
  };
}

function catalogFetcher(failCatalog = false): OfficialCatalogFetcher & { requests: string[] } {
  const requests: string[] = [];
  return {
    requests,
    async fetchText(url: string) {
      requests.push(url);
      if (url.endsWith("/marketplace.json")) {
        if (failCatalog) throw new Error("offline");
        return JSON.stringify(source);
      }
      if (url.includes("/git/trees/")) return JSON.stringify(treeFixture());
      if (url.endsWith("/github/.claude-plugin/plugin.json")) return manifest("github", "0.1.2");
      throw new Error(`unexpected URL: ${url}`);
    },
    async resolveGitHead() {
      return sha;
    },
  };
}

test("official loader reads a durable shared snapshot without network IO", async () => {
  const fetcher = catalogFetcher();
  const root = join(tmpdir(), `official-marketplace-${crypto.randomUUID()}`);
  const marketplace = new OfficialPluginMarketplace(root, fetcher);

  assert.equal(await marketplace.load(), null);
  const first = await marketplace.refresh();
  assert.equal(first.path, join(root, ".agents", "plugins", "marketplace.json"));
  assert.equal(first.catalog.plugins[0]?.policy.installation, "AVAILABLE");
  assert.equal(first.catalog.plugins[1]?.policy.installation, "NOT_AVAILABLE");
  assert.ok(!Number.isNaN(Date.parse(first.catalog.updatedAt ?? "")));
  assert.ok(!Number.isNaN(Date.parse(first.catalog.updatedAt ?? "")));
  const requestCount = fetcher.requests.length;

  const cached = await marketplace.load();
  assert.equal(cached?.path, first.path);
  assert.deepEqual(cached?.catalog.plugins, first.catalog.plugins);
  assert.ok(cached?.catalog.updatedAt);
  assert.equal(fetcher.requests.length, requestCount);

  const generated = JSON.parse(await readFile(first.path, "utf8"));
  assert.equal(generated.plugins[0]?.source.path, "./plugins/github");
  assert.equal(generated.plugins[1]?.policy.installation, "NOT_AVAILABLE");
});

test("failed refresh preserves the last verified snapshot", async () => {
  const root = join(tmpdir(), `official-marketplace-${crypto.randomUUID()}`);
  const initial = new OfficialPluginMarketplace(root, catalogFetcher());
  const valid = await initial.refresh();

  const failing = new OfficialPluginMarketplace(root, catalogFetcher(true));
  await assert.rejects(() => failing.refresh(), /offline/);
  const retained = await failing.load();
  assert.equal(retained?.path, valid.path);
  assert.deepEqual(retained?.catalog.plugins, valid.catalog.plugins);
  assert.ok(retained?.catalog.updatedAt);
});
