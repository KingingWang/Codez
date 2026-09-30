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
const sendTimings = [];
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
  // busy 时发送按钮 aria-label 随 inputRouting 变为 Queue message；统一按 testid 定位。
  const sendButton = page.getByTestId("v4-composer-send");
  assert.match(
    await page.getByRole("combobox", { name: "Default model", exact: true }).innerText(),
    /ui-qa-offline.*Configured in Codex/,
  );
  await composer.fill("QA first native input with image. No tools.");
  await page
    .locator('input[type="file"]')
    .setInputFiles({ name: "qa-pixel.png", mimeType: "image/png", buffer: pixelPng() });
  await until(() => sendButton.isEnabled());
  await page.screenshot({ path: join(evidence, "first-image-ready.png") });
  const firstSendAt = performance.now();
  await sendButton.click();
  await until(async () => (await state()).requests.length === 1);
  sendTimings.push({
    turn: 1,
    clickToObservedProviderMs: Math.round(performance.now() - firstSendAt),
  });
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
  await sendButton.click();
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
  const secondSendAt = performance.now();
  await sendButton.click();
  await until(async () => (await state()).requests.length === 2);
  sendTimings.push({
    turn: 2,
    clickToObservedProviderMs: Math.round(performance.now() - secondSendAt),
  });
  await until(() =>
    page.getByRole("combobox", { name: "Default model", exact: true }).isDisabled(),
  );

  // busy 普通发送 = 真实排队：卡片立即可见，可编辑/删除，不产生新模型请求。
  const queueItems = page.locator(
    '[data-testid^="v4-queue-item-"]:not([data-testid*="send-now"]):not([data-testid*="edit"]):not([data-testid*="delete"])',
  );
  await composer.fill("QA busy plain send queues visibly. No tools.");
  await sendButton.click();
  await page
    .getByText("Codex native queue · runs automatically when idle, including after resume.")
    .waitFor();
  await until(async () => (await queueItems.count()) === 1);
  assert.equal((await state()).requests.length, 2, "busy 排队不产生新模型请求");
  assert.equal(await page.locator('[data-testid^="v4-queue-item-edit-"]').count(), 1);
  assert.equal(await page.locator('[data-testid^="v4-queue-item-delete-"]').count(), 1);
  assert.equal(
    await page.locator('[data-testid^="v4-queue-item-send-now-"]').count(),
    1,
    "busy 队列项提供抢占式立即发送",
  );
  assert.equal(await page.locator('[data-testid="v4-queue-resume"]').count(), 0);
  checks.push(
    "Busy plain send enqueues into the visible native queue card with edit/delete/send-now controls",
  );
  await page.screenshot({ path: join(evidence, "native-busy-queue-visible.png"), fullPage: true });

  // 编辑 = 撤回到输入框：卡片消失、原文回到 composer，改完再发重新入队。
  await page.locator('[data-testid^="v4-queue-item-edit-"]').first().click();
  await until(async () => (await queueItems.count()) === 0);
  await until(async () =>
    (await composer.innerText()).includes("QA busy plain send queues visibly"),
  );
  await composer.fill("QA busy plain send queues visibly. Edited. No tools.");
  await until(() => sendButton.isEnabled());
  await sendButton.click();
  await until(async () => (await queueItems.count()) === 1);
  checks.push("Queue item edit recalls text into the composer and re-enqueues the edited text");

  // 删除：卡片消失、不产生新请求。
  await page.locator('[data-testid^="v4-queue-item-delete-"]').first().click();
  await until(async () => (await queueItems.count()) === 0);
  assert.equal((await state()).requests.length, 2);
  checks.push("Queue item delete removes the card without dispatching a request");

  // 重新排队一条带图消息（普通点击即排队），等待空闲自动 dispatch。
  await composer.fill("QA queued image to auto-dispatch when idle. No tools.");
  await page
    .locator('input[type="file"]')
    .setInputFiles({ name: "qa-second-pixel.png", mimeType: "image/png", buffer: pixelPng() });
  await until(() => sendButton.isEnabled());
  await sendButton.click();
  await until(async () => (await queueItems.count()) === 1);
  assert.equal((await state()).requests.length, 2);
  await page.screenshot({ path: join(evidence, "native-auto-queue-waiting.png"), fullPage: true });
  await fetch(new URL("/qa/release", mockUrl), { method: "POST" });
  await until(async () => (await state()).requests.length === 3);
  const queuedImage = (await state()).requests[2];
  assert.equal(queuedImage.model, "ui-qa-offline");
  assert.equal(queuedImage.imageCount, 2, "Native history contains first and queued image");
  assert.equal(queuedImage.imageIsDataUrl, true);
  await page.getByText("Isolated desktop QA response 2", { exact: true }).first().waitFor();
  await page.getByText("Isolated desktop QA response 3", { exact: true }).first().waitFor();
  await until(async () => (await queueItems.count()) === 0);
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

  // busy Ctrl+发送 = 抢占：当前 turn 被中断，新消息立即开始，不经过队列。
  await fetch(new URL("/qa/hold", mockUrl), { method: "POST" });
  await composer.fill("QA turn to be preempted by ctrl send. No tools.");
  await sendButton.click();
  await until(async () => (await state()).requests.length === 4);
  await composer.fill("QA preempting ctrl send. No tools.");
  await sendButton.click({ modifiers: ["Control"] });
  await until(async () => (await state()).requests.length === 5);
  await until(async () => (await state()).interrupted.includes(4));
  assert.equal(await queueItems.count(), 0, "抢占不经过队列");
  checks.push(
    "Busy ctrl+send preempts: running turn interrupted, new input starts immediately without queueing",
  );
  await page.screenshot({ path: join(evidence, "native-ctrl-send-preempt.png"), fullPage: true });
  await fetch(new URL("/qa/release", mockUrl), { method: "POST" });
  await page.getByText("Isolated desktop QA response 5", { exact: true }).first().waitFor();
  await until(() => page.getByRole("combobox", { name: "Default model", exact: true }).isEnabled());
  assert.deepEqual((await state()).completed, [1, 2, 3, 5]);
  assert.deepEqual((await state()).interrupted, [4]);

  // 队列项"立即发送"抢占：中断当前 turn，选中项立即开始，队列清空。
  await fetch(new URL("/qa/hold", mockUrl), { method: "POST" });
  await composer.fill("QA turn to be preempted by queue item. No tools.");
  await sendButton.click();
  await until(async () => (await state()).requests.length === 6);
  await composer.fill("QA queued item to promote. No tools.");
  await sendButton.click();
  await until(async () => (await queueItems.count()) === 1);
  await page.locator('[data-testid^="v4-queue-item-send-now-"]').first().click();
  await until(async () => (await state()).requests.length === 7);
  await until(async () => (await state()).interrupted.includes(6));
  await until(async () => (await queueItems.count()) === 0);
  checks.push("Queue item send-now preempts the running turn and starts the promoted item");
  await page.screenshot({
    path: join(evidence, "native-queue-send-now-preempt.png"),
    fullPage: true,
  });
  await fetch(new URL("/qa/release", mockUrl), { method: "POST" });
  await page.getByText("Isolated desktop QA response 7", { exact: true }).first().waitFor();
  await until(() => page.getByRole("combobox", { name: "Default model", exact: true }).isEnabled());
  assert.deepEqual((await state()).completed, [1, 2, 3, 5, 7]);
  assert.deepEqual((await state()).interrupted, [4, 6]);
  assert.deepEqual(errors, []);
  await writeFile(
    join(evidence, "results.json"),
    JSON.stringify(
      {
        mode: packaged ? "packaged" : "dev",
        renderer: page.url(),
        checks,
        sendTimings,
        state: await state(),
        errors,
      },
      null,
      2,
    ),
  );
  console.log(JSON.stringify({ status: "passed", evidence, checks, sendTimings }, null, 2));
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
