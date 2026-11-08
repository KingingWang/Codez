/**
 * G003 native test wrapper: run the real bundled bridge with an isolated,
 * deterministic official-catalog fetcher. The wrapper only replaces network
 * fetches for the pinned fixture URLs; bridge/runtime behavior is unchanged.
 */
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

const catalogPath = process.env.CODEZ_OFFICIAL_NATIVE_TEST_CATALOG;
const artifactPath = process.env.CODEZ_OFFICIAL_NATIVE_TEST_ARTIFACT;
const bridgePath = process.env.CODEZ_OFFICIAL_NATIVE_TEST_BRIDGE;
if (!catalogPath || !artifactPath || !bridgePath) {
  throw new Error("official-plugin native bridge wrapper inputs are missing");
}

const originalFetch = globalThis.fetch.bind(globalThis);
globalThis.fetch = async (input, init) => {
  const url = String(input);
  if (url.endsWith("/marketplace.json")) {
    const catalog = await readFile(catalogPath, "utf8");
    return new Response(catalog, {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }
  if (url.endsWith("/plugin.zip")) {
    const artifact = await readFile(artifactPath);
    return new Response(artifact, {
      status: 200,
      headers: { "content-type": "application/zip" },
    });
  }
  return await originalFetch(input, init);
};

await import(pathToFileURL(bridgePath));
