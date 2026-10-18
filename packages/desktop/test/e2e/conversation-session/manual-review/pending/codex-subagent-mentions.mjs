// CSM01/CSM02 browser candidate: isolated Vite + real ChatPromptEditor/Lexical chain.
// Run from repo root: node packages/desktop/test/e2e/conversation-session/manual-review/pending/codex-subagent-mentions.mjs
// Optional real-Electron hooks are intentionally not used by this browser lane:
// CODEX_UI_QA_CDP_PORT / CODEX_UI_QA_RENDERER_PORT may point a future renderer to this same URL.
import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createServer } from "vite";
import { chromium } from "playwright-core";

const evidenceRoot = resolve("packages/desktop/.e2e-artifacts");
const evidence = await mkdtemp(join(evidenceRoot, "codex-subagent-mentions-"));
const checks = [];
const errors = [];
const consoleErrors = [];

await mkdir(evidence, { recursive: true });

const rendererPort = Number(process.env.CODEZ_UI_QA_RENDERER_PORT ?? 5191);
assert.ok(
  Number.isInteger(rendererPort) && rendererPort > 1023 && rendererPort <= 65535,
  `Invalid renderer port: ${rendererPort}`,
);

const server = await createServer({
  configFile: resolve("packages/desktop/vite.config.ts"),
  root: resolve("packages/ui/src/settings/codex/qa"),
  cacheDir: join(evidence, "vite-cache"),
  server: { host: "127.0.0.1", port: rendererPort, strictPort: true },
});

