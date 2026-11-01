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
    const beforeLayouts = await inspectRpcLog(page, result);
    for (const width of [390, 1280])
      for (const locale of ["en-US", "zh-CN"])
        for (const theme of ["light", "dark"]) {
          await page.setViewportSize({ width, height: 900 });
          await page
            .getByRole("button", {
              name:
                locale === "zh-CN" ? "Use Chinese locale fixture" : "Use English locale fixture",
            })
            .click();
          await settings
            .getByRole("heading", { name: locale === "zh-CN" ? "目录模型" : "Catalog models" })
            .waitFor();
          await page.evaluate((value) => {
            const root = document.documentElement;
            root.classList.toggle("dark", value === "dark");
            root.classList.toggle("theme-zai-dark", value === "dark");
            root.classList.toggle("theme-zai-light", value === "light");
            root.setAttribute("data-codez-browser-theme-surface", value);
          }, theme);
          const split = settings.locator("[data-model-provider-split-panel]");
          await page.waitForFunction(() => {
            const button = document.querySelector(
              '[data-testid="codex-provider-row-referenced-provider"] button',
            );
            return button instanceof HTMLButtonElement && !button.disabled;
          });
          assert.equal(
            await split.evaluate((element) => element.scrollWidth > element.clientWidth),
            false,
          );
          assert.ok(
            await settings
              .getByTestId("codex-provider-description")
              .evaluate((element) => element.clientWidth >= 80),
          );
          await settings.getByTestId("codex-provider-description").scrollIntoViewIfNeeded();
          await page.screenshot({
            path: join(evidence, `providers-${width}-${locale}-${theme}.png`),
          });
        }
    const afterLayouts = await inspectRpcLog(page, result);
    assert.equal(afterLayouts.catalogWrites, beforeLayouts.catalogWrites);
    checks.push(
      "Provider split layout works at 390/1280px in Chinese/English and light/dark without native writes",
    );
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
