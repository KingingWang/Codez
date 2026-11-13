// 中断轮「继续」恢复入口的实际桌面验证：真实 Electron → Host → pinned native → loopback mock。
// 只使用隔离 QA profile，不触碰真实账号或模型；需要 fresh probe（CODEX_UI_QA_MOCK=1）。
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { chromium } from "playwright-core";

const mockUrl = new URL(process.env.CODEX_UI_QA_MOCK_URL ?? "http://invalid/");
assert.equal(mockUrl.hostname, "127.0.0.1", "Only the isolated loopback mock is permitted");
const packaged = process.env.CODEX_UI_QA_PACKAGED === "1";
const rendererPort = Number(process.env.CODEX_UI_QA_RENDERER_PORT ?? 5174);
const cdpPort = Number(process.env.CODEX_UI_QA_CDP_PORT ?? (packaged ? 9230 : 9229));
for (const port of [rendererPort, cdpPort]) {
  assert.ok(Number.isInteger(port) && port > 1023 && port <= 65535, "Invalid isolated QA port");
}
const state = async () => (await fetch(new URL("/qa", mockUrl))).json();
const evidence = await mkdtemp(join(tmpdir(), "codex-ui-interrupted-turn-"));
const checks = [];
const errors = [];

const browser = await chromium.connectOverCDP(`http://127.0.0.1:${cdpPort}`);
const page = browser
  .contexts()
  .flatMap((context) => context.pages())
  .find((entry) => {
    if (!packaged) {
      const url = new URL(entry.url());
      return (
        url.protocol === "http:" &&
        ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) &&
        Number(url.port) === rendererPort
      );
    }
    return entry.url().includes("resources/app.asar/out/renderer/index.html");
  });
assert.ok(page, "Refuse a non-QA renderer");
page.on("pageerror", (error) => errors.push(error.message));

async function until(predicate, label) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await sleep(100);
  }
  throw new Error(`Timed out waiting for: ${label}`);
}

// 「继续」入口 = v4-retry-<rowId>；排除订阅错误面板的 v4-retry-subscribe。
const continueEntry = page.locator(
  '[data-testid^="v4-retry-"]:not([data-testid="v4-retry-subscribe"])',
);

