// CBAS01/02 候选：真实 Electron → Host → pinned Codex；只用隔离 profile 和 loopback provider。
// 先构建 bridge/main/host/renderer，启动 desktop-probe.mjs（CODEX_UI_QA_MOCK=1）。
// CODEX_UI_QA_ROOT=<probe isolated> CODEX_UI_QA_MOCK_URL=<probe mockProvider>
// CODEX_UI_QA_RENDERER_PORT=<probe port> CODEX_UI_QA_CDP_PORT=<probe port>
// pnpm exec tsx packages/desktop/test/e2e/conversation-session/manual-review/pending/codex-browser-send.mjs
// 不属于 WDIO 正式 fixture/replay，不自动晋升或进入 CI。
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { setTimeout } from "node:timers/promises";
import { chromium } from "playwright-core";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { nativeBrowserCuaMcpEndpointPath, TID_BROWSER_ADDRESS_INPUT } from "@codez/shared";

const isolated = resolve(process.env.CODEX_UI_QA_ROOT ?? ".");
assert.equal(dirname(isolated), tmpdir(), "Use only a desktop-probe temporary profile");
assert.match(basename(isolated), /^codex-ui-qa-/);
const mockUrl = new URL(process.env.CODEX_UI_QA_MOCK_URL ?? "http://invalid/");
assert.equal(mockUrl.protocol, "http:");
assert.equal(mockUrl.hostname, "127.0.0.1");
const config = await readFile(join(isolated, "codex/config.toml"), "utf8");
assert.ok(config.includes(`base_url = "${mockUrl.origin}/v1"`));
assert.ok(config.includes("requires_openai_auth = false"));
const rendererPort = Number(process.env.CODEX_UI_QA_RENDERER_PORT);
const cdpPort = Number(process.env.CODEX_UI_QA_CDP_PORT);
for (const port of [rendererPort, cdpPort])
  assert.ok(Number.isInteger(port) && port > 1023 && port <= 65535);
const artifactRoot = resolve("packages/desktop/.e2e-artifacts");
await mkdir(artifactRoot, { recursive: true });
const evidence = await mkdtemp(join(artifactRoot, "codex-browser-send-"));
const state = async () => (await fetch(new URL("/qa", mockUrl))).json();
const initial = await state();
assert.equal(initial.hold, true);
assert.equal(initial.requests.length, 0, "Use a fresh isolated mock probe");
const browser = await chromium.connectOverCDP(`http://127.0.0.1:${cdpPort}`);
const page = browser
  .contexts()
  .flatMap((context) => context.pages())
  .find((entry) => {
    const url = new URL(entry.url());
    return (
      url.protocol === "http:" &&
      ["localhost", "127.0.0.1"].includes(url.hostname) &&
      Number(url.port) === rendererPort
    );
  });
