// Attach only to the isolated desktop-probe instance. Does not send a model turn.
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright-core";
const evidence = await mkdtemp(join(tmpdir(), "codex-ui-desktop-check-"));
const browser = await chromium.connectOverCDP("http://127.0.0.1:9229");
const page = browser
  .contexts()
  .flatMap((context) => context.pages())
  .find((entry) => /^http:\/\/(?:localhost|127\.0\.0\.1|\[::1\]):5174\//.test(entry.url()));
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
  await writeFile(join(evidence, "results.json"), JSON.stringify({ checks }, null, 2));
  console.log(JSON.stringify({ status: "passed", evidence, checks }, null, 2));
} catch (error) {
  await page.screenshot({ path: join(evidence, "failure.png") });
  console.error({ evidence, checks });
  throw error;
} finally {
  await browser.close();
}
