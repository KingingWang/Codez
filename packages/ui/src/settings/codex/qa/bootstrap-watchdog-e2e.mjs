// Built renderer fault injection: missing entry must not strand a permanent splash.
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright-core";

const port = Number(process.env.CODEX_UI_QA_RENDERER_PORT ?? 5175);
assert.ok(Number.isInteger(port) && port > 1023 && port <= 65535, "Invalid QA renderer port");
const url = `http://127.0.0.1:${port}/`;
const evidence = await mkdtemp(join(tmpdir(), "codex-ui-bootstrap-watchdog-"));
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
  const page = await browser.newPage({ colorScheme: "dark" });
  let blocked = 0;
  let navigations = 0;
  await page.route("**/assets/index-*.js", (route) => {
    blocked++;
    return route.abort();
  });
  page.on("framenavigated", (frame) => {
    if (frame === page.mainFrame()) navigations++;
  });
  await page.goto(url, { waitUntil: "domcontentloaded" });
  const hasInlineWatchdog = await page.evaluate(() =>
    [...document.querySelectorAll("script:not([src])")].some(
      (script) => !script.type && script.textContent?.includes("checkBootstrapFailure"),
    ),
  );
  assert.equal(hasInlineWatchdog, true, "Built HTML must preserve a classic inline watchdog");
  await page.getByRole("alert").waitFor({ timeout: 25_000 });
  const failureBackground = await page
    .getByRole("alert")
    .evaluate((element) => getComputedStyle(element).backgroundColor);
  assert.notEqual(failureBackground, "rgba(0, 0, 0, 0)", "Recovery must be legible on dark UI");
  assert.equal(await page.getByRole("button", { name: "Reload" }).count(), 1);
  assert.ok(blocked >= 2, "The missing entry must be retried only once before showing recovery");
  assert.ok(navigations >= 2, "The first failed load must trigger a bounded automatic reload");
  await page.screenshot({ path: join(evidence, "failed-entry-recovery.png") });
  const checks = [
    "Built inline watchdog retries once and surfaces Reload when the entry is missing",
  ];
  await writeFile(join(evidence, "results.json"), JSON.stringify({ checks, blocked, navigations }));
  console.log(JSON.stringify({ status: "passed", checks, blocked, navigations, evidence }));
} finally {
  await browser.close();
}