assert.ok(page, "Refuse any other desktop renderer");
page.setDefaultTimeout(30_000);
const errors = [];
const checks = [];
const sends = [];
page.on("pageerror", (error) => errors.push(error.message));
async function until(label, predicate) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await setTimeout(100);
  }
  throw new Error(`Timed out: ${label}`);
}
const acks = () => page.evaluate(() => window.__codezV4CommandAcksE2E ?? []);
const composer = page.getByTestId("v4-composer-input");
const sendButton = page.getByTestId("v4-composer-send");
const model = page.getByTestId("chat-model-select-trigger");
const queueItems = page.locator(
  '[data-testid^="v4-queue-item-"]:not([data-testid*="send-now"]):not([data-testid*="edit"]):not([data-testid*="delete"])',
);
async function send(marker) {
  const before = (await acks()).length;
  await composer.fill(`${marker} No tools.`);
  await until("send ready", () => sendButton.isEnabled());
  await sendButton.click();
  await until(`${marker} send ACK`, async () =>
    (await acks()).slice(before).some((ack) => ack.type === "sendText"),
  );
  const ack = (await acks()).slice(before).find((ack) => ack.type === "sendText");
  assert.equal(ack.status, "accepted", `${marker}: ${JSON.stringify(ack)}`);
  sends.push({ marker, ack });
}
async function response(index) {
  await page.getByText(`Isolated desktop QA response ${index}`, { exact: true }).first().waitFor();
  await until(`native idle after ${index}`, () => model.isEnabled());
}
async function verifyBrowserMcp() {
  // 只读当前隔离窗口的 token 路径，不读出或记录凭据；不接入任何真实用户 broker。
  const tokenNames = (await readdir(join(isolated, "userData"))).filter((name) =>
    /^codez-native-browser-cua-[a-z0-9-]+-\d+\.token$/.test(name),
  );
  assert.equal(tokenNames.length, 1, "QA window must own its native broker capability");
  const tokenName = tokenNames[0];
  const flavor = tokenName.match(/^codez-native-browser-cua-(.+)-\d+\.token$/)[1];
  const client = new Client({ name: "E2E_CBAS_BROWSER", version: "1" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [resolve("packages/codex-bridge/dist/bridge.cjs"), "native-browser-cua-mcp"],
    env: {
      PATH: process.env.PATH,
      CODEZ_NATIVE_BROWSER_CUA_ENDPOINT: nativeBrowserCuaMcpEndpointPath({
        platform: process.platform,
        flavor,
        temporaryDirectory: join(isolated, "tmp"),
      }),
      CODEZ_NATIVE_BROWSER_CUA_TOKEN_FILE: join(isolated, "userData", tokenName),
    },
    stderr: "pipe",
  });
  try {
    await client.connect(transport);
    assert.ok((await client.listTools()).tools.some((tool) => tool.name === "browser_command"));
    const navigation = await client.callTool({
      name: "browser_command",
      arguments: { method: "navigate", url: "about:blank" },
    });
    assert.notEqual(navigation.isError, true);
    assert.equal(navigation.structuredContent?.ok, true);
    const result = await client.callTool({
      name: "browser_command",
      arguments: { method: "getState" },
    });
    assert.notEqual(result.isError, true);
    assert.equal(result.structuredContent?.ok, true);
    checks.push("CBAS02: built stdio MCP → live Main broker → browser guest navigate/getState");
  } finally {
    await client.close();
  }
}
try {
  await page.getByRole("button", { name: "New task", exact: true }).waitFor();
  await page.keyboard.press("Escape");
  const back = page.getByRole("button", { name: "Back to workspace", exact: true });
  if (await back.count()) await back.first().click();
  if (!(await composer.count()))
    await page.getByRole("button", { name: "New task", exact: true }).click();
  await composer.waitFor();
  assert.match(await model.innerText(), /ui-qa-offline/);

  // 真实产品入口打开 user tab；不伪造 browser executor、accepted queue 或 session 状态。
  if (!(await page.locator('[data-side-pane-open-tab-item="browser"]').count())) {
    await page.getByTestId("side-pane-toggle").click();
  }
  const openBrowser = page.locator('[data-side-pane-open-tab-item="browser"]');
  if (await openBrowser.count()) {
    await openBrowser.click();
  } else {
    await page.locator("[data-side-pane-add-trigger]").click();
    await page.locator('[data-side-pane-add-item="browser"]').click();
  }
  const address = page.getByTestId(TID_BROWSER_ADDRESS_INPUT);
  await address.waitFor();
  await address.fill(new URL("/qa", mockUrl).href);
  await address.press("Enter");
  await until("live user browser guest", () =>
    page
      .locator("webview")
      .first()
      .evaluate((guest, url) => guest.getURL() === url, new URL("/qa", mockUrl).href),
  );
  await page.screenshot({ path: join(evidence, "browser-open.png"), fullPage: true });

  await send("E2E_CBAS_FIRST");
  await until("first provider request", async () => (await state()).requests.length === 1);
  await fetch(new URL("/qa/release", mockUrl), { method: "POST" });
  await response(1);
  await send("E2E_CBAS_IDLE_FOLLOWUP");
  await response(2);
  checks.push("CBAS01: first input and idle follow-up accepted with live user tab");
  await page.screenshot({ path: join(evidence, "idle-followup.png"), fullPage: true });

  await fetch(new URL("/qa/hold", mockUrl), { method: "POST" });
  await send("E2E_CBAS_HELD");
  await until("native running", () => model.isDisabled());
  await send("E2E_CBAS_BUSY_QUEUE");
  await until("native queue item", async () => (await queueItems.count()) === 1);
  assert.equal(
    (await state()).requests.length,
    3,
    "busy accepted input is queued, not resubmitted",
  );
  await page.screenshot({ path: join(evidence, "busy-queue.png"), fullPage: true });
  await fetch(new URL("/qa/release", mockUrl), { method: "POST" });
  await response(4);
  await until("native queue drained", async () => (await queueItems.count()) === 0);
  checks.push("CBAS01: busy input accepted, queues once and drains through pinned native");

  const oldSession = await page
    .locator("[data-session-id]")
    .first()
    .getAttribute("data-session-id");
  await page.getByRole("button", { name: "New task", exact: true }).click();
  await until(
    "new task draft",
    async () =>
      (await page.locator("[data-session-id]").first().getAttribute("data-session-id")) === "draft",
  );
  await send("E2E_CBAS_NEW_FIRST");
  await response(5);
  const newSession = await page
    .locator("[data-session-id]")
    .first()
    .getAttribute("data-session-id");
  assert.notEqual(newSession, oldSession);
  assert.notEqual(newSession, "draft");
  await send("E2E_CBAS_NEW_FOLLOWUP");
  await response(6);
  // 新任务可收起 side pane，但 user guest 仍存活；不能把 tab-strip 的缺席误判为关闭页面。
  assert.equal(
    await page
      .locator("webview")
      .first()
      .evaluate((guest) => guest.getURL()),
    new URL("/qa", mockUrl).href,
  );
  checks.push(
    "CBAS01: a different task accepts first input and follow-up while browser stays open",
  );
  await verifyBrowserMcp();
  await page.screenshot({ path: join(evidence, "new-task-followup-mcp.png"), fullPage: true });
  const finalState = await state();
  assert.deepEqual(finalState.completed, [1, 2, 3, 4, 5, 6]);
  assert.deepEqual(finalState.interrupted, []);
  assert.equal(finalState.requests.length, 6, "no duplicate turns/retry commands");
  assert.deepEqual(errors, []);
  await writeFile(
    join(evidence, "results.json"),
    JSON.stringify(
      {
        status: "passed",
        checks,
        sends,
        acks: await acks(),
        state: finalState,
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
      {
        error: String(error),
        checks,
        sends,
        acks: await acks(),
        state: await state(),
        errors,
        text: await page.locator("body").innerText(),
      },
      null,
      2,
    ),
  );
  console.error({ evidence, error: String(error) });
  throw error;
} finally {
  await fetch(new URL("/qa/release", mockUrl), { method: "POST" }).catch(() => {});
  await browser.close();
}
