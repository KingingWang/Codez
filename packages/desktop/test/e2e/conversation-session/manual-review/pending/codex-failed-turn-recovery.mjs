// CODEX-FAIL-01/02. Pending synthetic fault-stream; no live provider or user credentials.
// Launch isolated QA first: CODEX_UI_QA_MOCK=1 CODEX_UI_QA_MAPPED_PROVIDER=1 node
// packages/ui/src/settings/codex/qa/desktop-probe.mjs; pass its mock URL via CODEX_UI_QA_MOCK_URL.
// This native Codex/CDP case is not a promoted WDIO/CI fixture.
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright-core";

const mockUrl = new URL(process.env.CODEX_UI_QA_MOCK_URL ?? "http://invalid/");
assert.equal(mockUrl.hostname, "127.0.0.1", "Only the isolated loopback mock is permitted");
const state = async () => (await fetch(new URL("/qa", mockUrl))).json();
assert.equal((await state()).requests.length, 0, "Use a fresh isolated desktop probe");
const rendererPort = Number(process.env.CODEX_UI_QA_RENDERER_PORT ?? 5174);
const cdpPort = Number(process.env.CODEX_UI_QA_CDP_PORT ?? 9229);
const evidence = await mkdtemp(join(tmpdir(), "codex-failed-turn-recovery-"));
const browser = await chromium.connectOverCDP(`http://127.0.0.1:${cdpPort}`);
const page = browser
  .contexts()
  .flatMap((context) => context.pages())
  .find((entry) => {
    const url = new URL(entry.url());
    return ["localhost", "127.0.0.1"].includes(url.hostname) && url.port === String(rendererPort);
  });
assert.ok(page, "Refuse a non-QA renderer");
const checks = [];
const errors = [];
page.on("pageerror", (error) => errors.push(error.message));
page.setDefaultTimeout(60_000);
const composer = page.getByTestId("v4-composer-input");
const send = page.getByTestId("v4-composer-send");
const errorBanner = page.getByText(
  /stream disconnected before completion.*E2E_CODEX_STREAM_FAILURE/,
);
const currentSession = () =>
  composer.evaluate((node) => node.closest("[data-session-id]")?.getAttribute("data-session-id"));

async function failTurn(marker) {
  await fetch(new URL("/qa/fail-stream", mockUrl), { method: "POST" });
  await composer.fill(marker);
  await send.click();
  await errorBanner.first().waitFor();
  assert.equal(await composer.getAttribute("contenteditable"), "true");
  assert.equal(await page.getByTestId("v4-stop").count(), 0);
  await fetch(new URL("/qa/recover-stream", mockUrl), { method: "POST" });
}

async function sendFollowup(marker, viaEnter) {
  const before = (await state()).requests.length;
  await composer.fill(marker);
  assert.equal(await send.isEnabled(), true);
  if (viaEnter) {
    await composer.press("Shift+Enter");
    assert.equal((await state()).requests.length, before, "Shift+Enter must not submit");
    await composer.press("Enter");
  } else {
    await send.click();
  }
  await page.getByTestId("v4-stop").waitFor();
  assert.equal((await state()).requests.length, before + 1, "exactly one explicit follow-up");
  await fetch(new URL("/qa/release", mockUrl), { method: "POST" });
  await page
    .getByText(`Isolated desktop QA response ${before + 1}`, { exact: true })
    .first()
    .waitFor();
  await page.getByTestId("v4-stop").waitFor({ state: "detached" });
  assert.equal(await errorBanner.count(), 0, "new successful turn clears the error");
}

try {
  await page.getByRole("combobox", { name: "Default model", exact: true }).waitFor();
  await failTurn("E2E_CODEX_FAIL_LIVE No tools.");
  const sessionId = await currentSession();
  assert.ok(sessionId && sessionId !== "draft");
  checks.push("Terminal Responses failure remains visible while the live composer is editable");
  await page.screenshot({
    path: join(evidence, "failure-editable.png"),
    fullPage: true,
  });
  await sendFollowup("E2E_CODEX_FOLLOWUP_BUTTON No tools.", false);
  assert.equal(await currentSession(), sessionId);
  checks.push("Button starts one explicit turn in the same thread without dismissing the error");

  await fetch(new URL("/qa/hold", mockUrl), { method: "POST" });
  await failTurn("E2E_CODEX_FAIL_RELOAD No tools.");
  const failedRequests = (await state()).requests.length;
  await page.reload();
  await errorBanner.first().waitFor();
  assert.equal(await composer.getAttribute("contenteditable"), "true");
  assert.equal(await currentSession(), sessionId);
  assert.equal((await state()).requests.length, failedRequests, "reload cannot auto-retry");
  checks.push(
    "Renderer reload restores failed history/error without locking input or replaying requests",
  );
  await sendFollowup("E2E_CODEX_FOLLOWUP_ENTER No tools.", true);
  assert.equal(await currentSession(), sessionId);
  checks.push("Enter sends after reload; Shift+Enter remains newline");
  assert.deepEqual(errors, []);
  await page.screenshot({
    path: join(evidence, "recovered.png"),
    fullPage: true,
  });
  await writeFile(
    join(evidence, "results.json"),
    JSON.stringify({ checks, errors, sessionId, state: await state() }, null, 2),
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
  await fetch(new URL("/qa/recover-stream", mockUrl), { method: "POST" }).catch(() => {});
  await fetch(new URL("/qa/release", mockUrl), { method: "POST" }).catch(() => {});
  await browser.close();
}
