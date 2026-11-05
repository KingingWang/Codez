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

const SCROLL_CONTAINER_SELECTORS = {
  markdown: '[data-markdown-preview="true"]',
  pdf: '[data-preview-scroll-container="true"]',
  code: '[data-language="typescript"]',
  docx: '[data-office-preview-scroll-container="true"]',
  pptx: '[data-pptx-preview-viewport="true"]',
};

async function openFixture(kind) {
  const page = await browser.newPage({ viewport: { width: 900, height: 700 } });
  const errors = [];
  page.on("pageerror", (error) => errors.push(String(error)));
  await page.goto(`${origin}fixture?kind=${kind}`);
  await waitForPreviewReady(page, kind);
  return { page, errors };
}

async function waitForPreviewReady(page, kind) {
  const selector = SCROLL_CONTAINER_SELECTORS[kind];
  await page.waitForSelector(selector, { timeout: 60_000 });
  if (kind === "pdf") {
    await page.waitForSelector(`${selector} canvas`, { timeout: 60_000 });
  }
  if (kind === "code" || kind === "docx") {
    // 代码与 docx 正文都是异步渲染的，容器出现不等于可滚动；等到真的能滚再断言读位。
    await page.waitForFunction(
      (target) => {
        const node = document.querySelector(target);
        return Boolean(node && node.scrollHeight > node.clientHeight + 1);
      },
      selector,
      { timeout: 60_000 },
    );
  }
  if (kind === "pptx") {
    // 幻灯片解析完成后翻页按钮才可用；此时视口才是可断言的稳定状态。
    await page.waitForFunction(
      () => !document.querySelector('button[aria-label="Next page"]')?.disabled,
      undefined,
      { timeout: 60_000 },
    );
  }
}

async function waitForPptxPageNumber(page, pageNumber) {
  await page.waitForFunction(
    (target) =>
      document
        .querySelector('[data-pptx-preview-viewport="true"]')
        ?.getAttribute("data-pptx-page-number") === target,
    String(pageNumber),
    { timeout: 60_000 },
  );
}

async function goToNextPptxSlide(page) {
  await page.getByRole("button", { name: "Next page" }).click();
  await waitForPptxPageNumber(page, 2);
}

async function scrollPreviewTo(page, kind, scrollTop) {
  await page.locator(SCROLL_CONTAINER_SELECTORS[kind]).evaluate((element, top) => {
    element.scrollTop = top;
    element.dispatchEvent(new Event("scroll", { bubbles: true }));
  }, scrollTop);
}

async function readPreviewScrollTop(page, kind) {
  return page.locator(SCROLL_CONTAINER_SELECTORS[kind]).evaluate((element) => element.scrollTop);
}

async function waitForPreviewScrollTop(page, kind, scrollTop) {
  const selector = SCROLL_CONTAINER_SELECTORS[kind];
  await page.waitForFunction(
    (target) => document.querySelector(target.selector)?.scrollTop === target.scrollTop,
    { selector, scrollTop },
    { timeout: 15_000 },
  );
}

/** 折叠/展开重内容：boundary 保持挂载，只有预览正文卸载。 */
async function remountHeavyContent(page, kind) {
  await page.locator("[data-preview-toggle]").click();
  await page.locator(SCROLL_CONTAINER_SELECTORS[kind]).waitFor({ state: "detached" });
  await page.locator("[data-preview-toggle]").click();
  await waitForPreviewReady(page, kind);
}

/** 切换项目：整个 boundary 连同预览子树一起卸载，再重新挂载。 */
async function switchWorkspace(page, kind, expectedWorkspaceKey) {
  await page.locator("[data-preview-switch-workspace]").click();
  await page.waitForFunction(
    (workspaceKey) =>
      document.querySelector("[data-preview-workspace]")?.getAttribute("data-preview-workspace") ===
      workspaceKey,
    expectedWorkspaceKey,
  );
  await waitForPreviewReady(page, kind);
}

async function readPdfPageNumber(page) {
  return page
    .locator(SCROLL_CONTAINER_SELECTORS.pdf)
    .evaluate((element) => element.getAttribute("data-preview-page-number"));
}

async function goToNextPdfPage(page) {
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
}

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
test("markdown preview restores scrollTop across a workspace switch", async () => {
  const { page, errors } = await openFixture("markdown");
  try {
    await scrollPreviewTo(page, "markdown", 360);
    await switchWorkspace(page, "markdown", "ws-beta");
    assert.equal(await readPreviewScrollTop(page, "markdown"), 0);
    await switchWorkspace(page, "markdown", "ws-alpha");
    await waitForPreviewScrollTop(page, "markdown", 360);
    assert.equal(await readPreviewScrollTop(page, "markdown"), 360);
    await page.screenshot({
      path: join(artifacts, "markdown-restored-after-workspace-switch.png"),
    });
  } finally {
    await page.close();
  }
  assert.deepEqual(errors, []);
});

