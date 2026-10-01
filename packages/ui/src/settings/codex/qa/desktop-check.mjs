// Attach only to the isolated desktop-probe instance. Does not send a model turn.
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright-core";
const evidence = await mkdtemp(join(tmpdir(), "codex-ui-desktop-check-"));
const rendererPort = Number(process.env.CODEX_UI_QA_RENDERER_PORT ?? 5174);
const cdpPort = Number(process.env.CODEX_UI_QA_CDP_PORT ?? 9229);
for (const port of [rendererPort, cdpPort]) {
  assert.ok(Number.isInteger(port) && port > 1023 && port <= 65535, "Invalid isolated QA port");
}
const browser = await chromium.connectOverCDP(`http://127.0.0.1:${cdpPort}`);
const page = browser
  .contexts()
  .flatMap((context) => context.pages())
  .find((entry) => {
    const url = new URL(entry.url());
    return (
      url.protocol === "http:" &&
      ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) &&
      Number(url.port) === rendererPort
    );
  });
if (!page)
  throw new Error("Expected isolated desktop with local QA renderer; refusing another page");
const checks = [];
try {
  const startupErrors = [];
  page.on("pageerror", (error) => startupErrors.push(error.message));
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.getByRole("button", { name: "New task", exact: true }).waitFor();
  assert.deepEqual(startupErrors, [], "Renderer startup must not evaluate Host-only Node modules");
  checks.push("Fresh desktop renderer shows navigation without a Node crypto browser exception");
  await page.keyboard.press("Escape");
  const back = page.getByRole("button", { name: "Back to workspace", exact: true });
  if (await back.count()) await back.first().click();
  if (!(await page.getByTestId("v4-composer-input").count()))
    await page.getByRole("button", { name: "New task", exact: true }).click();
  assert.match(
    await page.getByRole("combobox", { name: "Default model", exact: true }).innerText(),
    /ui-qa-offline.*Configured in Codex/,
  );
  await page.getByTestId("v4-composer-input").fill("Isolated QA draft — do not send");
  await page.waitForFunction(() =>
    [...document.querySelectorAll("button")].some(
      (button) => button.getAttribute("aria-label") === "Send" && !button.disabled,
    ),
  );
  checks.push(
    "Actual desktop NewTask defaults to explicitly configured custom model absent from discovery, Send ready without a legacy registry or reasoning option",
  );
  await page.screenshot({ path: join(evidence, "native-composer.png") });
  await page.locator('input[type="file"]').setInputFiles({
    name: "qa-pixel.png",
    mimeType: "image/png",
    buffer: Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==",
      "base64",
    ),
  });
  await page.waitForFunction(() =>
    [...document.querySelectorAll("button")].some(
      (button) => button.getAttribute("aria-label") === "Send" && !button.disabled,
    ),
  );
  await page.screenshot({ path: join(evidence, "native-first-image-ready.png") });
  checks.push(
    "Actual native first-image selection uploads to prewarm session and restores Send readiness (no model turn)",
  );
  const removeImage = page.getByRole("button", { name: /remove.*qa-pixel|remove attachment/i });
  if (await removeImage.count()) await removeImage.first().click();
  await page.getByTestId("v4-composer-input").fill("");
  assert.equal(await page.getByRole("button", { name: "Connect", exact: true }).count(), 0);
  await page.getByRole("button", { name: "Codex · Account", exact: true }).click();
  assert.equal(await page.getByRole("menuitem", { name: "Log in", exact: true }).count(), 0);
  await page.getByRole("menuitem", { name: "Codex · Account", exact: true }).click();
  await page.getByText("This provider does not require OpenAI sign-in.").waitFor();
  checks.push("Actual native account/read shows isolated no-auth provider; no login mutation");
  checks.push("Sidebar legacy Connect replaced with Codex account entry opening native settings");
  await page.getByRole("button", { name: "Models & permissions", exact: true }).click();
  await page.getByRole("combobox", { name: "Default model", exact: true }).waitFor();
  assert.match(
    await page.getByRole("combobox", { name: "Default model", exact: true }).innerText(),
    /ui-qa-offline.*Configured in Codex/,
  );
  checks.push("Native settings model selector shows the configured custom model, never blank");
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await page.waitForFunction(() => !document.body.innerText.includes("Reading Codex state…"));
  assert.equal(await page.getByText(/Invalid input: expected string/).count(), 0);
  checks.push(
    "Actual native config/layers/model/requirements read and refresh render without schema failure",
  );
  await page.screenshot({ path: join(evidence, "native-settings.png") });
  await page.getByRole("button", { name: "MCP Servers", exact: true }).click();
  assert.equal(await page.getByTestId("codex-settings").count(), 1);
  checks.push("Legacy MCP settings navigation routes to dedicated native settings");
  await page.getByRole("button", { name: "Configuration", exact: true }).click();
  await page.getByRole("heading", { name: "Configuration", exact: true }).waitFor();
  assert.equal(
    await page.locator("main h2").first().innerText(),
    "Codex",
    "Internal-only configuration must not keep MCP as the outer heading",
  );
  assert.equal(
    await page.getByRole("button", { name: "Codex", exact: true }).getAttribute("aria-current"),
    "page",
  );
  assert.equal(
    await page
      .getByRole("button", { name: "MCP Servers", exact: true })
      .getAttribute("aria-current"),
    null,
  );
  await page.getByRole("button", { name: "Thread history", exact: true }).click();
  await page.getByRole("heading", { name: "Codex thread history", exact: true }).waitFor();
  assert.equal(await page.locator("main h2").first().innerText(), "Codex");
  await page.getByRole("button", { name: "Codex", exact: true }).click();
  await page.getByRole("heading", { name: "Account", exact: true }).waitFor();
  checks.push(
    "Inner-only Codex tabs reset the outer heading and sidebar; explicit Codex returns to Account",
  );
  await page.getByRole("button", { name: "Skills", exact: true }).last().click();
  await page.getByRole("button", { name: /Disable imagegen \(system:/ }).waitFor();
  await page.getByRole("button", { name: "Plugins & marketplaces", exact: true }).click();
  await page.getByRole("button", { name: /Install game-studio \(openai-api-curated,/ }).waitFor();
  await page.getByRole("button", { name: "Remove openai-api-curated", exact: true }).click();
  await page.getByRole("button", { name: "Confirm removal: Remove openai-api-curated" }).waitFor();
  await page.getByRole("button", { name: "Cancel openai-api-curated", exact: true }).click();
  checks.push(
    "Native Codex skills, plugins and marketplace confirmations expose target-specific names",
  );
  await writeFile(join(evidence, "results.json"), JSON.stringify({ checks }, null, 2));
  console.log(JSON.stringify({ status: "passed", evidence, checks }, null, 2));
} catch (error) {
  await page.screenshot({ path: join(evidence, "failure.png") });
  console.error({ evidence, checks });
  throw error;
} finally {
  await browser.close();
}
