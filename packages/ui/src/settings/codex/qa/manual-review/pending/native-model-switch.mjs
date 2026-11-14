// Real SessionPane → Host → pinned native → two isolated loopback providers.
// Mobile overrides only pane platform inputs; delivery remains desktop-continuous, not relay evidence.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { createServer } from "vite";
import { chromium } from "playwright-core";

const mobile = process.argv.includes("--mobile");
// 保留原 MNCP 的编辑/反馈检查；issue #36 独立验收选模、配置确认与实际继续请求，
// 不把旧编辑用例提前失败当成这些新断言的覆盖。
const modelSwitchOnly = process.argv.includes("--model-switch-only");
const rendererPort = mobile ? 5176 : 5177;
const cdpPort = mobile ? 9232 : 9233;
const evidence = await mkdtemp(join(tmpdir(), "native-model-switch-"));
const server = await createServer({
  configFile: resolve("packages/desktop/vite.config.ts"),
  root: resolve("packages/desktop/src/renderer"),
  cacheDir: resolve(
    `packages/ui/node_modules/.vite-native-model-switch-${mobile ? "mobile" : "desktop"}`,
  ),
  logLevel: "error",
  plugins: mobile
    ? [
        {
          name: "qa-mobile-session-pane-inputs",
          enforce: "pre",
          transform(source, id) {
            if (!id.split("?")[0].endsWith("/v4/SessionPane.tsx")) return;
            assert.ok(source.includes("  isDesktop = false,"));
            assert.ok(source.includes("  compactForRemoteControl = false,"));
            return source
              .replace("  isDesktop = false,", "  isDesktop: qaDesktopInput = false,")
              .replace(
                "  compactForRemoteControl = false,",
                "  compactForRemoteControl: qaCompactInput = false,",
              )
              .replace(
                "}: SessionPaneProps) {",
                "}: SessionPaneProps) {\n  const isDesktop = false;\n  const compactForRemoteControl = true;\n  void qaDesktopInput; void qaCompactInput;",
              );
          },
        },
      ]
    : [],
  server: { host: "127.0.0.1", port: rendererPort, strictPort: true, hmr: false },
});
await server.listen();
const probe = spawn(process.execPath, ["packages/ui/src/settings/codex/qa/desktop-probe.mjs"], {
  env: {
    ...process.env,
    CODEX_UI_QA_RENDERER_PORT: String(rendererPort),
    CODEX_UI_QA_CDP_PORT: String(cdpPort),
    CODEX_UI_QA_MOCK: "1",
    CODEX_UI_QA_MAPPED_PROVIDER: "1",
    CODEX_UI_QA_SPLIT_PROVIDERS: "1",
    CODEX_UI_QA_DISABLE_DEV_SHM: process.platform === "linux" ? "1" : "0",
  },
  stdio: ["ignore", "pipe", "pipe"],
});
let probeOutput = "";
let metadata;
probe.stdout.on("data", (chunk) => {
  probeOutput += chunk;
  for (const line of probeOutput.split("\n")) {
    if (line.startsWith('{"isolated":')) metadata = JSON.parse(line);
  }
});
probe.stderr.on("data", (chunk) => {
  probeOutput += chunk;
});
let browser;
const checks = [];
try {
  for (let attempt = 0; attempt < 120; attempt++) {
    if (metadata) {
      try {
        browser = await chromium.connectOverCDP(`http://127.0.0.1:${cdpPort}`);
        break;
      } catch {}
    }
    if (probe.exitCode !== null) throw new Error(`Probe exited ${probe.exitCode}`);
    await delay(250);
  }
  assert.ok(browser, "Isolated native probe did not become ready");
  let page;
  for (let attempt = 0; attempt < 120; attempt++) {
    page = browser
      .contexts()
      .flatMap((context) => context.pages())
      .find((entry) => {
        try {
          return new URL(entry.url()).port === String(rendererPort);
        } catch {
          return false;
        }
      });
    if (page) break;
    await delay(250);
  }
  assert.ok(page, "Refuse non-QA renderer");
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  const state = async (provider) => (await fetch(new URL("/qa", metadata[provider]))).json();
  const release = async (provider) =>
    fetch(new URL("/qa/release", metadata[provider]), { method: "POST" });
  const waitRequests = async (provider, count) => {
    for (let attempt = 0; attempt < 120; attempt++) {
      if ((await state(provider)).requests.length >= count) return;
      await delay(250);
    }
    throw new Error(`Provider ${provider} did not receive ${count} requests`);
  };
  const models = page.getByTestId("codex-composer-models");
  const model = models.getByTestId("chat-model-select-trigger");
  const input = page.getByTestId("v4-composer-input");
  const send = page.getByTestId("v4-composer-send");
  try {
    await model.waitFor({ timeout: 60_000 });
    await input.fill("E2E_NATIVE_SWITCH A");
    await send.click();
    await page.getByTestId("v4-stop").waitFor();
    assert.equal(await model.isDisabled(), true);
    await waitRequests("mockProvider", 1);
    await page.getByTestId("v4-stop").click();
    await page.waitForFunction(
      () => document.querySelector('[data-testid="chat-model-select-trigger"]')?.disabled === false,
    );
    assert.equal((await state("mockProvider")).requests.length, 1);
    await model.click();
    await page
      .getByRole("menuitem", { name: "Isolated mapped-provider QA", exact: true })
      .last()
      .click();
    await page.getByRole("menuitemradio", { name: "ui-qa-second", exact: true }).click();
    // issue #36：仅选模型也必须发原生配置命令。旧实现读 native 模式下被禁用的
    // legacy View，菜单有目标却在发命令前失败；不能用后续 send 的隐式配置掩盖它。
    await page.waitForFunction(
      () =>
        document
          .querySelector('[data-testid="chat-model-select-trigger"]')
          ?.textContent?.includes("ui-qa-second"),
      null,
      { timeout: 10_000 },
    );
    const modelAcks = await page.evaluate(() =>
      (window.__codezV4CommandAcksE2E ?? []).filter((ack) => ack.type === "switchModelConfig"),
    );
    assert.ok(
      modelAcks.some((ack) => ["accepted", "noop", "duplicate"].includes(ack.status)),
      `Model-only switch must receive a successful config ACK: ${JSON.stringify(modelAcks)}`,
    );
    assert.doesNotMatch(
      await page.locator("body").innerText(),
      /切换连接失败|Could not switch connection/,
    );
    checks.push("Model-only cross-provider selection confirmed through native config ACK");
    if (modelSwitchOnly) {
      const continueEntry = page.locator(
        '[data-testid^="v4-retry-"]:not([data-testid="v4-retry-subscribe"])',
      );
      await continueEntry.first().click();
    } else {
      await input.fill("E2E_NATIVE_SWITCH 继续");
      await send.click();
    }
    await page.getByTestId("v4-stop").waitFor();
    await waitRequests("secondMockProvider", 1);
    await release("secondMockProvider");
    await page.getByText("Isolated desktop QA response 1", { exact: true }).first().waitFor();
    const firstB = (await state("secondMockProvider")).requests;
    assert.equal(firstB.length, 1);
    assert.equal(firstB[0].model, "ui-qa-second");
    assert.equal(firstB[0].reasoningEffort, "medium");
    checks.push(
      `Stopped A; selected cross-provider B; ${modelSwitchOnly ? "Continue entry" : "ordinary continue"} requested only B/medium`,
    );
    // 配置确认不能在草稿解析时又被默认档位覆盖；实际编辑重发须保留新的显式档位。
    await models.getByTestId("chat-thought-level-select-trigger").click();
    await page.getByTestId("chat-thought-level-select-item-high").click();
    await page.waitForFunction(
      () =>
        (window.__codezV4CommandAcksE2E ?? []).filter(
          (ack) =>
            ack.type === "switchModelConfig" &&
            ["accepted", "noop", "duplicate"].includes(ack.status),
        ).length >= 2,
      null,
      { timeout: 10_000 },
    );
    if (modelSwitchOnly) {
      await input.fill("E2E_NATIVE_SWITCH acknowledged effort");
      await send.click();
    } else {
      const edit = page
        .locator('[data-testid^="v4-edit-"]')
        .filter({ has: page.locator("svg") })
        .last();
      await edit.click();
      assert.equal(await page.locator('[data-testid^="v4-edit-rewind-workspace-"]').count(), 0);
      const editInput = page.locator('[data-testid^="v4-edit-input-"]').last();
      await editInput.fill("E2E_NATIVE_SWITCH 编辑继续");
      await page.locator('[data-testid^="v4-edit-submit-"]').last().click();
    }
    await page.getByText("Isolated desktop QA response 2", { exact: true }).first().waitFor();
    assert.equal((await state("mockProvider")).requests.length, 1);
    const allB = (await state("secondMockProvider")).requests;
    assert.equal(allB.length, 2);
    assert.ok(allB.every((request) => request.model === "ui-qa-second"));
    assert.deepEqual(
      allB.map((request) => request.reasoningEffort),
      ["medium", "high"],
    );
    checks.push(
      `${modelSwitchOnly ? "Next send" : "Real editUserQuery rerun"} retained acknowledged B/high, never requested A`,
    );
    if (!modelSwitchOnly) {
      assert.equal(await page.locator('[data-testid^="v4-feedback-like-"]').count(), 0);
      assert.equal(await page.locator('[data-testid^="v4-feedback-dislike-"]').count(), 0);
      checks.push("Native rows preserve files on edit and hide unsupported message feedback");
    }
    assert.deepEqual(errors, []);
    await page.screenshot({ path: join(evidence, "completed.png"), fullPage: true });
    await writeFile(
      join(evidence, "result.json"),
      JSON.stringify(
        {
          mobile,
          modelSwitchOnly,
          checks,
          providers: { a: await state("mockProvider"), b: await state("secondMockProvider") },
          errors,
        },
        null,
        2,
      ),
    );
    console.log(JSON.stringify({ status: "passed", evidence, mobile, modelSwitchOnly, checks }));
  } catch (error) {
    await page.screenshot({ path: join(evidence, "failure.png"), fullPage: true }).catch(() => {});
    await writeFile(
      join(evidence, "failure.json"),
      JSON.stringify(
        {
          errors,
          acks: await page.evaluate(() => window.__codezV4CommandAcksE2E ?? []),
          url: page.url(),
          body: await page
            .locator("body")
            .innerText()
            .catch(() => "unavailable"),
          html: await page.content().catch(() => "unavailable"),
        },
        null,
        2,
      ),
    );
    throw error;
  }
} finally {
  await writeFile(join(evidence, "probe.log"), probeOutput);
  console.log(`Evidence: ${evidence}`);
  await browser?.close();
  probe.kill("SIGTERM");
  await server.close();
}