let browser;
try {
  await server.listen();
  browser = await chromium.launch({
    executablePath: process.env.CHROME_PATH ?? "/opt/google/chrome/chrome",
    headless: true,
    args: ["--no-sandbox"],
    env: {
      PATH: process.env.PATH,
      HOME: evidence,
      XDG_CONFIG_HOME: evidence,
      XDG_CACHE_HOME: evidence,
    },
  });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  page.setDefaultTimeout(15_000);
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  await page.route("**/*", (route) =>
    new URL(route.request().url()).hostname === "127.0.0.1" ? route.continue() : route.abort(),
  );

  await page.goto(`http://127.0.0.1:${rendererPort}/subagent-mentions.html`, {
    waitUntil: "commit",
  });
  const input = page.getByTestId("codex-subagent-input");
  const send = page.getByRole("button", { name: "Send fixture message", exact: true });
  const submitted = page.getByTestId("fixture-submitted");
  const inspection = page.getByTestId("fixture-inspection");
  await input.waitFor({ timeout: 30_000 });

  const readInspection = async () => JSON.parse(await inspection.innerText());
  const inspect = async () => {
    await page.getByRole("button", { name: "Inspect fixture", exact: true }).click();
    return readInspection();
  };
  const option = (id) => page.locator(`[data-testid="prompt-suggestion-option-${id}"]`);
  const allOptionTexts = async () =>
    page.locator('[data-testid="prompt-suggestion-panel"] [role="option"]').allInnerTexts();

  await input.click();
  await input.pressSequentially("/", { delay: 20 });
  await page.getByTestId("prompt-suggestion-section-subagents").waitFor();
  await page.waitForFunction(
    () =>
      document.querySelector('[data-testid="prompt-suggestion-section-subagents"]') !== null &&
      document.querySelectorAll('[data-testid^="prompt-suggestion-option-subagent:"]').length >= 5,
  );
  const firstMenuTexts = await allOptionTexts();
  assert.equal(firstMenuTexts.length, 5, `Expected five valid projected roles: ${firstMenuTexts}`);
  assert.ok(firstMenuTexts.join("\n").includes("user-one"));
  assert.ok(firstMenuTexts.join("\n").includes("user-two"));
  assert.ok(firstMenuTexts.join("\n").includes("Project-Reviewer"));
  assert.ok(!firstMenuTexts.join("\n").includes("invalid-blank"));
  assert.equal(
    firstMenuTexts.filter((text) => text.includes("shared-name")).length,
    1,
    "Same-name role must occur exactly once",
  );
  assert.match(firstMenuTexts.find((text) => text.includes("shared-name")) ?? "", /Workspace/);
  await page.screenshot({
    path: join(evidence, "desktop-menu.png"),
    fullPage: true,
    animations: "disabled",
  });

  await input.pressSequentially("project-reviewer", { delay: 10 });
  await page.waitForFunction(() => {
    const options = [
      ...document.querySelectorAll('[data-testid^="prompt-suggestion-option-subagent:"]'),
    ];
    return (
      options.length === 2 && options.some((item) => item.textContent?.includes("project-reviewer"))
    );
  });
  const searchedTexts = await allOptionTexts();
  assert.ok(
    searchedTexts.some((text) => text.includes("Workspace · Reviews isolated project facts")),
  );
  assert.ok(searchedTexts.some((text) => text.includes("Workspace · Case-sensitive sibling")));
  await option("subagent:codex:project:project-reviewer.toml").click();
  await input.pressSequentially("Please review the isolated fixture.", { delay: 5 });
  await send.click();
  const firstSubmission = JSON.parse(await submitted.innerText());
  assert.equal(firstSubmission.text, "@project-reviewer Please review the isolated fixture.");
  assert.ok(!JSON.stringify(firstSubmission).includes("private instructions"));
  await page.screenshot({
    path: join(evidence, "desktop-selected.png"),
    fullPage: true,
    animations: "disabled",
  });

  const afterFirstSubmit = await inspect();
  assert.equal(afterFirstSubmit.legacyReads, 0);
  assert.equal(afterFirstSubmit.roleReads, 1);
  assert.deepEqual(afterFirstSubmit.listAgentRolesParams, [
    { workspacePath: "/isolated/codex-subagent-mentions", workspaceIdentity: "identity-csm01" },
  ]);

  const openMenu = async () => {
    // Keep the editor a real draft surface between menu sessions. Leaving the prior
    // mention/tail in place can turn the next `/` into a continuation token instead
    // of a fresh trigger and makes refresh-count reasoning depend on caret placement.
    await input.click();
    await input.press("Control+A");
    await input.press("Backspace");
    await input.click();
    await input.pressSequentially("/", { delay: 20 });
    await page.getByTestId("prompt-suggestion-section-subagents").waitFor();
    await page.waitForFunction(() => {
      const status = document.querySelector('[data-testid="prompt-suggestion-status-subagents"]');
      return status?.getAttribute("data-status") !== "loading";
    });
  };

  await openMenu();
  const beforeRefreshReads = (await inspect()).roleReads;
  await page.getByRole("button", { name: "Change project role", exact: true }).click();
  await openMenu();
  await page.waitForFunction(() =>
    [...document.querySelectorAll('[data-testid^="prompt-suggestion-option-subagent:"]')].some(
      (item) => item.textContent?.includes("Refreshed project role description"),
    ),
  );
  const refreshedTexts = await allOptionTexts();
  assert.ok(refreshedTexts.some((text) => text.includes("Refreshed project role description")));
  const afterRefresh = await inspect();
  assert.equal(afterRefresh.roleReads, beforeRefreshReads + 1);
  assert.equal(afterRefresh.legacyReads, 0);
  assert.ok(
    afterRefresh.listAgentRolesParams.every(
      (params) => params.workspaceIdentity === "identity-csm01",
    ),
  );
  checks.push(
    "CSM01/02 desktop: >2 roles, filtering, project precedence, exact @name, and refresh",
  );

  await page.setViewportSize({ width: 390, height: 844 });
  await openMenu();
  await page.waitForFunction(
    () =>
      document.querySelectorAll('[data-testid^="prompt-suggestion-option-subagent:"]').length >= 5,
  );
  const panelBox = await page.getByTestId("prompt-suggestion-panel").boundingBox();
  assert.ok(panelBox, "Narrow panel is rendered");
  assert.ok(
    panelBox.x >= 0 && panelBox.x + panelBox.width <= 390,
    `Panel overflows: ${JSON.stringify(panelBox)}`,
  );
  const inputBox = await page.getByTestId("codex-subagent-input").boundingBox();
  assert.ok(inputBox && inputBox.x >= 0 && inputBox.x + inputBox.width <= 390);
  await page.screenshot({
    path: join(evidence, "mobile-390-menu.png"),
    fullPage: true,
    animations: "disabled",
  });
  checks.push("CSM01 mobile 390px: menu and composer remain in viewport");

  assert.deepEqual(errors, []);
  assert.deepEqual(consoleErrors, []);
} catch (error) {
  checks.push("failed");
  errors.push(error instanceof Error ? (error.stack ?? error.message) : String(error));
  try {
    const path = join(evidence, "failure.png");
    const context = browser?.contexts()[0];
    const page = context?.pages()[0];
    if (page) await page.screenshot({ path, fullPage: true });
  } catch {
    // The original error is more useful than evidence-capture failure.
  }
  throw error;
} finally {
  await writeFile(
    join(evidence, "results.json"),
    JSON.stringify({ status: errors.length === 0 ? "passed" : "failed", checks, errors }, null, 2),
  );
  await browser?.close();
  await server.close();
  console.log(
    JSON.stringify(
      { status: errors.length === 0 ? "passed" : "failed", checks, evidence },
      null,
      2,
    ),
  );
}
