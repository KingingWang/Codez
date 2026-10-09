// Targeted browser regression, using the same real hooks/Lexical fixture as interaction-e2e.
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createServer } from "vite";
import { chromium } from "playwright-core";
import { verifyMappedProviderComposer } from "./mapped-provider-e2e.mjs";

const evidence = await mkdtemp(join(tmpdir(), "codex-ui-mapped-provider-"));
const checks = [];
const errors = [];
const server = await createServer({
  configFile: resolve("packages/desktop/vite.config.ts"),
  root: resolve("packages/ui/src/settings/codex/qa"),
  cacheDir: join(evidence, "vite-cache"),
  server: { host: "127.0.0.1", port: 5188, strictPort: true },
});
await server.listen();
const browser = await chromium.launch({
  executablePath: "/opt/google/chrome/chrome",
  headless: true,
  args: ["--no-sandbox"],
  env: {
    PATH: process.env.PATH,
    HOME: evidence,
    XDG_CONFIG_HOME: evidence,
    XDG_CACHE_HOME: evidence,
  },
});
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  page.on("pageerror", (error) => errors.push(error.message));
  await page.route("**/*", (route) =>
    new URL(route.request().url()).hostname === "127.0.0.1" ? route.continue() : route.abort(),
  );
  try {
    await verifyMappedProviderComposer(page, evidence, checks);
    assert.deepEqual(errors, []);
  } catch (error) {
    await page.screenshot({ path: join(evidence, "failure.png"), fullPage: true });
    throw error;
  }
  console.log(JSON.stringify({ status: "passed", checks, evidence }, null, 2));
} finally {
  await writeFile(join(evidence, "results.json"), JSON.stringify({ checks, errors }, null, 2));
  await browser.close();
  await server.close();
}
