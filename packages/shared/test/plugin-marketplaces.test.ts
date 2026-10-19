import assert from "node:assert/strict";
import test from "node:test";

import {
  CODEZ_OFFICIAL_PLUGIN_MARKETPLACE_ID,
  DEFAULT_PLUGIN_MARKETPLACES,
  ZCODE_OFFICIAL_PLUGIN_MARKETPLACE_ID,
  normalizeOfficialMarketplaceId,
} from "../src/plugin-marketplaces.js";

const officialSource = "https://cdn-zcode.z.ai/zcode/official-plugin/marketplace.json";

test("official marketplace uses the published ZCode CDN catalog", () => {
  const official = DEFAULT_PLUGIN_MARKETPLACES.find(
    (marketplace) => marketplace.id === CODEZ_OFFICIAL_PLUGIN_MARKETPLACE_ID,
  );

  assert.ok(official);
  assert.equal(official.source, officialSource);
});

test("only the configured official source maps the ZCode catalog identity", () => {
  assert.equal(
    normalizeOfficialMarketplaceId(ZCODE_OFFICIAL_PLUGIN_MARKETPLACE_ID, officialSource),
    CODEZ_OFFICIAL_PLUGIN_MARKETPLACE_ID,
  );

  assert.equal(
    normalizeOfficialMarketplaceId(
      ZCODE_OFFICIAL_PLUGIN_MARKETPLACE_ID,
      "https://cdn-zcode.z.ai/zcode/official-plugin/marketplace.json/malicious",
    ),
    ZCODE_OFFICIAL_PLUGIN_MARKETPLACE_ID,
  );

  assert.equal(
    normalizeOfficialMarketplaceId("personal-marketplace", officialSource),
    "personal-marketplace",
  );

  assert.equal(
    normalizeOfficialMarketplaceId(CODEZ_OFFICIAL_PLUGIN_MARKETPLACE_ID, officialSource),
    CODEZ_OFFICIAL_PLUGIN_MARKETPLACE_ID,
  );
});
