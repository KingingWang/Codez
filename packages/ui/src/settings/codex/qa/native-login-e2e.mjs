// 真实浏览器验收；合成账号/内存凭据，禁止访问非 loopback 网络。
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { createServer } from "vite";
import { chromium } from "playwright-core";
import { verifyRootProviderStartup } from "./settings-regressions-e2e.mjs";

const evidence = await mkdtemp(join(tmpdir(), "codez-native-login-e2e-"));
const checks = [];
const baseline = process.argv.includes("--baseline");
const oauthSourcePath = "packages/ui/src/root/useRootOAuthEffects.ts";
const baselineSource = baseline
  ? (await promisify(execFile)("git", ["show", `HEAD:${oauthSourcePath}`])).stdout
  : undefined;
const server = await createServer({
  configFile: resolve("packages/desktop/vite.config.ts"),
  root: resolve("packages/ui/src/settings/codex/qa"),
  cacheDir: join(evidence, "vite-cache"),
  server: { host: "127.0.0.1", port: 5189, strictPort: true },
  // 只在内存里替换修复前源码，用同一浏览器用例证明回归；不修改工作树或真实账号。
  plugins: baseline
    ? [
        {
          name: "codez-qa-baseline-oauth",
          enforce: "pre",
          load(id) {
            return id.split("?")[0] === resolve(oauthSourcePath) ? baselineSource : null;
          },
        },
      ]
    : [],
});
let browser;
let page;
const errors = [];
try {
  await server.listen();
  browser = await chromium.launch({
    executablePath: "/opt/google/chrome/chrome",
    headless: true,
    args: ["--no-sandbox"],
    env: {
      PATH: process.env.PATH,
      HOME: evidence,
      XDG_CONFIG_HOME: evidence,
      XDG_CACHE_HOME: evidence,
    },
  });
  page = await browser.newPage({ viewport: { width: 1200, height: 900 } });
  // 首次编译整棵共享 UI 图可能较慢；登录状态断言仍使用默认 30 秒预算。
  page.setDefaultNavigationTimeout(180_000);
  page.on("pageerror", (error) => errors.push(error.message));
  await page.route("**/*", (route) =>
    new URL(route.request().url()).hostname === "127.0.0.1" ? route.continue() : route.abort(),
  );
  const button = (name) => page.getByRole("button", { name, exact: true });
  const inspect = async () => {
    await button("Inspect native login").click();
    return JSON.parse(await page.getByTestId("qa-native-login-inspection").innerText());
  };
  const openFresh = async () => {
    await page.goto("http://127.0.0.1:5189/?native-login=1", { waitUntil: "domcontentloaded" });
    await button("Remote sign in").waitFor();
    assert.equal((await inspect()).userId, null);
  };
  // 上游 3.18 的统一登录页只保留一个登录按钮，provider 由区域决定
  // （domestic=zai_cn / global=zai），BigModel 不再是欢迎页登录入口。
  // 因此“选 provider”等于“切到对应区域再点唯一入口”。
  const REGION_BY_PROVIDER = { zai_cn: "domestic", zai: "global" };
  const regionSwitch = () => page.getByTestId("login-region-switch");
  const pickRegion = async (provider) => {
    const wanted = REGION_BY_PROVIDER[provider];
    for (let attempt = 0; attempt < 3; attempt += 1) {
      if ((await regionSwitch().getAttribute("data-login-region")) === wanted) return;
      await regionSwitch().click();
    }
    throw new Error(`无法把登录区域切到 ${wanted}`);
  };
  const clickLogin = async () => {
    await page.getByTestId("oauth-login-button").click();
  };
  const start = async (provider) => {
    await button("Remote sign in").click();
    await pickRegion(provider);
    await clickLogin();
    await page.getByTestId("oauth-copy-login-link").waitFor();
    assert.equal((await inspect()).opened, 1);
  };
  const waitSuccess = async (seq) => {
    await page.waitForFunction((expected) => {
      const text = document.querySelector('[data-testid="qa-native-login-state"]')?.textContent;
      if (!text) return false;
      const state = JSON.parse(text);
      return (
        state.successSeq === expected &&
        state.userId === "isolated-new-user" &&
        !state.pollingActive &&
        !state.loginOpen
      );
    }, seq);
  };
  const assertNoLegacy = (state) => {
    assert.equal(state.legacyReads, 0);
    assert.equal(state.legacyWrites, 0);
  };
  for (const provider of ["zai_cn", "zai"]) {
    await openFresh();
    await start(provider);
    await page.screenshot({ path: join(evidence, `${provider}-waiting.png`) });
    await button("Complete browser authorization").click();
    await waitSuccess(1);
    const state = await inspect();
    assert.equal(state.starts, 1);
    assert.ok(state.polls > 0);
    assert.equal(state.callbacks, 0);
    assert.equal(state.credentialWrites, 1);
    assert.equal(state.lastProvider, provider);
    assert.equal(state.authEvents.filter((event) => event === "signed-in").length, 1);
    assertNoLegacy(state);
    await page.screenshot({ path: join(evidence, `${provider}-polling-success.png`) });
    checks.push(
      `${provider}: new Codex user completes polling without browser callback or legacy Provider initialization`,
    );
  }
  await openFresh();
  await start("zai_cn");
  await button("Deliver current auth link").click();
  await waitSuccess(1);
  await button("Deliver current auth link").click();
  const callbackState = await inspect();
  assert.equal(callbackState.successSeq, 1);
  assert.equal(callbackState.credentialWrites, 1);
  assert.equal(callbackState.handled, 2);
  assertNoLegacy(callbackState);
  checks.push("Current native deep link completes login; duplicate only acknowledges");
  await button("Reauthenticate BigModel").click();
  await page.waitForFunction(
    () =>
      JSON.parse(document.querySelector('[data-testid="qa-native-login-state"]').textContent)
        .pollingActive,
  );
  await button("Complete browser authorization").click();
  await waitSuccess(2);
  const reauthenticated = await inspect();
  assert.equal(reauthenticated.attemptStatus, "succeeded");
  assert.equal(reauthenticated.authEvents.filter((event) => event === "signed-in").length, 2);
  assertNoLegacy(reauthenticated);
  checks.push(
    "Same-user provider-specific reauthentication closes the waiting page and publishes one success",
  );
  await openFresh();
  await button("Hold next auth poll").click();
  await start("zai");
  await page.waitForFunction(
    () =>
      JSON.parse(document.querySelector('[data-testid="qa-native-login-state"]').textContent)
        .pollingActive,
  );
  await page.waitForFunction(
    () =>
      JSON.parse(document.querySelector('[data-testid="qa-native-login-state"]').textContent)
        .polls > 0,
  );
  await page.getByTestId("oauth-cancel").click();
  await button("Release auth poll").click();
  const cancelled = await inspect();
  assert.equal(cancelled.userId, null);
  assert.equal(cancelled.successSeq, 0);
  assert.equal(cancelled.credentialWrites, 0);
  await clickLogin();
  await button("Complete browser authorization").click();
  await waitSuccess(1);
  assertNoLegacy(await inspect());
  checks.push("Cancel rejects a late held poll; a later attempt remains usable");
  await openFresh();
  await button("Fail next auth poll").click();
  await start("zai_cn");
  await page.waitForFunction(() => {
    const state = JSON.parse(
      document.querySelector('[data-testid="qa-native-login-state"]').textContent,
    );
    return !state.pollingActive && Boolean(state.oauthError);
  });
  const failed = await inspect();
  assert.equal(failed.userId, null);
  assert.equal(failed.successSeq, 0);
  assert.equal(failed.credentialWrites, 0);
  assertNoLegacy(failed);
  await page.getByTestId("oauth-cancel").click();
  await pickRegion("zai");
  await clickLogin();
  await button("Complete browser authorization").click();
  await waitSuccess(1);
  checks.push("Polling failure reports a retryable error; cancellation and a new login recover");
  await openFresh();
  await button("Hold next auth poll").click();
  await start("zai");
  await page.waitForFunction(
    () =>
      JSON.parse(document.querySelector('[data-testid="qa-native-login-state"]').textContent)
        .polls > 0,
  );
  await button("Switch to legacy mode").click();
  await button("Release auth poll").click();
  const replaced = await inspect();
  assert.equal(replaced.userId, null);
  assert.equal(replaced.successSeq, 0);
  assert.equal(replaced.pollingActive, false);
  checks.push(
    "A held native poll cannot publish Root user/success or resume polling after a legacy mode switch",
  );
  await page.goto("http://127.0.0.1:5189/", { waitUntil: "domcontentloaded" });
  await verifyRootProviderStartup(page, checks);
  assert.deepEqual(errors, []);
  await writeFile(
    join(evidence, "result.json"),
    JSON.stringify({ passed: true, baseline, checks, errors }, null, 2),
  );
  console.log(JSON.stringify({ evidence, checks }, null, 2));
} catch (error) {
  await page?.screenshot({ path: join(evidence, "failure.png") }).catch(() => {});
  const state = await page
    ?.getByTestId("qa-native-login-state")
    .textContent()
    .catch(() => null);
  const inspectButton = page?.getByRole("button", { name: "Inspect native login", exact: true });
  if (await inspectButton?.isVisible()) await inspectButton.click();
  const inspection = await page
    ?.getByTestId("qa-native-login-inspection")
    .textContent()
    .catch(() => null);
  await writeFile(
    join(evidence, "result.json"),
    JSON.stringify(
      {
        passed: false,
        baseline,
        checks,
        errors,
        state,
        inspection,
        error: String(error),
      },
      null,
      2,
    ),
  );
  console.error(`Native login evidence: ${evidence}`);
  throw error;
} finally {
  await browser?.close();
  await server.close();
}
