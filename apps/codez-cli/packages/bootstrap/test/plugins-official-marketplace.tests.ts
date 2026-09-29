import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { updateCodezPluginMarketplace } from "../src/plugins.js";

const officialSource = "https://cdn-zcode.z.ai/zcode/official-plugin/marketplace.json";

async function withStorage(runner: (root: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "codez-bootstrap-official-"));
  try {
    await runner(root);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
}

test("bootstrap refresh delegates trusted official normalization through the adapter", async () => {
  await withStorage(async (root) => {
    const pluginStorageRoot = join(root, "plugins");
    const result = await updateCodezPluginMarketplace({
      pluginStorageRoot,
      skipUserConfig: true,
      userConfigPath: join(root, "config.json"),
      workingDirectory: root,
      marketplace: "codez-plugins-official",
    });
    assert.equal(result.marketplaces[0]?.id, "codez-plugins-official");
    assert.equal(result.marketplaces[0]?.name, "codez-plugins-official");
  });
});