try {
  const initial = await state();
  assert.equal(initial.hold, true, "mock provider must hold responses");
  assert.equal(initial.requests.length, 0, "Use a fresh isolated mock probe");
  const composer = page.getByTestId("v4-composer-input");
  await composer.fill("QA interrupted turn: stop then continue with the same prompt.");
  const send = page.getByRole("button", { name: "Send", exact: true });
  await until(() => send.isEnabled(), "send enabled");
  await send.click();
  await until(async () => (await state()).requests.length === 1, "first native request");
  const stop = page.getByTestId("v4-stop");
  await until(() => stop.isVisible(), "stop control visible while running");
  assert.equal(await continueEntry.count(), 0, "running turn must not offer continue");
  await page.screenshot({ path: join(evidence, "turn-running.png") });

  await stop.click();
  await until(async () => (await state()).interrupted.length === 1, "native turn interrupted");
  await until(async () => (await continueEntry.count()) === 1, "continue entry after manual stop");
  const continueTestId = await continueEntry.first().getAttribute("data-testid");
  assert.match(continueTestId ?? "", /^v4-retry-\d+$/);
  assert.ok(
    await continueEntry.first().isVisible(),
    "continue entry must be visible without hover",
  );
  await page.screenshot({ path: join(evidence, "interrupted-continue.png"), fullPage: true });
  checks.push(
    `Manual stop renders an always-visible continue entry at the interrupted turn end (${continueTestId})`,
  );

  // issue #36 验收 3：手动停止后必须仍能改选择，且「继续」用点击时冻结的当前选择。
  // 只读 v4-model-config 的 data-thought / data-thought-levels 这一份受控投影锚点，
  // 不另建草稿状态；档位取自夹具事实，避免把 medium/high 写死。
  const modelConfig = page.getByTestId("v4-model-config");
  const thoughtBefore = await modelConfig.getAttribute("data-thought");
  const thoughtLevels = (await modelConfig.getAttribute("data-thought-levels")) ?? "";
  const thoughtTarget = thoughtLevels
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .find((level) => level !== thoughtBefore);
  assert.ok(
    thoughtTarget,
    `QA fixture must expose a second thought level (got "${thoughtLevels}")`,
  );
  const thoughtTrigger = page.getByTestId("chat-thought-level-select-trigger");
  await until(() => thoughtTrigger.isEnabled(), "thought control re-enabled after manual stop");
  await thoughtTrigger.click();
  await page.getByTestId(`chat-thought-level-select-item-${thoughtTarget}`).click();
  await until(
    async () => (await modelConfig.getAttribute("data-thought")) === thoughtTarget,
    `thought switch projected to ${thoughtTarget}`,
  );
  // 切换失败只以 toast 文案呈现（chat.toolbar.connection.switchFailed）。issue #36 报告
  // 停止后切换失败，这里同时钉住中英文案，避免只恢复「继续」按钮而漏掉第二个症状。
  const bodyAfterSwitch = await page.locator("body").innerText();
  assert.doesNotMatch(bodyAfterSwitch, /切换连接失败|Could not switch connection/);
  await page.screenshot({
    path: join(evidence, "interrupted-switched-thought.png"),
    fullPage: true,
  });
  checks.push(
    `After manual stop the thought level switches ${thoughtBefore} -> ${thoughtTarget} without a switch-failed toast`,
  );

  await continueEntry.first().click();
  await until(
    async () => (await state()).requests.length === 2,
    "continuation dispatches a new native request",
  );
  // mock provider 按请求记录 reasoningEffort；续跑必须带上停止后新选的档位。
  assert.equal(
    (await state()).requests.at(-1)?.reasoningEffort,
    thoughtTarget,
    "continuation must use the selection made after the manual stop",
  );
  checks.push(`Continuation request carried the post-stop selection (${thoughtTarget})`);
  await until(
    async () => (await continueEntry.count()) === 0,
    "continue entry disappears once the new turn runs",
  );
  await page.screenshot({ path: join(evidence, "continue-running.png"), fullPage: true });
  checks.push(
    "Continue starts a new turn in the same thread without reverting the interrupted turn",
  );

  await fetch(new URL("/qa/release", mockUrl), { method: "POST" });
  await page.getByText("Isolated desktop QA response 2", { exact: true }).first().waitFor();
  await until(async () => !(await stop.isVisible()), "stop control hidden after completion");
  await until(async () => (await continueEntry.count()) === 0, "completed turn offers no continue");
  await page.screenshot({ path: join(evidence, "continue-completed.png"), fullPage: true });
  const final = await state();
  assert.deepEqual(final.interrupted, [1]);
  assert.deepEqual(final.completed, [2]);
  assert.equal(final.requests.length, 2);
  checks.push("Provider observed exactly one interrupted and one completed turn");

  const bodyText = await page.locator("body").innerText();
  assert.match(bodyText, /QA interrupted turn: stop then continue with the same prompt/);
  assert.doesNotMatch(bodyText, /Continue the interrupted task|请继续刚才中断的任务/);
  assert.match(bodyText, /Isolated desktop QA response 2/);
  checks.push(
    "Original task and continuation response remain visible without injecting a synthetic continue prompt",
  );

  assert.deepEqual(errors, []);
  await writeFile(
    join(evidence, "results.json"),
    JSON.stringify({ checks, state: final, errors, renderer: page.url() }, null, 2),
  );
  console.log(JSON.stringify({ status: "passed", evidence, checks }, null, 2));
} catch (error) {
  await page.screenshot({ path: join(evidence, "failure.png"), fullPage: true }).catch(() => {});
  await writeFile(join(evidence, "failure.json"), JSON.stringify({ checks, errors }, null, 2));
  console.error(JSON.stringify({ evidence, checks, errors, message: error.message }, null, 2));
  throw error;
} finally {
  await fetch(new URL("/qa/release", mockUrl), { method: "POST" }).catch(() => {});
  await browser.close();
}
