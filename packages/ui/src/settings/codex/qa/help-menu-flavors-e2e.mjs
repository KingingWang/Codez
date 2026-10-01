// Run from repo root with CHOKIDAR_USEPOLLING=1 when inotify instances are exhausted.
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium } from "playwright-core";
import { createServer } from "vite";

const evidence = await mkdtemp(join(tmpdir(), "codez-help-menu-flavors-"));
const variants = [
  { flavor: "codex", runtime: "codex", backend: "test", preview: "0", update: true },
  { flavor: "production", runtime: "legacy", backend: "production", preview: "0", update: true },
  { flavor: "preview", runtime: "legacy", backend: "production", preview: "1", update: false },
];
const envNames = ["CODEZ_DESKTOP_RUNTIME", "CODEZ_ENV", "CODEZ_PREVIEW_IDENTITY"];
const originalEnv = Object.fromEntries(envNames.map((name) => [name, process.env[name]]));
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
const checks = [];
try {
  for (const variant of variants) {
    process.env.CODEZ_DESKTOP_RUNTIME = variant.runtime;
    process.env.CODEZ_ENV = variant.backend;
    process.env.CODEZ_PREVIEW_IDENTITY = variant.preview;
    const server = await createServer({
      configFile: resolve("packages/desktop/vite.config.ts"),
      root: resolve("packages/ui/src/settings/codex/qa"),
      cacheDir: join(evidence, `cache-${variant.flavor}`),
      server: { host: "127.0.0.1", port: 5190, strictPort: true },
    });
    let page;
    try {
      await server.listen();
      page = await browser.newPage({ viewport: { width: 1100, height: 800 } });
      await page.route("**/*", (route) =>
        new URL(route.request().url()).hostname === "127.0.0.1" ? route.continue() : route.abort(),
      );
      await page.goto("http://127.0.0.1:5190/");
      assert.equal(await page.getByTestId("qa-product-flavor").innerText(), variant.flavor);
      await page.getByTestId("qa-web-help").getByRole("button", { name: "Help" }).click();
      assert.equal(await page.getByRole("menuitem", { name: "Check for Updates" }).count(), 0);
      await page.keyboard.press("Escape");
      await page.getByTestId("qa-desktop-help").getByRole("button", { name: "Help" }).click();
      const updateEntry = page.getByRole("menuitem", { name: "Check for Updates" });
      assert.equal(await updateEntry.count(), Number(variant.update));
      await page.screenshot({
        path: join(evidence, `${variant.flavor}-help.png`),
        animations: "disabled",
      });
      if (variant.update) {
        await updateEntry.click();
        await page.getByRole("button", { name: "Inspect desktop commands" }).click();
        assert.deepEqual(JSON.parse(await page.getByTestId("result").innerText()), [
          "checkForUpdates",
        ]);
      }
      checks.push(
        `${variant.flavor}: Web hidden; desktop ${variant.update ? "visible" : "hidden"}`,
      );
    } finally {
      await page?.close();
      await server.close();
    }
  }
  console.log(JSON.stringify({ status: "passed", checks, evidence }, null, 2));
} finally {
  await browser.close();
  for (const [name, value] of Object.entries(originalEnv)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
}
