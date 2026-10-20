// Actual Electron → Host → bridge → pinned Codex → loopback provider retry verification.
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { setTimeout } from "node:timers/promises";
import { chromium } from "playwright-core";

const mockUrl = new URL(process.env.CODEX_UI_QA_MOCK_URL ?? "http://invalid/");
assert.equal(mockUrl.hostname, "127.0.0.1", "Only the isolated loopback mock is permitted");
const state = async () => (await fetch(new URL("/qa", mockUrl))).json();
assert.equal((await state()).requests.length, 0, "Use a fresh isolated mock probe");
const evidence = await mkdtemp(join(tmpdir(), "codex-ui-desktop-retry-"));
const packaged = process.env.CODEX_UI_QA_PACKAGED === "1";
const rendererPort = Number(process.env.CODEX_UI_QA_RENDERER_PORT ?? 5174);
const cdpPort = Number(process.env.CODEX_UI_QA_CDP_PORT ?? (packaged ? 9230 : 9229));
const packagedRenderer = pathToFileURL(
  resolve("packages/desktop/dist/linux-unpacked/resources/app.asar/out/renderer/index.html"),
).href;
const browser = await chromium.connectOverCDP(`http://127.0.0.1:${cdpPort}`);
const page = browser
  .contexts()
  .flatMap((context) => context.pages())
  .find((entry) => {
    if (!packaged) {
      const url = new URL(entry.url());
      return (
        ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) &&
        url.port === String(rendererPort)
      );
    }
    const url = new URL(entry.url());
    url.search = "";
    url.hash = "";
    return url.href === packagedRenderer;
  });
assert.ok(page, "Refuse a non-QA renderer");
const checks = [];
const errors = [];
page.on("pageerror", (error) => errors.push(error.message));
async function until(predicate) {
  const deadline = Date.now() + 35_000;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await setTimeout(100);
  }
  throw new Error("Timed out waiting for actual desktop/native retry");
}

try {
  const composer = page.getByTestId("v4-composer-input");
  await page.getByRole("combobox", { name: "Default model", exact: true }).waitFor();
  await fetch(new URL("/qa/retry-twice", mockUrl), { method: "POST" });
  await composer.fill("QA native model request retries after HTTP 503. No tools.");
  await until(() => page.getByRole("button", { name: "Send", exact: true }).isEnabled());
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await until(async () => (await state()).requests.length >= 3);
  const retry = page.getByTestId("v4-codex-retry-status");
  await retry.waitFor();
  assert.match(await retry.innerText(), /retrying/i);
  assert.match(await retry.innerText(), /HTTP 503/);
  assert.match(await retry.getAttribute("title"), /HTTP 503/);
  assert.equal((await state()).pending, 1, "Retried native request stays held during inspection");
  checks.push(
    "A real native HTTP 503 retry is visible in the active Electron chat, including HTTP code",
  );
  await page.screenshot({ path: join(evidence, "retry-visible.png"), fullPage: true });
  await page.setViewportSize({ width: 720, height: 844 });
  assert.equal(await retry.isVisible(), true);
  const statusBounds = await retry.boundingBox();
  assert.ok(statusBounds, "The compact desktop viewport retains the retry status");
  assert.equal(
    statusBounds.x + statusBounds.width <= 720,
    true,
    "Retry status must fit within the compact desktop viewport",
  );
  await page.screenshot({ path: join(evidence, "retry-compact-desktop.png"), fullPage: true });
  checks.push("Retry status stays visible in a compact desktop viewport");
  await page.setViewportSize({ width: 1440, height: 1000 });

  await fetch(new URL("/qa/release", mockUrl), { method: "POST" });
  await page.getByText("Isolated desktop QA response 3", { exact: true }).first().waitFor();
  await until(async () => (await retry.count()) === 0);
  assert.equal((await state()).completed.length, 1);
  checks.push("A successful retried response clears the status and renders the answer");
  await page.screenshot({ path: join(evidence, "retry-recovered.png"), fullPage: true });

  await fetch(new URL("/qa/hold", mockUrl), { method: "POST" });
  await composer.fill("QA next turn must not inherit retry status. No tools.");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await until(async () => (await state()).requests.length === 4);
  assert.equal(await retry.count(), 0);
  checks.push("Next native turn has no stale retry status");
  await fetch(new URL("/qa/release", mockUrl), { method: "POST" });
  await page.getByText("Isolated desktop QA response 4", { exact: true }).first().waitFor();
  assert.deepEqual(errors, []);
  await writeFile(
    join(evidence, "results.json"),
    JSON.stringify({ checks, errors, renderer: page.url(), state: await state() }, null, 2),
  );
  console.log(JSON.stringify({ status: "passed", evidence, checks }, null, 2));
} catch (error) {
  await page.screenshot({ path: join(evidence, "failure.png"), fullPage: true }).catch(() => {});
  await writeFile(
    join(evidence, "failure.json"),
    JSON.stringify(
      {
        checks,
        errors,
        renderer: page.url(),
        state: await state(),
        text: await page.locator("body").innerText(),
      },
      null,
      2,
    ),
  );
  console.error({ evidence, checks, errors });
  throw error;
} finally {
  await fetch(new URL("/qa/release", mockUrl), { method: "POST" }).catch(() => {});
  await browser.close();
}
