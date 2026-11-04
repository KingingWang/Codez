import assert from "node:assert/strict";
import { before, after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { createServer } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { chromium } from "playwright-core";

const root = fileURLToPath(new URL("../../../../../../", import.meta.url));
const entry = "/packages/ui/test/browser/manual-review/pending/preview-scroll-restore.fixture.tsx";
const artifacts = join(root, "packages/desktop/.e2e-artifacts/preview-scroll-restore-browser");
let server;
let browser;
let origin;

before(async () => {
  await mkdir(artifacts, { recursive: true });
  server = await createServer({
    root,
    configFile: false,
    plugins: [
      {
        name: "preview-scroll-restore-fixture",
        enforce: "pre",
        configureServer(vite) {
          vite.middlewares.use(async (req, res, next) => {
            if (!req.url?.startsWith("/fixture?")) return next();
            res.setHeader("Content-Type", "text/html");
            res.end(
              await vite.transformIndexHtml(
                req.url,
                `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"/></head><body><div id="root"></div><script type="module" src="${entry}"></script></body></html>`,
              ),
            );
          });
        },
      },
      react(),
      tailwindcss(),
    ],
    resolve: { alias: { "@": `${root}packages/ui/src` } },
    optimizeDeps: { entries: [entry.slice(1)] },
    server: {
      host: "127.0.0.1",
      port: 0,
      hmr: false,
      watch: { ignored: ["**/packages/desktop/out/**", "**/.e2e-artifacts/**"] },
    },
  });
  await server.listen();
  origin = server.resolvedUrls.local[0];
  browser = await chromium.launch(
    process.env.CHROME_EXECUTABLE_PATH
      ? { executablePath: process.env.CHROME_EXECUTABLE_PATH }
      : { channel: "chrome" },
  );
});

after(async () => {
  await browser?.close();
  await server?.close();
});

test("markdown preview restores scrollTop across a heavy content remount", async () => {
  const page = await browser.newPage({ viewport: { width: 900, height: 700 } });
  const errors = [];
  page.on("pageerror", (error) => errors.push(String(error)));
  try {
    await page.goto(`${origin}fixture?kind=markdown`);
    await page.waitForSelector('[data-markdown-preview="true"]');
    await page.locator('[data-markdown-preview="true"]').evaluate((element) => {
      element.scrollTop = 360;
      element.dispatchEvent(new Event("scroll"));
    });
    await page.locator("[data-preview-toggle]").click();
    await page.locator('[data-markdown-preview="true"]').waitFor({ state: "detached" });
    await page.locator("[data-preview-toggle]").click();
    await page.waitForSelector('[data-markdown-preview="true"]');
    await page.waitForFunction(
      () => document.querySelector('[data-markdown-preview="true"]')?.scrollTop === 360,
    );
    assert.equal(
      await page.locator('[data-markdown-preview="true"]').evaluate((element) => element.scrollTop),
      360,
    );
    await page.screenshot({ path: join(artifacts, "markdown-restored.png") });
  } finally {
    await page.close();
  }
  assert.deepEqual(errors, []);
});

test("markdown preview resets when the source key changes", async () => {
  const page = await browser.newPage({ viewport: { width: 900, height: 700 } });
  const errors = [];
  page.on("pageerror", (error) => errors.push(String(error)));
  try {
    await page.goto(`${origin}fixture?kind=markdown`);
    await page.waitForSelector('[data-markdown-preview="true"]');
    await page.locator('[data-markdown-preview="true"]').evaluate((element) => {
      element.scrollTop = 280;
      element.dispatchEvent(new Event("scroll"));
    });
    await page.locator("[data-preview-switch-source]").click();
    await page.locator("[data-preview-toggle]").click();
    await page.locator('[data-markdown-preview="true"]').waitFor({ state: "detached" });
    await page.locator("[data-preview-toggle]").click();
    await page.waitForSelector('[data-markdown-preview="true"]');
    assert.equal(
      await page.locator('[data-markdown-preview="true"]').evaluate((element) => element.scrollTop),
      0,
    );
  } finally {
    await page.close();
  }
  assert.deepEqual(errors, []);
});

test("pdf preview restores scrollTop across a heavy content remount", async () => {
  const page = await browser.newPage({ viewport: { width: 900, height: 700 } });
  const errors = [];
  page.on("pageerror", (error) => errors.push(String(error)));
  try {
    await page.goto(`${origin}fixture?kind=pdf`);
    await page.waitForSelector('[data-preview-scroll-container="true"] canvas');
    await page.locator('[data-preview-scroll-container="true"]').evaluate((element) => {
      element.scrollTop = 30;
      element.dispatchEvent(new Event("scroll", { bubbles: true }));
    });
    await page.locator("[data-preview-toggle]").click();
    await page.locator('[data-preview-scroll-container="true"]').waitFor({ state: "detached" });
    await page.locator("[data-preview-toggle]").click();
    await page.waitForSelector('[data-preview-scroll-container="true"] canvas');
    assert.equal(
      await page
        .locator('[data-preview-scroll-container="true"]')
        .evaluate((element) => element.getAttribute("data-preview-page-number")),
      "1",
    );
    assert.equal(
      await page
        .locator('[data-preview-scroll-container="true"]')
        .evaluate((element) => element.scrollTop),
      30,
    );
    await page.screenshot({ path: join(artifacts, "pdf-restored.png") });
  } finally {
    await page.close();
  }
  assert.deepEqual(errors, []);
});

test("pdf preview restores page number across a heavy content remount", async () => {
  const page = await browser.newPage({ viewport: { width: 900, height: 700 } });
  const errors = [];
  page.on("pageerror", (error) => errors.push(String(error)));
  try {
    await page.goto(`${origin}fixture?kind=pdf`);
    await page.waitForSelector('[data-preview-scroll-container="true"] canvas');
    await page.waitForFunction(
      () => !document.querySelector('button[aria-label="Next page"]')?.disabled,
    );
    await page.getByRole("button", { name: "Next page" }).click();
    await page.waitForFunction(
      () =>
        document
          .querySelector('[data-preview-scroll-container="true"]')
          ?.getAttribute("data-preview-page-number") === "2",
    );
    await page.locator("[data-preview-toggle]").click();
    await page.locator('[data-preview-scroll-container="true"]').waitFor({ state: "detached" });
    await page.locator("[data-preview-toggle]").click();
    await page.waitForSelector('[data-preview-scroll-container="true"] canvas');
    assert.equal(
      await page
        .locator('[data-preview-scroll-container="true"]')
        .evaluate((element) => element.getAttribute("data-preview-page-number")),
      "2",
    );
  } finally {
    await page.close();
  }
  assert.deepEqual(errors, []);
});

test("pdf preview resets when the source key changes", async () => {
  const page = await browser.newPage({ viewport: { width: 900, height: 700 } });
  const errors = [];
  page.on("pageerror", (error) => errors.push(String(error)));
  try {
    await page.goto(`${origin}fixture?kind=pdf`);
    await page.waitForSelector('[data-preview-scroll-container="true"] canvas');
    await page.waitForFunction(
      () => !document.querySelector('button[aria-label="Next page"]')?.disabled,
    );
    await page.getByRole("button", { name: "Next page" }).click();
    await page.waitForFunction(
      () =>
        document
          .querySelector('[data-preview-scroll-container="true"]')
          ?.getAttribute("data-preview-page-number") === "2",
    );
    await page.locator("[data-preview-switch-source]").click();
    await page.locator("[data-preview-toggle]").click();
    await page.locator('[data-preview-scroll-container="true"]').waitFor({ state: "detached" });
    await page.locator("[data-preview-toggle]").click();
    await page.waitForSelector('[data-preview-scroll-container="true"] canvas');
    assert.equal(
      await page
        .locator('[data-preview-scroll-container="true"]')
        .evaluate((element) => element.getAttribute("data-preview-page-number")),
      "1",
    );
    assert.equal(
      await page
        .locator('[data-preview-scroll-container="true"]')
        .evaluate((element) => element.scrollTop),
      0,
    );
  } finally {
    await page.close();
  }
  assert.deepEqual(errors, []);
});
