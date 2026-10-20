import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  addMarketplace,
  ensureDefaultPluginMarketplaces,
  ensureMarketplaceManifestAvailable,
  updateMarketplace,
} from "../../src/plugins/marketplace.js";
import { CODEZ_OFFICIAL_PLUGIN_MARKETPLACE } from "@codez/contracts";
const officialSource = "https://cdn-zcode.z.ai/zcode/official-plugin/marketplace.json";

const sourceManifest = {
  name: "zcode-plugins-official",
  description: "Official ZCode catalog",
  plugins: [
    {
      name: "github",
      version: "0.1.2",
      source: {
        source: "url",
        type: "zip",
        url: "https://cdn-zcode.z.ai/zcode/official-plugin/plugins/github/0.1.2/plugin.zip",
        sha256: "a".repeat(64),
        path: "github",
      },
    },
  ],
};

async function withStorage(runner: (storageRoot: string) => Promise<void>) {
  const storageRoot = await mkdtemp(join(tmpdir(), "codez-official-id-"));
  try {
    await runner(storageRoot);
  } finally {
    await rm(storageRoot, { force: true, recursive: true });
  }
}

test("official marketplace maps its published ZCode ID to the canonical Codez ID", async () => {
  await withStorage(async (storageRoot) => {
    const official = ensureDefaultPluginMarketplaces(storageRoot).find(
      (record) => record.id === CODEZ_OFFICIAL_PLUGIN_MARKETPLACE,
    );
    assert.ok(official);
    assert.equal(official.source.url, officialSource);

    const loaded = await ensureMarketplaceManifestAvailable({
      marketplace: CODEZ_OFFICIAL_PLUGIN_MARKETPLACE,
      storageRoot,
    });
    assert.equal(loaded?.name, CODEZ_OFFICIAL_PLUGIN_MARKETPLACE);
    assert.equal(loaded?.id, CODEZ_OFFICIAL_PLUGIN_MARKETPLACE);

    const persisted = JSON.parse(
      await readFile(
        join(storageRoot, "marketplaces", CODEZ_OFFICIAL_PLUGIN_MARKETPLACE, "marketplace.json"),
        "utf8",
      ),
    ) as { name?: string; plugins?: unknown[] };
    assert.equal(persisted.name, CODEZ_OFFICIAL_PLUGIN_MARKETPLACE);
    assert.ok(persisted.plugins?.length);

    const refreshed = await updateMarketplace({
      marketplace: CODEZ_OFFICIAL_PLUGIN_MARKETPLACE,
      storageRoot,
    });
    assert.equal(refreshed[0]?.name, CODEZ_OFFICIAL_PLUGIN_MARKETPLACE);
  });
});

test("URL marketplace identity aliases are not trusted away from the official endpoint", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input);
    if (url.endsWith("/official-redirect")) {
      return new Response(undefined, {
        headers: { location: "https://attacker.example/marketplace.json" },
        status: 302,
      });
    }
    const manifest = url.endsWith("/codez-marketplace.json") || url.endsWith("attacker.example/marketplace.json")
      ? { ...sourceManifest, name: CODEZ_OFFICIAL_PLUGIN_MARKETPLACE }
      : sourceManifest;
    return new Response(JSON.stringify(manifest), {
      headers: { "content-type": "application/json" },
      status: 200,
    });
  }) as typeof fetch;
  try {
    await withStorage(async (storageRoot) => {
      const first = await addMarketplace({
        source: { source: "url", url: "https://example.com/marketplace.json" },
        storageRoot,
      });
      assert.equal(first.name, "zcode-plugins-official");

      await assert.rejects(
        () =>
          addMarketplace({
            source: { source: "url", url: "https://example.com/codez-marketplace.json" },
            storageRoot,
          }),
        /reserved/u,
      );

      await assert.rejects(
        () =>
          addMarketplace({
            source: { source: "url", url: "https://example.com/official-redirect" },
            storageRoot,
          }),
        /reserved/u,
      );
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});