test("markdown preview keeps independent positions per workspace", async () => {
  const { page, errors } = await openFixture("markdown");
  try {
    await scrollPreviewTo(page, "markdown", 360);
    await switchWorkspace(page, "markdown", "ws-beta");
    await scrollPreviewTo(page, "markdown", 120);
    await switchWorkspace(page, "markdown", "ws-alpha");
    await waitForPreviewScrollTop(page, "markdown", 360);
    await switchWorkspace(page, "markdown", "ws-beta");
    await waitForPreviewScrollTop(page, "markdown", 120);
  } finally {
    await page.close();
  }
  assert.deepEqual(errors, []);
});

test("code preview restores scrollTop across a heavy content remount", async () => {
  const { page, errors } = await openFixture("code");
  try {
    await scrollPreviewTo(page, "code", 480);
    await remountHeavyContent(page, "code");
    await waitForPreviewScrollTop(page, "code", 480);
    await page.screenshot({ path: join(artifacts, "code-restored.png") });
  } finally {
    await page.close();
  }
  assert.deepEqual(errors, []);
});

test("code preview restores scrollTop across a workspace switch", async () => {
  const { page, errors } = await openFixture("code");
  try {
    await scrollPreviewTo(page, "code", 480);
    await switchWorkspace(page, "code", "ws-beta");
    await switchWorkspace(page, "code", "ws-alpha");
    await waitForPreviewScrollTop(page, "code", 480);
    await page.screenshot({ path: join(artifacts, "code-restored-after-workspace-switch.png") });
  } finally {
    await page.close();
  }
  assert.deepEqual(errors, []);
});

test("code preview resets when the source changes inside a mounted boundary", async () => {
  const { page, errors } = await openFixture("code");
  try {
    await scrollPreviewTo(page, "code", 480);
    await page.locator("[data-preview-switch-source]").click();
    await remountHeavyContent(page, "code");
    assert.equal(await readPreviewScrollTop(page, "code"), 0);
  } finally {
    await page.close();
  }
  assert.deepEqual(errors, []);
});

test("pdf preview restores page number across a workspace switch", async () => {
  const { page, errors } = await openFixture("pdf");
  try {
    await goToNextPdfPage(page);
    await scrollPreviewTo(page, "pdf", 30);
    await switchWorkspace(page, "pdf", "ws-beta");
    await switchWorkspace(page, "pdf", "ws-alpha");
    await waitForPreviewScrollTop(page, "pdf", 30);
    assert.equal(await readPdfPageNumber(page), "2");
    await page.screenshot({ path: join(artifacts, "pdf-restored-after-workspace-switch.png") });
  } finally {
    await page.close();
  }
  assert.deepEqual(errors, []);
});

test("docx preview restores scrollTop across a heavy content remount", async () => {
  const { page, errors } = await openFixture("docx");
  try {
    await scrollPreviewTo(page, "docx", 240);
    await remountHeavyContent(page, "docx");
    await waitForPreviewScrollTop(page, "docx", 240);
    assert.equal(await readPreviewScrollTop(page, "docx"), 240);
    await page.screenshot({ path: join(artifacts, "docx-restored.png") });
  } finally {
    await page.close();
  }
  assert.deepEqual(errors, []);
});

test("docx preview restores scrollTop across a workspace switch", async () => {
  const { page, errors } = await openFixture("docx");
  try {
    await scrollPreviewTo(page, "docx", 240);
    await switchWorkspace(page, "docx", "ws-beta");
    await switchWorkspace(page, "docx", "ws-alpha");
    await waitForPreviewScrollTop(page, "docx", 240);
    await page.screenshot({ path: join(artifacts, "docx-restored-after-workspace-switch.png") });
  } finally {
    await page.close();
  }
  assert.deepEqual(errors, []);
});

test("pptx preview restores slide number across a heavy content remount", async () => {
  const { page, errors } = await openFixture("pptx");
  try {
    await goToNextPptxSlide(page);
    await remountHeavyContent(page, "pptx");
    await waitForPptxPageNumber(page, 2);
    await page.screenshot({ path: join(artifacts, "pptx-restored.png") });
  } finally {
    await page.close();
  }
  assert.deepEqual(errors, []);
});

test("pptx preview restores slide number across a workspace switch", async () => {
  const { page, errors } = await openFixture("pptx");
  try {
    await goToNextPptxSlide(page);
    await switchWorkspace(page, "pptx", "ws-beta");
    await waitForPptxPageNumber(page, 1);
    await switchWorkspace(page, "pptx", "ws-alpha");
    await waitForPptxPageNumber(page, 2);
    await page.screenshot({
      path: join(artifacts, "pptx-restored-after-workspace-switch.png"),
    });
  } finally {
    await page.close();
  }
  assert.deepEqual(errors, []);
});

test("pptx preview resets to the first slide when the source changes", async () => {
  const { page, errors } = await openFixture("pptx");
  try {
    await goToNextPptxSlide(page);
    await page.locator("[data-preview-switch-source]").click();
    await remountHeavyContent(page, "pptx");
    await waitForPptxPageNumber(page, 1);
  } finally {
    await page.close();
  }
  assert.deepEqual(errors, []);
});
