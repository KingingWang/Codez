// Run from repo root: node packages/ui/src/settings/codex/qa/automation-model-read-e2e.mjs
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createServer } from "vite";
import { chromium } from "playwright-core";
const evidence = await mkdtemp(join(tmpdir(), "automation-model-read-e2e-"));
const server = await createServer({
  configFile: resolve("packages/desktop/vite.config.ts"),
  root: resolve("packages/ui/src/settings/codex/qa"),
  cacheDir: join(evidence, "vite-cache"),
  server: { host: "127.0.0.1", port: 5189, strictPort: true },
});
let browser;
let page;
const errors = [];
const consoleErrors = [];
const failedRequests = [];
const checks = [];
try {
  await server.listen();
  const isolatedEnv = {
    PATH: process.env.PATH,
    HOME: evidence,
    XDG_CONFIG_HOME: evidence,
    XDG_CACHE_HOME: evidence,
  };
  browser = await chromium.launch({
    executablePath: process.env.CHROME_PATH ?? "/opt/google/chrome/chrome",
    headless: true,
    args: ["--no-sandbox"],
    env: isolatedEnv,
  });
  page = await browser.newPage({ viewport: { width: 1280, height: 1000 } });
  page.setDefaultTimeout(10000);
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") {
      consoleErrors.push(message.text());
      if (consoleErrors.length > 10) consoleErrors.shift();
    }
  });
  page.on("requestfailed", (request) =>
    failedRequests.push({ url: request.url(), failure: request.failure() }),
  );
  await page.route("**/*", (route) =>
    new URL(route.request().url()).hostname === "127.0.0.1" ? route.continue() : route.abort(),
  );
  // 根因：页面表单已可交互时，Vite 的无关资源仍可能拖住 DOMContentLoaded/load；
  // 用目标控件就绪作为同步边界，仅冷启动预打包有独立上限，不放宽后续交互断言。
  await page.goto("http://127.0.0.1:5189/automation-model-read.html", {
    waitUntil: "commit",
  });
  await page
    .getByRole("button", { name: "Reject delayed read", exact: true })
    .waitFor({ timeout: 20_000 });
  await page.getByTestId("automation-form-prompt").fill("Isolated retained prompt");
  const picker = page.getByTestId("chat-model-select-trigger");
  await page.getByRole("button", { name: "Loading...", exact: true }).waitFor();
  assert.equal(await picker.locator(".animate-spin").count(), 1);
  assert.equal(await page.getByTestId("automation-form-submit").isDisabled(), true);
  await page.screenshot({
    path: join(evidence, "loading.png"),
    fullPage: true,
    animations: "disabled",
  });
  checks.push("Delayed read shows loading and blocks submission");
  await page.getByRole("button", { name: "Reject delayed read", exact: true }).click();
  await page.getByText("Model configuration failed to load.", { exact: true }).waitFor();
  await page.getByRole("button", { name: "Retry", exact: true }).waitFor();
  assert.equal(await page.getByTestId("automation-form-submit").isDisabled(), true);
  assert.equal(await page.getByText(/Fixture model read failed/).count(), 0);
  await page.getByRole("button", { name: "Inspect fixture", exact: true }).click();
  const failedReads = JSON.parse(await page.getByTestId("result").innerText()).readAttempts;
  await page.screenshot({
    path: join(evidence, "error.png"),
    fullPage: true,
    animations: "disabled",
  });
  checks.push("Rejected read shows localized reason without raw error and blocks submission");
  await page.setViewportSize({ width: 375, height: 900 });
  for (const theme of ["light", "dark"]) {
    await page.evaluate(
      (theme) => document.documentElement.classList.toggle("dark", theme === "dark"),
      theme,
    );
    const feedback = await page.getByRole("status").boundingBox();
    assert.ok(feedback && feedback.x >= 0 && feedback.x + feedback.width <= 375);
    const retry = await page.getByRole("button", { name: "Retry", exact: true }).boundingBox();
    assert.ok(retry && retry.x >= 0 && retry.x + retry.width <= 375);
    await page.screenshot({
      path: join(evidence, `error-narrow-${theme}.png`),
      fullPage: true,
      animations: "disabled",
    });
  }
  checks.push("Failure explanation and retry stay within a narrow light/dark viewport");
  await page.getByRole("button", { name: "Resolve next read", exact: true }).click();
  await page.getByRole("button", { name: "Retry", exact: true }).focus();
  await page.keyboard.press("Enter");
  await page.waitForFunction(() => {
    const submit = document.querySelector('[data-testid="automation-form-submit"]');
    return submit && !submit.disabled;
  });
  await page.getByText("Model configuration failed to load.", { exact: true }).waitFor({
    state: "hidden",
  });
  await page.getByLabel("Loading...", { exact: true }).waitFor({ state: "hidden" });
  assert.equal(
    await page.getByTestId("automation-form-prompt").inputValue(),
    "Isolated retained prompt",
  );
  await page.getByRole("button", { name: "Inspect fixture", exact: true }).click();
  const result = JSON.parse(await page.getByTestId("result").innerText());
  assert.equal(result.writes, 0);
  assert.ok(result.readAttempts > failedReads, "Retry must read the model view again");
  assert.equal(await picker.isEnabled(), true);
  assert.match(await picker.locator("span[title]").first().getAttribute("title"), /fixture-model/);
  assert.equal(await picker.locator(".animate-spin").count(), 0);
  checks.push("Keyboard retry enables form, preserves prompt, and performs no automation writes");
  await page.getByRole("button", { name: "Delay old workspace refresh", exact: true }).click();
  await page.getByRole("button", { name: "Inspect fixture", exact: true }).click();
  assert.ok(
    JSON.parse(await page.getByTestId("result").innerText()).readAttempts > result.readAttempts,
  );
  await page.getByTestId("automation-project-select").click();
  await page.getByRole("option", { name: "Second project", exact: true }).click();
  assert.equal(await page.getByTestId("automation-form-submit").isDisabled(), true);
  await page.getByRole("button", { name: "Release old workspace", exact: true }).click();
  assert.equal(await page.getByTestId("automation-form-submit").isDisabled(), true);
  assert.doesNotMatch(
    await picker.locator("span[title]").first().getAttribute("title"),
    /fixture-model/,
  );
  await page.getByRole("button", { name: "Release second workspace", exact: true }).click();
  await page.waitForFunction(
    () => !document.querySelector('[data-testid="automation-form-submit"]')?.disabled,
  );
  assert.match(await picker.locator("span[title]").first().getAttribute("title"), /second-model/);
  checks.push(
    "Project switching reads the new workspace, blocks submission, and ignores delayed old-target results",
  );
  await page.setViewportSize({ width: 1280, height: 1000 });
  for (const model of ["alternative-model", "second-model"]) {
    await picker.click();
    await page.locator('[data-model-provider-key="registry-provider:glm"]').click();
    await page.getByRole("menuitemradio", { name: model, exact: true }).click();
    await page.waitForFunction((model) => {
      const label = document.querySelector('[data-testid="chat-model-select-trigger"] span[title]');
      return (
        label?.getAttribute("title")?.includes(model) &&
        !document.querySelector('[data-testid="automation-form-submit"]')?.disabled
      );
    }, model);
  }
  checks.push(
    "Discovered model menu is selectable; returning to a sparse model clears the previous effort",
  );
  await page.getByTestId("automation-form-submit").click();
  await page.waitForFunction(() => {
    const result = document.querySelector('[data-testid="result"]')?.textContent;
    return result && JSON.parse(result).submitted;
  });
  const submitted = JSON.parse(await page.getByTestId("result").innerText());
  assert.equal(submitted.writes, 1);
  assert.deepEqual(submitted.submission.input.modelSelection, {
    providerId: "glm",
    modelId: "second-model",
  });
  assert.equal(submitted.submission.input.prompt, "Isolated retained prompt");
  assert.equal(submitted.submission.input.projectId, "second-project");
  assert.equal(submitted.submission.workspacePath, "/isolated/second-workspace");
  checks.push(
    "Real form reads the selected workspace and submits the sparse native default unchanged",
  );
  assert.deepEqual(errors, []);
  await page.setViewportSize({ width: 375, height: 900 });
  await page.screenshot({
    path: join(evidence, "ready-narrow-dark.png"),
    fullPage: true,
    animations: "disabled",
  });
  await page.evaluate(() => document.documentElement.classList.remove("dark"));
  await page.setViewportSize({ width: 1280, height: 1000 });
  await page.screenshot({
    path: join(evidence, "ready.png"),
    fullPage: true,
    animations: "disabled",
  });
  await writeFile(join(evidence, "results.json"), JSON.stringify({ checks, errors }, null, 2));
  console.log(JSON.stringify({ status: "passed", checks, evidence }, null, 2));
} catch (error) {
  await page?.screenshot({ path: join(evidence, "failure.png"), fullPage: true }).catch(() => {});
  console.error({
    evidence,
    checks,
    errors,
    consoleErrors,
    failedRequests: failedRequests.slice(-10),
    url: page?.url(),
    body: await page
      ?.locator("body")
      .textContent({ timeout: 1_000 })
      .catch(() => null),
  });
  throw error;
} finally {
  try {
    await browser?.close();
  } finally {
    await server.close();
  }
}
