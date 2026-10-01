// 真实隔离 Electron → Host → Codex：忙时引导同轮、排队下一轮；绝不触及真实账号。
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { setTimeout } from "node:timers/promises";
import { chromium } from "playwright-core";

const mockUrl = new URL(process.env.CODEX_UI_QA_MOCK_URL ?? "http://invalid/");
assert.equal(mockUrl.hostname, "127.0.0.1", "Only isolated loopback QA is permitted");
const state = async () => (await fetch(new URL("/qa", mockUrl))).json();
assert.equal((await state()).requests.length, 0, "Use a fresh mock probe");
const evidence = await mkdtemp(join(tmpdir(), "codex-ui-followup-"));
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
  throw new Error("Timed out waiting for native follow-up delivery");
}

try {
  const composer = page.getByTestId("v4-composer-input");
  const send = page.getByTestId("v4-composer-send");
  const choice = page.getByTestId("v4-codex-followup-mode");
  await page.getByRole("combobox", { name: "Default model" }).waitFor();
  assert.equal(await choice.count(), 0, "Idle composer hides busy-only choice");
  await composer.fill("QA hold first turn. No tools.");
  await send.click();
  await until(async () => (await state()).requests.length === 1);
  await choice.waitFor();
  assert.match(await choice.innerText(), /Queue/);
  checks.push("Busy composer offers Queue by default; idle composer hides the choice");
  await page.screenshot({ path: join(evidence, "busy-mode-default.png") });

  await choice.click();
  await page.getByRole("menuitemradio", { name: /Guide.*current task/i }).click();
  await choice.focus();
  await page.keyboard.press("Enter");
  await page.getByRole("menuitemradio", { name: /Queue.*after this task/i }).focus();
  await page.keyboard.press("Enter");
  await until(async () => (await choice.innerText()).includes("Queue"));
  await choice.focus();
  await page.keyboard.press("Enter");
  await page.getByRole("menuitemradio", { name: /Guide.*current task/i }).focus();
  await page.keyboard.press("Enter");
  await until(async () => (await choice.innerText()).includes("Guide"));
  checks.push("Follow-up menu changes intent with both pointer and keyboard");
  await composer.fill("QA guide: keep working on the same task.");
  assert.equal(await send.getAttribute("aria-label"), "Steer current run");
  await page.keyboard.down("Control");
  await until(async () => (await send.getAttribute("aria-label")) === "Add to queue");
  await page.keyboard.up("Control");
  assert.equal(await send.getAttribute("aria-label"), "Steer current run");
  checks.push("Guide + Ctrl modifier announces the inverse Queue delivery");
  await page.screenshot({ path: join(evidence, "guide-before-send.png") });
  await send.click();
  await page
    .getByText("Steer accepted · waiting for the next model step", { exact: true })
    .waitFor();
  assert.equal((await state()).requests.length, 1, "Guidance waits for next model step");
  assert.equal(await page.getByTestId("v4-queue").count(), 0);
  assert.match(await choice.innerText(), /Queue/, "Accepted guide resets next-send choice");
  checks.push("Guide attaches to current turn and waits without creating a future queue card");
  await page.screenshot({ path: join(evidence, "guide-pending.png"), fullPage: true });

  await composer.fill("QA queued next turn after guidance.");
  await send.click();
  const queue = page.getByTestId("v4-queue");
  await queue.waitFor();
  assert.match(await queue.innerText(), /Queued \(1\)/);
  assert.match(await queue.innerText(), /Starts after the current task/);
  assert.match(
    await queue
      .getByRole("button", { name: "Interrupt the current task and send this message now" })
      .innerText(),
    /Interrupt/,
  );
  assert.equal((await state()).requests.length, 1);
  checks.push("Queue card labels timing, count and interruption; future turn stays pending");
  await page.screenshot({ path: join(evidence, "queue-with-guide-pending.png"), fullPage: true });
  const guideHint = page.getByTestId("v4-codex-guide-notice");
  const queueBounds = await queue.boundingBox();
  const hintBounds = await guideHint.boundingBox();
  assert.ok(queueBounds && hintBounds && queueBounds.y + queueBounds.height < hintBounds.y);
  await page.setViewportSize({ width: 720, height: 844 });
  const narrowChoice = await choice.boundingBox();
  const narrowQueue = await queue.boundingBox();
  const narrowModelInfo = await page.getByTestId("codex-composer-models").boundingBox();
  assert.ok(narrowChoice && narrowChoice.x >= 0 && narrowChoice.x + narrowChoice.width <= 720);
  assert.ok(narrowQueue && narrowQueue.x >= 0 && narrowQueue.x + narrowQueue.width <= 720);
  assert.ok(narrowModelInfo && narrowModelInfo.height <= 36, "Busy model facts stay one line");
  await page.getByRole("status", { name: /Model, reasoning and permissions are locked/ }).waitFor();
  await page.screenshot({ path: join(evidence, "followup-narrow-dark.png"), fullPage: true });
  checks.push("Queue, Guide hint and mode selector fit a narrow desktop window in dark theme");
  await page.setViewportSize({ width: 1200, height: 800 });

  await fetch(new URL("/qa/release-one", mockUrl), { method: "POST" });
  await until(async () => (await state()).requests.length === 2);
  await page.getByText("Isolated desktop QA response 1", { exact: true }).first().waitFor();
  await until(async () => (await guideHint.count()) === 0);
  assert.equal(await queue.count(), 1, "Guide injection does not start the future queue turn");
  assert.equal((await state()).pending, 1, "Guided turn remains active at its next model step");
  checks.push(
    "Actual guided row replaces the local hint while the same native turn remains active",
  );
  await page.screenshot({
    path: join(evidence, "guide-projected-before-queue.png"),
    fullPage: true,
  });

  await fetch(new URL("/qa/release", mockUrl), { method: "POST" });
  await until(async () => (await state()).requests.length >= 3);
  await until(async () => (await queue.count()) === 0);
  await page.getByText("Isolated desktop QA response 3", { exact: true }).first().waitFor();
  assert.equal(await page.getByTestId("v4-codex-guide-notice").count(), 0);
  assert.deepEqual((await state()).interrupted, []);
  assert.deepEqual(errors, []);
  checks.push("Native guide joins the same turn; queued input runs only after that turn ends");
  await page.screenshot({ path: join(evidence, "guide-and-queue-completed.png"), fullPage: true });

  // 必须在真实 Appearance UI 选 Light：emulateMedia(light) 不覆盖用户显式 Dark 设置。
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("button", { name: "Appearance", exact: true }).click();
  await page.getByRole("combobox").first().click();
  await page.getByRole("option", { name: "Light", exact: true }).click();
  await page.getByRole("combobox").first().getByText("Light").waitFor();
  await page.getByRole("button", { name: "Back to workspace" }).first().click();
  await fetch(new URL("/qa/hold", mockUrl), { method: "POST" });
  await composer.fill("QA light theme native turn. No tools.");
  await send.click();
  await until(async () => (await state()).requests.length === 4);
  await choice.click();
  await page.getByRole("menuitemradio", { name: /Guide.*current task/i }).click();
  await composer.fill("QA light theme guidance.");
  await send.click();
  await guideHint.waitFor();
  await page.setViewportSize({ width: 720, height: 844 });
  assert.equal(await choice.isVisible(), true);
  await page.screenshot({ path: join(evidence, "followup-narrow-light.png"), fullPage: true });
  checks.push(
    "Appearance-selected Light theme retains readable Guide hint and mode selector at 720px",
  );
  await fetch(new URL("/qa/release", mockUrl), { method: "POST" });
  await until(async () => (await state()).requests.length >= 5);
  await until(async () => (await guideHint.count()) === 0);
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
