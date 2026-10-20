// Targeted browser regression for catalog model slug edits in the real settings panel.
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createServer } from "vite";
import { chromium } from "playwright-core";
import { inspectRpcLog, verifySingleCatalogModelAndRestart } from "./settings-regressions-e2e.mjs";

const evidence = await mkdtemp(join(tmpdir(), "codex-ui-provider-model-slug-"));
const checks = [];
const errors = [];
const chromeExecutable = process.env.CODEZ_UI_QA_CHROME ?? "/usr/lib/chromium/chromium";
const server = await createServer({
  configFile: resolve("packages/desktop/vite.config.ts"),
  root: resolve("packages/ui/src/settings/codex/qa"),
  cacheDir: join(evidence, "vite-cache"),
  server: { host: "127.0.0.1", port: 5188, strictPort: true },
});
await server.listen();
const browser = await chromium.launch({
  executablePath: chromeExecutable,
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
  const result = async () => JSON.parse(await page.getByTestId("result").innerText());
  try {
    await page.goto("http://127.0.0.1:5188/");
    await page.getByRole("button", { name: "Toggle provider catalog failure" }).click();
    await page.getByRole("button", { name: "Toggle settings", exact: true }).click();
    const settings = page.getByTestId("codex-settings");
    await settings.getByRole("button", { name: "Providers", exact: true }).click();
    await verifySingleCatalogModelAndRestart(page, settings, result, checks);
    assert.deepEqual(errors, []);
  } catch (error) {
    await page.screenshot({ path: join(evidence, "failure.png"), fullPage: true });
    throw error;
  }
  const inspection = await inspectRpcLog(page, result);
  console.log(
    JSON.stringify(
      {
        status: "passed",
        checks,
        catalogWrites: inspection.catalogWrites,
        catalogOriginalSlugRenames: inspection.catalogOriginalSlugRenames,
        evidence,
      },
      null,
      2,
    ),
  );
} finally {
  await writeFile(join(evidence, "results.json"), JSON.stringify({ checks, errors }, null, 2));
  await browser.close();
  await server.close();
}
