// Actual Electron/Host/native turn regression for a default model owned by another provider.
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright-core";

const mockUrl = new URL(process.env.CODEX_UI_QA_MOCK_URL ?? "http://invalid/");
assert.equal(mockUrl.hostname, "127.0.0.1", "Only the isolated loopback mock is permitted");
const state = async () => (await fetch(new URL("/qa", mockUrl))).json();
assert.equal((await state()).requests.length, 0, "Use a fresh mapped-provider probe");
const rendererPort = Number(process.env.CODEX_UI_QA_RENDERER_PORT ?? 5174);
const cdpPort = Number(process.env.CODEX_UI_QA_CDP_PORT ?? 9229);
const evidence = await mkdtemp(join(tmpdir(), "codex-ui-desktop-mapped-"));
const browser = await chromium.connectOverCDP(`http://127.0.0.1:${cdpPort}`);
const page = browser
  .contexts()
  .flatMap((context) => context.pages())
  .find((entry) => {
    const url = new URL(entry.url());
    return (
      ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) &&
      url.port === String(rendererPort)
    );
  });
assert.ok(page, "Refuse a non-QA renderer");
const checks = [];
const errors = [];
page.on("pageerror", (error) => errors.push(error.message));
try {
  const composer = page.getByTestId("v4-composer-input");
  const send = page.getByTestId("v4-composer-send");
  const model = page.getByRole("combobox", { name: "Default model", exact: true });
  const effort = page.getByRole("combobox", { name: "Reasoning effort", exact: true });
  await model.filter({ hasText: "GLM-5.3" }).waitFor();
  assert.match(await effort.innerText(), /high/);
  await composer.fill("QA mapped provider button send. No tools.");
  await send.click();
  await page.getByTestId("v4-stop").waitFor();
  assert.equal((await state()).requests.length, 1);
  assert.equal((await state()).requests[0].model, "glm-5.3");
  await page.screenshot({ path: join(evidence, "mapped-button-sent.png"), fullPage: true });
  await fetch(new URL("/qa/release", mockUrl), { method: "POST" });
  await page.getByText("Isolated desktop QA response 1", { exact: true }).first().waitFor();
  await page.waitForFunction(() => {
    const node = document.querySelector('[aria-label="Default model"]');
    return node && !node.hasAttribute("disabled");
  });
  checks.push("Cold-start GLM-5.3/high sends through actual Host/native without model toggles");
  await fetch(new URL("/qa/hold", mockUrl), { method: "POST" });
  await composer.fill("QA mapped provider Enter send. No tools.");
  await composer.press("Shift+Enter");
  assert.match(await composer.innerText(), /Enter send\. No tools\.\n+/);
  assert.equal((await state()).requests.length, 1, "Shift+Enter must not submit");
  await composer.press("Enter");
  await page.getByTestId("v4-stop").waitFor();
  assert.equal((await state()).requests.length, 2);
  assert.equal((await state()).requests[1].model, "glm-5.3");
  await fetch(new URL("/qa/release", mockUrl), { method: "POST" });
  await page.getByText("Isolated desktop QA response 2", { exact: true }).first().waitFor();
  assert.match(await model.innerText(), /GLM-5.3/);
  assert.match(await effort.innerText(), /high/);
  checks.push(
    "Enter dispatches a second real native turn; Shift+Enter remains newline; high retained",
  );
  assert.deepEqual(errors, []);
  await page.screenshot({ path: join(evidence, "mapped-enter-completed.png"), fullPage: true });
  await writeFile(join(evidence, "results.json"), JSON.stringify({ checks, errors }, null, 2));
  console.log(JSON.stringify({ status: "passed", checks, evidence }, null, 2));
} catch (error) {
  await page.screenshot({ path: join(evidence, "failure.png"), fullPage: true }).catch(() => {});
  await writeFile(join(evidence, "failure.json"), JSON.stringify({ checks, errors }, null, 2));
  console.error({ evidence, checks, errors });
  throw error;
} finally {
  await fetch(new URL("/qa/release", mockUrl), { method: "POST" }).catch(() => {});
  await browser.close();
}
