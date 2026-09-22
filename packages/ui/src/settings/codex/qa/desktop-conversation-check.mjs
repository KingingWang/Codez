// Actual Electron -> Host -> pinned native -> loopback fixture. Never a real account/model.
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { crc32, deflateSync } from "node:zlib";
import { setTimeout } from "node:timers/promises";
import { chromium } from "playwright-core";

const mockUrl = new URL(process.env.CODEX_UI_QA_MOCK_URL ?? "http://invalid/");
assert.equal(mockUrl.hostname, "127.0.0.1", "Only the isolated loopback mock is permitted");
const state = async () => (await fetch(new URL("/qa", mockUrl))).json();
const initial = await state();
assert.equal(initial.hold, true);
assert.equal(initial.requests.length, 0, "Use a fresh isolated mock probe");
const evidence = await mkdtemp(join(tmpdir(), "codex-ui-desktop-conversation-"));
const packaged = process.env.CODEX_UI_QA_PACKAGED === "1";
const packagedRenderer = pathToFileURL(
  resolve("packages/desktop/dist/linux-unpacked/resources/app.asar/out/renderer/index.html"),
).href;
const browser = await chromium.connectOverCDP(`http://127.0.0.1:${packaged ? 9230 : 9229}`);
const page = browser
  .contexts()
  .flatMap((context) => context.pages())
  .find((entry) => {
    if (!packaged) return /^http:\/\/(?:localhost|127\.0\.0\.1|\[::1\]):5174\//.test(entry.url());
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
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await setTimeout(100);
  }
  throw new Error("Timed out waiting for actual desktop/native state");
}
function pixelPng() {
  const chunk = (type, data) => {
    const name = Buffer.from(type);
    const size = Buffer.alloc(4);
    size.writeUInt32BE(data.length);
    const sum = Buffer.alloc(4);
    sum.writeUInt32BE(crc32(Buffer.concat([name, data])));
    return Buffer.concat([size, name, data, sum]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(1, 0);
  header.writeUInt32BE(1, 4);
  header[8] = 8;
  header[9] = 6;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(Buffer.from([0, 0, 0, 0, 255]))),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}
try {
  const composer = page.getByTestId("v4-composer-input");
  assert.match(
    await page.getByRole("combobox", { name: "Default model", exact: true }).innerText(),
    /ui-qa-offline.*Configured in Codex/,
  );
  await composer.fill("QA first native input with image. No tools.");
  await page
    .locator('input[type="file"]')
    .setInputFiles({ name: "qa-pixel.png", mimeType: "image/png", buffer: pixelPng() });
  await until(() => page.getByRole("button", { name: "Send", exact: true }).isEnabled());
  await page.screenshot({ path: join(evidence, "first-image-ready.png") });
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await until(async () => (await state()).requests.length === 1);
  const first = (await state()).requests[0];
  assert.deepEqual(first, { model: "ui-qa-offline", imageCount: 1, imageIsDataUrl: true });
  checks.push(
    "NewTask first image reaches actual pinned native and loopback provider as input_image under explicit custom model",
  );
  await until(() =>
    page.getByRole("combobox", { name: "Default model", exact: true }).isDisabled(),
  );
  assert.equal(
    await page.getByRole("button", { name: "Switch mode", exact: true }).isDisabled(),
    true,
  );
  await page.getByText(/locked while Codex is busy/).waitFor();
  await page.screenshot({ path: join(evidence, "native-busy-locked.png") });
  checks.push(
    "Actual running native snapshot locks model and permission/plan controls without hiding composer",
  );
  await composer.fill("/plan must not change a busy native thread");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await until(async () => (await composer.innerText()).includes("/plan must not change"));
  assert.equal((await state()).requests.length, 1);
  checks.push("Busy /plan does not mutate thread or dispatch a second request; draft retained");
  await composer.fill("");
  await fetch(new URL("/qa/release", mockUrl), { method: "POST" });
  await page.getByText("Isolated desktop QA response 1", { exact: true }).first().waitFor();
  await until(() => page.getByRole("combobox", { name: "Default model", exact: true }).isEnabled());
  assert.equal(
    await page.getByRole("button", { name: "Switch mode", exact: true }).isEnabled(),
    true,
  );
  checks.push("Native response streams into actual conversation and idle unlocks configuration");
  await page.screenshot({ path: join(evidence, "native-image-response.png"), fullPage: true });

  await fetch(new URL("/qa/hold", mockUrl), { method: "POST" });
  await composer.fill("QA held turn before queued image. No tools.");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await until(async () => (await state()).requests.length === 2);
  await until(() =>
    page.getByRole("combobox", { name: "Default model", exact: true }).isDisabled(),
  );
  await composer.fill("QA queued image to auto-dispatch when idle. No tools.");
  await page
    .locator('input[type="file"]')
    .setInputFiles({ name: "qa-second-pixel.png", mimeType: "image/png", buffer: pixelPng() });
  await until(() => page.getByRole("button", { name: "Send", exact: true }).isEnabled());
  // 原生 followupMode=guide；Ctrl 点击走真实 composer 的反向 queue admission。
  await page.getByRole("button", { name: "Send", exact: true }).click({ modifiers: ["Control"] });
  await page
    .getByText("Codex native queue · runs automatically when idle, including after resume.")
    .waitFor();
  assert.equal(await page.locator('[data-testid^="v4-queue-item-send-now-"]').count(), 0);
  assert.equal(await page.locator('[data-testid="v4-queue-resume"]').count(), 0);
  assert.equal((await state()).requests.length, 2);
  checks.push(
    "Busy image queue admission succeeds; no unsupported immediate-send or pause/resume control",
  );
  await page.screenshot({ path: join(evidence, "native-auto-queue-waiting.png"), fullPage: true });
  await fetch(new URL("/qa/release", mockUrl), { method: "POST" });
  await until(async () => (await state()).requests.length === 3);
  const queuedImage = (await state()).requests[2];
  assert.equal(queuedImage.model, "ui-qa-offline");
  assert.equal(queuedImage.imageCount, 2, "Native history contains first and queued image");
  assert.equal(queuedImage.imageIsDataUrl, true);
  await page.getByText("Isolated desktop QA response 2", { exact: true }).first().waitFor();
  await page.getByText("Isolated desktop QA response 3", { exact: true }).first().waitFor();
  await until(async () => (await page.getByText(/Codex native queue/).count()) === 0);
  await until(() => page.getByRole("combobox", { name: "Default model", exact: true }).isEnabled());
  assert.deepEqual((await state()).completed, [1, 2, 3]);
  assert.deepEqual((await state()).interrupted, []);
  checks.push(
    "Native queued image auto-dispatches after current turn completes; response renders, queue clears and controls unlock",
  );
  await page.screenshot({
    path: join(evidence, "native-queued-image-auto-drained.png"),
    fullPage: true,
  });
  assert.deepEqual(errors, []);
  await writeFile(
    join(evidence, "results.json"),
    JSON.stringify(
      {
        mode: packaged ? "packaged" : "dev",
        renderer: page.url(),
        checks,
        state: await state(),
        errors,
      },
      null,
      2,
    ),
  );
  console.log(JSON.stringify({ status: "passed", evidence, checks }, null, 2));
} catch (error) {
  await page.screenshot({ path: join(evidence, "failure.png"), fullPage: true }).catch(() => {});
  await writeFile(
    join(evidence, "failure.json"),
    JSON.stringify(
      { checks, state: await state(), errors, text: await page.locator("body").innerText() },
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
