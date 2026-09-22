// Run from repo root: node packages/ui/src/settings/codex/qa/interaction-e2e.mjs
// Uses installed Vite + playwright-core + system Chrome. No downloads/dependencies.
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createServer } from "vite";
import { chromium } from "playwright-core";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const evidence = await mkdtemp(join(tmpdir(), "codex-ui-interaction-e2e-"));
const checks = [];
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
  args: ["--no-sandbox", "--remote-debugging-port=9338"],
  env: {
    PATH: process.env.PATH,
    HOME: evidence,
    XDG_CONFIG_HOME: evidence,
    XDG_CACHE_HOME: evidence,
  },
});
const page = await browser.newPage({ viewport: { width: 1280, height: 1100 } });
const errors = [];
page.on("pageerror", (error) => errors.push(error.message));
await page.route("**/*", (route) =>
  new URL(route.request().url()).hostname === "127.0.0.1" ? route.continue() : route.abort(),
);
const result = async () => JSON.parse(await page.getByTestId("result").innerText());
const waitEnabled = async (name) => {
  await page.getByRole("button", { name, exact: true }).waitFor();
  await page.waitForFunction(
    (label) =>
      [...document.querySelectorAll("button")].some(
        (button) => button.textContent === label && !button.disabled,
      ),
    name,
  );
};
try {
  await page.goto("http://127.0.0.1:5188/");
  await waitEnabled("Send fixture");
  assert.equal(await page.getByTestId("legacy-reads").innerText(), "Legacy registry reads: 0");
  await page.getByRole("button", { name: "Send fixture", exact: true }).click();
  await page.waitForFunction(() =>
    document.querySelector('[data-testid="result"]')?.textContent?.includes('"native-model"'),
  );
  assert.deepEqual((await result()).modelSelection, {
    providerId: "native-provider",
    modelId: "native-model",
    options: { reasoningLevel: "medium" },
  });
  checks.push("NewTask native config/model readiness, legacy registry never accessed");
  await page.getByRole("button", { name: "Active conversation", exact: true }).click();
  await page.getByRole("button", { name: "Send fixture", exact: true }).click();
  await page.waitForFunction(() =>
    document.querySelector('[data-testid="result"]')?.textContent?.includes('"second-model"'),
  );
  assert.equal((await result()).modelSelection.options.reasoningLevel, "high");
  checks.push("Active conversation initializes native model/effort, not global defaults");
  await page.getByRole("button", { name: "Toggle native busy" }).click();
  assert.equal(
    await page.getByRole("combobox", { name: "Default model", exact: true }).isDisabled(),
    true,
  );
  assert.equal(
    await page.getByRole("combobox", { name: "Reasoning effort", exact: true }).isDisabled(),
    true,
  );
  assert.equal(
    await page.getByRole("button", { name: "Switch mode", exact: true }).isDisabled(),
    true,
  );
  assert.equal(
    await page.getByRole("button", { name: "Send fixture", exact: true }).isEnabled(),
    true,
  );
  await page.getByRole("button", { name: "Toggle native busy" }).click();
  assert.equal(
    await page.getByRole("button", { name: "Switch mode", exact: true }).isEnabled(),
    true,
  );
  checks.push(
    "Busy projection disables real native model/effort and mode/plan controls; same-settings send remains enabled and idle unlocks controls",
  );
  await page.getByRole("button", { name: "Toggle configured custom model" }).click();
  const models = page.getByTestId("codex-composer-models");
  await models.getByRole("combobox", { name: "Default model" }).click();
  await page
    .getByRole("option", { name: "vendor/private · Configured in Codex", exact: true })
    .click();
  assert.equal(await models.getByRole("combobox", { name: "Reasoning effort" }).count(), 0);
  await page.getByText("Reasoning effort: custom-effort", { exact: true }).waitFor();
  await page.getByRole("button", { name: "Send fixture", exact: true }).click();
  await page.waitForFunction(() =>
    document.querySelector('[data-testid="result"]')?.textContent?.includes("vendor/private"),
  );
  assert.deepEqual((await result()).modelSelection, {
    providerId: "native-provider",
    modelId: "vendor/private",
    options: { reasoningLevel: "custom-effort" },
  });
  checks.push(
    "Configured custom model absent from discovery remains selectable/submittable with native effort and no fabricated capability picker",
  );
  await page.getByRole("button", { name: "Toggle configured custom model" }).click();
  await models.getByRole("combobox", { name: "Default model" }).click();
  await page.getByRole("option", { name: "second-model", exact: true }).click();
  await page.getByRole("button", { name: "Toggle catalog failure" }).click();
  await page.getByRole("alert").filter({ hasText: "Fixture catalog unavailable" }).waitFor();
  assert.equal(
    await page.getByRole("button", { name: "Send fixture", exact: true }).isDisabled(),
    true,
  );
  await page.getByRole("button", { name: "Toggle catalog failure" }).click();
  await waitEnabled("Send fixture");
  checks.push("Catalog failure blocks send; refresh recovers without legacy fallback");
  assert.equal(await page.getByText(/Codex native queue/).count(), 1);
  assert.equal(await page.locator('[data-testid="v4-queue-resume"]').count(), 0);
  assert.equal(await page.getByText(/queue is paused/i).count(), 0);
  checks.push("Native queue label, no false pause/resume affordance");

  await page.getByRole("button", { name: "Native questions", exact: true }).click();
  assert.equal(await page.getByRole("button", { name: "Submit answers" }).isDisabled(), true);
  await page.getByRole("button", { name: "Staging — Isolated", exact: true }).click();
  assert.equal(await page.getByRole("button", { name: "Submit answers" }).isDisabled(), true);
  const secret = page.getByLabel("Enter fixture secret", { exact: true });
  assert.equal(await secret.getAttribute("type"), "password");
  await secret.fill("qa-only-secret");
  await page.screenshot({ path: join(evidence, "native-question.png") });
  await page.getByRole("button", { name: "Submit answers" }).dblclick();
  await page.getByRole("dialog").waitFor({ state: "hidden" });
  assert.deepEqual((await result()).payload.answer, {
    action: "accept",
    content: { "deployment-target": ["Staging"], "private-code": ["qa-only-secret"] },
  });
  assert.equal(
    await page.evaluate(() => JSON.stringify({ ...localStorage }).includes("qa-only-secret")),
    false,
  );
  checks.push(
    "Real V4 question command uses native IDs/string arrays; required fields; password; no persisted secret",
  );

  await page.getByRole("button", { name: "Reject next answer" }).click();
  await page.getByRole("button", { name: "Native questions", exact: true }).click();
  await page.getByLabel("Where should this run?", { exact: true }).fill("Custom target");
  await page.getByLabel("Enter fixture secret", { exact: true }).fill("retry-only");
  await page.getByRole("button", { name: "Submit answers" }).click();
  await page.getByRole("alert").filter({ hasText: "Operation failed" }).waitFor();
  assert.equal(
    await page.getByLabel("Enter fixture secret", { exact: true }).inputValue(),
    "retry-only",
  );
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await page.getByRole("dialog").waitFor({ state: "hidden" });
  assert.deepEqual((await result()).payload.answer, { action: "cancel" });
  checks.push("Rejected native answer stays actionable; cancel sends no secret content");

  for (const [label, id] of [
    ["Allow", "accept"],
    ["Allow for this session", "acceptForSession"],
    ["Deny", "decline"],
    ["Cancel turn", "cancel"],
  ]) {
    await page.getByRole("button", { name: "Native approval", exact: true }).click();
    if (id === "accept")
      await page.screenshot({ path: join(evidence, "native-approval.png"), fullPage: true });
    await page.getByRole("option", { name: label, exact: true }).focus();
    await page.getByRole("option", { name: label, exact: true }).press("Enter");
    await page.waitForFunction((optionId) => {
      const text = document.querySelector('[data-testid="result"]')?.textContent;
      return text && JSON.parse(text).payload?.answer?.optionId === optionId;
    }, id);
    assert.equal((await result()).payload.answer.optionId, id);
    await page.getByRole("option", { name: label, exact: true }).waitFor({ state: "hidden" });
  }
  checks.push(
    "Real PermissionDialog preserves native accept/acceptForSession/decline/cancel option IDs",
  );
  await page.getByRole("button", { name: "Models & permissions", exact: true }).click();
  const settings = page.getByTestId("codex-settings");
  await settings.getByRole("combobox", { name: "Default model" }).click();
  await page.getByRole("option", { name: "second-model", exact: true }).click();
  await settings.getByRole("button", { name: "Save", exact: true }).click();
  await page.getByText("Write accepted. Review refreshed effective values below.").waitFor();
  await page.getByRole("button", { name: "Inspect RPC log", exact: true }).click();
  const recorded = (await result()).requests;
  assert.equal(
    (await result()).interactionCommandCount,
    7,
    "Double-click must not duplicate native answers",
  );
  assert.equal((await result()).legacyReads, 0);
  const write = recorded.find((request) => request.method === "config/batchWrite");
  assert.equal(write.params.expectedVersion, "fixture-v1");
  assert.deepEqual(write.params.edits[0], {
    keyPath: "model",
    value: "second-model",
    mergeStrategy: "replace",
  });
  checks.push("Real settings hook writes native versioned config and refreshes effective values");
  assert.deepEqual(errors, []);
  await page.screenshot({ path: join(evidence, "desktop-width.png"), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: join(evidence, "compact-width.png"), fullPage: true });
  if (process.env.AGENT_BROWSER_BIN) {
    const { stdout } = await promisify(execFile)(process.execPath, [
      process.env.AGENT_BROWSER_BIN,
      "--session",
      "codex-ui-qa",
      "--cdp",
      "9338",
      "snapshot",
      "-i",
    ]);
    await writeFile(join(evidence, "agent-browser-snapshot.txt"), stdout);
  }
  await writeFile(join(evidence, "results.json"), JSON.stringify({ checks, errors }, null, 2));
  console.log(JSON.stringify({ status: "passed", checks, evidence }, null, 2));
} catch (error) {
  await page.screenshot({ path: join(evidence, "failure.png"), fullPage: true }).catch(() => {});
  console.error({ evidence, checks, errors });
  throw error;
} finally {
  await browser.close();
  await server.close();
}
