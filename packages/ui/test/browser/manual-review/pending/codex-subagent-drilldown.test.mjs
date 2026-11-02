// Pending browser acceptance only: real timeline + existing opener, not native Codex/drawer E2E.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { chromium } from "playwright-core";
import { TID_V4_ROW, TID_V4_SUBAGENT_OPEN_SIDE_PANE, testId } from "@codez/shared/test-ids";

const root = fileURLToPath(new URL("../../../../../../", import.meta.url));
const entry =
  "/packages/ui/test/browser/manual-review/pending/codex-subagent-drilldown.fixture.tsx";
const checks = [];
let server, browser, origin, artifacts;

before(async () => {
  const evidenceRoot = join(root, "packages/desktop/.e2e-artifacts");
  await mkdir(evidenceRoot, { recursive: true });
  artifacts = process.env.CODEZ_SUBAGENT_DRILLDOWN_ARTIFACT_DIR
    ? resolve(process.env.CODEZ_SUBAGENT_DRILLDOWN_ARTIFACT_DIR)
    : await mkdtemp(join(evidenceRoot, "codex-subagent-drilldown-"));
  await mkdir(artifacts, { recursive: true });
  server = await createServer({
    root,
    configFile: false,
    cacheDir: join(artifacts, "vite-cache"),
    plugins: [
      react(),
      tailwindcss(),
      {
        name: "codex-subagent-drilldown-fixture",
        configureServer(vite) {
          vite.middlewares.use(async (req, res, next) => {
            if (!req.url?.startsWith("/fixture?")) return next();
            res.setHeader("Content-Type", "text/html");
            res.end(
              await vite.transformIndexHtml(
                req.url,
                `<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1" /></head><body><div id="root"></div><script type="module" src="${entry}"></script></body></html>`,
              ),
            );
          });
        },
      },
    ],
    resolve: { alias: { "@": `${root}packages/ui/src` } },
    optimizeDeps: { entries: [entry.slice(1)] },
    server: { host: "127.0.0.1", port: 0 },
  });
  await server.listen();
  origin = server.resolvedUrls.local[0];
  browser = await chromium.launch({
    executablePath: process.env.CHROME_EXECUTABLE_PATH ?? "/usr/bin/google-chrome",
    headless: true,
    args: ["--no-sandbox"],
  });
});

after(async () => {
  await browser?.close();
  await server?.close();
  if (artifacts) {
    await writeFile(join(artifacts, "results.json"), JSON.stringify(checks, null, 2));
    console.log(`CSNAV33 artifacts: ${artifacts}`);
  }
});

const requests = async (page) =>
  JSON.parse(await page.getByTestId("fixture-requests").textContent());
const opener = (page, child) => page.getByTestId(testId(TID_V4_SUBAGENT_OPEN_SIDE_PANE, child));
const row = (page, id) => page.getByTestId(testId(TID_V4_ROW, String(id)));
const expectedRequest = (childSessionId, title) => ({
  rootSessionId: "fixture-root",
  parentSessionId: "fixture-parent",
  childSessionId,
  subagentType: "subagent",
  title,
});

async function assertRequests(page, expected) {
  await page.waitForFunction(
    (count) =>
      JSON.parse(document.querySelector('[data-testid="fixture-requests"]').textContent).length ===
      count,
    expected.length,
  );
  assert.deepEqual(await requests(page), expected);
}

async function chooseScenario(page, scenario) {
  await page.getByTestId("fixture-scenario").selectOption(scenario);
  await page.waitForFunction(
    (value) =>
      document.querySelector('[data-testid="fixture-timeline"]').dataset.scenario === value,
    scenario,
  );
  await row(page, scenario === "paired" ? 10 : 11).waitFor();
  await assertRequests(page, []);
}

for (const width of [390, 1200])
  for (const theme of ["light", "dark"])
    for (const locale of ["zh-CN", "en-US"]) {
      test(`CSNAV33 ${width} ${theme} ${locale}`, async () => {
        const page = await browser.newPage({ viewport: { width, height: 900 } });
        page.setDefaultTimeout(10_000);
        const errors = [];
        const check = { width, theme, locale, status: "running", scenarios: [] };
        checks.push(check);
        page.on("pageerror", (error) => errors.push(error.message));
        await page.route("**/*", (route) => {
          const url = new URL(route.request().url());
          return url.hostname === "127.0.0.1" || url.protocol === "data:"
            ? route.continue()
            : route.abort();
        });
        const title = "E2E_CSNAV33 inspect activity-only history";
        try {
          await page.goto(
            `${origin}fixture?theme=${theme}&locale=${locale}&mobile=${width === 390}`,
            { waitUntil: "commit", timeout: 30_000 },
          );
          await row(page, 11).waitFor({ timeout: 30_000 });
          const action = opener(page, "fixture-child");
          await action.waitFor();
          assert.equal(await action.count(), 1);
          assert.equal(await action.evaluate((element) => element.tagName), "BUTTON");
          assert.ok(
            (await action.getAttribute("aria-label"))?.includes(
              locale === "en-US" ? "Open in side pane" : "在右侧打开",
            ),
          );
          await action.click();
          await assertRequests(page, [expectedRequest("fixture-child", title)]);
          check.scenarios.push("completed-click");
          await page.screenshot({ path: join(artifacts, `${width}-${theme}-${locale}.png`) });

          await chooseScenario(page, "running");
          await opener(page, "fixture-child").click();
          await assertRequests(page, [expectedRequest("fixture-child", title)]);
          await page.getByTestId("fixture-update").click();
          await row(page, 11)
            .getByText(/success/)
            .waitFor();
          await assertRequests(page, [expectedRequest("fixture-child", title)]);
          await opener(page, "fixture-child").focus();
          await page.keyboard.press("Enter");
          await assertRequests(page, Array(2).fill(expectedRequest("fixture-child", title)));
          await page.keyboard.press("Space");
          await assertRequests(page, Array(3).fill(expectedRequest("fixture-child", title)));
          assert.equal(await opener(page, "fixture-child").count(), 1);
          assert.equal(await row(page, 11).locator("[aria-expanded]").count(), 0);
          check.scenarios.push("running-completed-keyboard");

          await chooseScenario(page, "multiple");
          const multiple = [
            ["fixture-child", title],
            ["fixture-second", "E2E_CSNAV33 second child"],
            ["fixture-third", "E2E_CSNAV33 third child"],
          ];
          const opened = [];
          for (const [child, summary] of multiple) {
            assert.equal(await opener(page, child).count(), 1);
            await opener(page, child).click();
            opened.push(expectedRequest(child, summary));
            await assertRequests(page, opened);
          }
          check.scenarios.push("multiple-success-failed-cancelled");

          await chooseScenario(page, "paired");
          assert.equal(await opener(page, "fixture-paired").count(), 1);
          assert.equal(await row(page, 11).count(), 0);
          await opener(page, "fixture-paired").click();
          await assertRequests(page, [
            expectedRequest("fixture-paired", "E2E_CSNAV33 paired spawn title"),
          ]);
          assert.equal(
            await page
              .getByText("E2E_CSNAV33 prompt must remain collapsed", { exact: true })
              .count(),
            0,
          );
          check.scenarios.push("paired-single-entry");

          for (const scenario of [
            "missing-child",
            "missing-parent",
            "missing-opener",
            "late-child",
          ]) {
            await chooseScenario(page, scenario);
            assert.equal(
              await row(page, 11).locator("button, [role=button], [tabindex]").count(),
              0,
            );
            assert.equal(await opener(page, "fixture-child").count(), 0);
            await assertRequests(page, []);
            check.scenarios.push(scenario);
          }
          await page.getByTestId("fixture-update").click();
          await opener(page, "fixture-child").waitFor();
          await assertRequests(page, []);
          await opener(page, "fixture-child").click();
          await assertRequests(page, [expectedRequest("fixture-child", title)]);
          check.scenarios.push("late-child-no-auto-open");

          await chooseScenario(page, "empty-title");
          await opener(page, "fixture-child").click();
          await assertRequests(page, [expectedRequest("fixture-child", "subagent")]);
          check.scenarios.push("type-title-fallback");

          await chooseScenario(page, "long-title");
          const longTitle = `E2E_CSNAV33_${"long-summary-without-whitespace-".repeat(7)}`.slice(
            0,
            200,
          );
          await opener(page, "fixture-child").click();
          await assertRequests(page, [expectedRequest("fixture-child", longTitle)]);
          assert.equal(
            await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1),
            false,
          );
          await page.screenshot({
            path: join(artifacts, `${width}-${theme}-${locale}-long-title.png`),
          });
          check.scenarios.push("long-title-no-overflow");
          assert.deepEqual(errors, []);
          check.status = "passed";
        } catch (error) {
          check.status = "failed";
          check.error = error.message;
          await page.screenshot({
            path: join(artifacts, `${width}-${theme}-${locale}-failed.png`),
            fullPage: true,
          });
          throw error;
        } finally {
          check.pageErrors = errors;
          await page.close();
        }
      });
    }
