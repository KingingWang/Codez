import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

export async function captureOptionalAgentBrowserSnapshot(evidence) {
  if (!process.env.AGENT_BROWSER_BIN) return;
  const { stdout } = await promisify(execFile)(process.execPath, [
    process.env.AGENT_BROWSER_BIN,
    "--session",
    "codex-ui-qa",
    "--cdp",
    "9338",
    "snapshot",
    "-i",
  ]);
  await writeFile(join(evidence, "agent-browser-snapshot.txt"), stdout);
}

export async function verifyRootProviderStartup(page, checks) {
  const fixture = page.getByRole("region", { name: "Root startup mode fixture" });
  const inspect = async () => {
    await fixture.getByRole("button", { name: "Inspect Root startup" }).click();
    return JSON.parse(await fixture.getByTestId("qa-root-startup-inspection").innerText());
  };
  const before = await inspect();
  assert.equal(before.providerReads, 0);
  assert.equal(before.providerSubscriptions, 0);
  assert.equal(before.providerRefreshes, 0);
  assert.equal(before.workflowReads, 0);
  assert.equal(before.oauthRestores, 0);
  await fixture.getByRole("button", { name: "Resolve native Codex Host" }).click();
  const native = await inspect();
  for (const key of [
    "providerReads",
    "providerSubscriptions",
    "providerRefreshes",
    "workflowReads",
    "oauthRestores",
  ])
    assert.equal(native[key], 0, `Native Host unexpectedly started legacy ${key}`);
  assert.ok(
    native.oauthSubscriptions >= 1,
    "Native Host must accept stale OAuth transport replies",
  );
  await fixture.getByRole("button", { name: "Deliver pending legacy OAuth link" }).click();
  await page.waitForFunction(() => {
    const text = document.querySelector('[data-testid="qa-root-startup-inspection"]')?.textContent;
    return text && JSON.parse(text).oauthHandled === 1;
  });
  const acknowledged = await inspect();
  assert.equal(
    acknowledged.oauthBusinessCallbacks,
    0,
    "Stale OAuth link must not sign in to Codez",
  );
  assert.ok(native.rendererReady >= 1, "Native Host must notify Main that Renderer is ready");
  assert.equal(native.workflowEnabled, false, "Native Host cannot expose old workflow entry");
  await fixture.getByRole("button", { name: "Change callback dependency" }).click();
  const updated = await inspect();
  assert.equal(
    updated.rendererReady,
    acknowledged.rendererReady,
    "Re-registering native callbacks must not notify Main ready twice",
  );
  checks.push("Native Codex Root skips legacy Provider/OAuth state yet acknowledges pending link");

  await fixture.getByRole("button", { name: "Resolve legacy Host" }).click();
  const legacy = await inspect();
  for (const key of [
    "providerReads",
    "providerSubscriptions",
    "providerRefreshes",
    "workflowReads",
    "oauthRestores",
    "oauthSubscriptions",
  ])
    assert.ok(legacy[key] > 0, `Legacy Host lost existing ${key} path`);
  checks.push("Explicit legacy Root keeps Provider snapshot, refresh and OAuth subscriptions");

  await fixture.getByRole("button", { name: "Start pending legacy login" }).click();
  const pendingLogin = await inspect();
  assert.equal(pendingLogin.oauthBusinessCallbacks, legacy.oauthBusinessCallbacks + 1);
  await fixture.getByRole("button", { name: "Resolve native Codex Host" }).click();
  await fixture.getByRole("button", { name: "Release pending legacy login" }).click();
  await page.waitForFunction((previous) => {
    const text = document.querySelector('[data-testid="qa-root-startup-inspection"]')?.textContent;
    return text && JSON.parse(text).oauthHandled > previous;
  }, pendingLogin.oauthHandled);
  const switched = await inspect();
  await fixture.getByRole("button", { name: "Release legacy workflow response" }).click();
  const afterWorkflow = await inspect();
  assert.equal(afterWorkflow.workflowEnabled, false);
  assert.equal(switched.oldAccountWrites, pendingLogin.oldAccountWrites);
  assert.equal(switched.providerRefreshes, pendingLogin.providerRefreshes);
  assert.equal(switched.oldLoginSuccesses, pendingLogin.oldLoginSuccesses);
  checks.push("In-flight legacy OAuth deep link only acknowledges after native Host takeover");
  checks.push(
    "Native Root neither reads old workflow entitlement nor accepts a late enabled response",
  );

  await fixture.getByRole("button", { name: "Resolve legacy Host" }).click();
  const beforePoll = await inspect();
  await fixture.getByRole("button", { name: "Start legacy polling" }).click();
  await page.waitForFunction((previous) => {
    const text = document.querySelector('[data-testid="qa-root-startup-inspection"]')?.textContent;
    return text && JSON.parse(text).oauthPolls > previous;
  }, beforePoll.oauthPolls);
  const pendingPoll = await inspect();
  await fixture.getByRole("button", { name: "Resolve native Codex Host" }).click();
  await fixture.getByRole("button", { name: "Release pending legacy poll" }).click();
  const afterPoll = await inspect();
  assert.equal(afterPoll.oldAccountWrites, pendingPoll.oldAccountWrites);
  assert.equal(afterPoll.providerRefreshes, pendingPoll.providerRefreshes);
  assert.equal(afterPoll.oldLoginSuccesses, pendingPoll.oldLoginSuccesses);
  checks.push("In-flight legacy OAuth poll cannot sign in after native Host takeover");

  await fixture.getByRole("button", { name: "Resolve legacy Host" }).click();
  const beforeFamilyPoll = await inspect();
  await fixture.getByRole("button", { name: "Start legacy polling" }).click();
  await page.waitForFunction((previous) => {
    const text = document.querySelector('[data-testid="qa-root-startup-inspection"]')?.textContent;
    return text && JSON.parse(text).oauthPolls > previous;
  }, beforeFamilyPoll.oauthPolls);
  await fixture.getByRole("button", { name: "Hold legacy family refresh" }).click();
  await fixture.getByRole("button", { name: "Release pending legacy poll" }).click();
  await page.waitForFunction((previous) => {
    const text = document.querySelector('[data-testid="qa-root-startup-inspection"]')?.textContent;
    return text && JSON.parse(text).familyReadsHeld > previous;
  }, beforeFamilyPoll.familyReadsHeld);
  const pendingFamily = await inspect();
  await fixture.getByRole("button", { name: "Resolve native Codex Host" }).click();
  await fixture.getByRole("button", { name: "Release legacy family refresh" }).click();
  const afterFamily = await inspect();
  assert.equal(afterFamily.providerFamilyReads, pendingFamily.providerFamilyReads);
  assert.equal(afterFamily.oldLoginSuccesses, pendingFamily.oldLoginSuccesses);
  checks.push("Old polling entitlement read cannot initiate Provider RPC after Host takeover");

  await fixture.getByRole("button", { name: "Resolve legacy Host" }).click();
  const beforeLegacyLogin = await inspect();
  await fixture.getByRole("button", { name: "Start pending legacy login" }).click();
  await fixture.getByRole("button", { name: "Release pending legacy login" }).click();
  await page.waitForFunction((previous) => {
    const text = document.querySelector('[data-testid="qa-root-startup-inspection"]')?.textContent;
    return text && JSON.parse(text).oldLoginSuccesses > previous;
  }, beforeLegacyLogin.oldLoginSuccesses);
  const legacyLogin = await inspect();
  assert.equal(legacyLogin.oldAccountWrites, beforeLegacyLogin.oldAccountWrites + 1);
  assert.equal(legacyLogin.oldSettingWrites, beforeLegacyLogin.oldSettingWrites + 1);
  assert.equal(legacyLogin.providerRefreshes, beforeLegacyLogin.providerRefreshes + 1);
  checks.push("Current legacy Host still completes its interactive OAuth login");

  await fixture.getByRole("button", { name: "Resolve native Codex Host" }).click();
  const beforePrompt = await inspect();
  await fixture.getByRole("button", { name: "Restore expired legacy session" }).click();
  const prompt = fixture.getByRole("dialog", { name: "Legacy reauthentication prompt" });
  await prompt.waitFor();
  await fixture.getByRole("button", { name: "Resolve native Codex Host" }).click();
  await prompt.waitFor({ state: "detached" });
  const afterPrompt = await inspect();
  assert.equal(afterPrompt.reauthenticationActions, beforePrompt.reauthenticationActions);
  checks.push("Native takeover cancels its old reauthentication prompt without acting on it");
}

export async function verifyGeneralAccessibility(page, checks) {
  const fixture = page.getByRole("region", { name: "General accessibility fixture" });
  await fixture.getByRole("button", { name: "Toggle General accessibility fixture" }).click();
  const controls = fixture.getByTestId("qa-general-controls");
  for (const name of [
    "Inherit system terminal profile",
    "Task notifications",
    "Notification sound",
    "Hide to tray when closing window",
    "Auto-archive old tasks",
  ])
    await controls.getByRole("switch", { name, exact: true }).waitFor();
  for (const name of ["Language", "Integrated terminal shell", "Archive retention"])
    await controls.getByRole("combobox", { name, exact: true }).waitFor();
  checks.push("General shared UI exposes translated names for desktop and Windows-only controls");

  const notification = controls.getByRole("switch", { name: "Task notifications" });
  assert.equal(await notification.getAttribute("aria-checked"), "false");
  await notification.click();
  assert.equal(await notification.getAttribute("aria-checked"), "true");
  await notification.focus();
  await notification.press("Space");
  assert.equal(await notification.getAttribute("aria-checked"), "false");
  const archive = controls.getByRole("switch", { name: "Auto-archive old tasks" });
  await archive.click();
  assert.equal(
    await controls.getByRole("combobox", { name: "Archive retention" }).isEnabled(),
    true,
  );
  await archive.press("Space");
  assert.equal(await archive.getAttribute("aria-checked"), "false");
  checks.push("General named switches keep mouse/keyboard state parity and preserve select gating");
  await fixture.getByRole("button", { name: "Toggle General accessibility fixture" }).click();
}

export async function verifyCodexHelpUpdate(page, result, evidence, checks) {
  assert.equal(await page.getByTestId("qa-product-flavor").innerText(), "codex");
  await page.getByTestId("qa-web-help").getByRole("button", { name: "Help" }).click();
  assert.equal(await page.getByRole("menuitem", { name: "Check for Updates" }).count(), 0);
  await page.keyboard.press("Escape");
  await page.getByTestId("qa-desktop-help").getByRole("button", { name: "Help" }).click();
  const checkUpdate = page.getByRole("menuitem", { name: "Check for Updates" });
  await checkUpdate.waitFor();
  await page.screenshot({ path: join(evidence, "codex-help-update.png"), animations: "disabled" });
  await checkUpdate.click();
  await page.getByRole("button", { name: "Inspect desktop commands" }).click();
  assert.deepEqual(await result(), ["checkForUpdates"]);
  checks.push("Codex desktop Help exposes the native update command; Web hides it");
}

export async function verifyMessageFeedback(page, checks) {
  const feedback = page.getByTestId("message-feedback-fixture");
  assert.equal(await feedback.getByTestId("feedback-hello-reads").innerText(), "0");
  await feedback.getByRole("button", { name: "Like", exact: true }).click();
  assert.equal(await feedback.getByTestId("feedback-writes").innerText(), "1");
  await feedback.getByRole("button", { name: "Use Desktop feedback", exact: true }).click();
  await feedback
    .getByTestId("feedback-hello-reads")
    .filter({ hasText: /^[1-9]/ })
    .waitFor();
  assert.equal(await feedback.getByRole("button", { name: /^(Like|Liked|Dislike)$/ }).count(), 0);
  const desktopHelloReads = await feedback.getByTestId("feedback-hello-reads").innerText();
  await feedback.getByRole("button", { name: "Use Web feedback", exact: true }).click();
  await feedback.getByRole("button", { name: "Dislike", exact: true }).click();
  assert.equal(await feedback.getByTestId("feedback-writes").innerText(), "2");
  assert.equal(await feedback.getByTestId("feedback-hello-reads").innerText(), desktopHelloReads);
  checks.push(
    "Shared Web/legacy row actions retain working feedback without Codex hello; Desktop unsupported hides feedback and sends no command",
  );
}
export async function inspectRpcLog(page, result) {
  const previous = (await result())?.inspection ?? 0;
  await page.getByRole("button", { name: "Inspect RPC log", exact: true }).click();
  await page.waitForFunction((revision) => {
    try {
      const current = JSON.parse(document.querySelector('[data-testid="result"]')?.textContent);
      return typeof current.inspection === "number" && current.inspection > revision;
    } catch {
      return false;
    }
  }, previous);
  return result();
}

export async function verifySingleCatalogModelAndRestart(page, settings, result, checks) {
  const catalogModels = settings.getByRole("heading", { name: "Catalog models" }).locator("..");
  const deleteLast = catalogModels.getByRole("button", { name: "Delete second-model" });
  await deleteLast.waitFor();
  assert.equal(await deleteLast.isDisabled(), true);
  await catalogModels.getByText(/at least one catalog model/i).waitFor();
  checks.push(
    "A configured single-model catalog cannot offer deletion that would break native Codex",
  );
  const visibleInPicker = catalogModels.getByRole("switch", {
    name: "Show in the model picker: second-model",
  });
  assert.equal(await visibleInPicker.getAttribute("aria-checked"), "true");
  const initialWrites = (await inspectRpcLog(page, result)).catalogWrites;
  await visibleInPicker.click();
  await page.waitForFunction(
    () =>
      document
        .querySelector('[role="switch"][aria-label="Show in the model picker: second-model"]')
        ?.getAttribute("aria-checked") === "false",
  );
  const persisted = await inspectRpcLog(page, result);
  assert.equal(persisted.catalogWrites, initialWrites + 1);
  assert.equal(persisted.catalogModelVisibility, "hidden");
  checks.push(
    "Catalog model visibility switch has a target-specific name and matching checked state",
  );
  const restartRuntime = settings.getByRole("button", { name: "Restart runtime now" });
  await restartRuntime.waitFor();
  await restartRuntime.click();
  await settings
    .getByText("Restarting interrupts running tasks in this workspace. Continue?")
    .waitFor();
  await settings.getByRole("button", { name: "Confirm restart" }).waitFor();
  await settings.getByRole("button", { name: "Cancel", exact: true }).click();
  assert.equal((await inspectRpcLog(page, result)).runtimeDisposals, 0);
  await restartRuntime.click();
  await settings.getByRole("button", { name: "Confirm restart" }).click();
  assert.equal((await inspectRpcLog(page, result)).runtimeDisposals, 1);
  checks.push(
    "Catalog restart warns about in-flight tasks; cancel does not dispose, confirmation disposes once",
  );
}

export function createCatalogConfigReadCounter(page, result) {
  return async (workspacePath = "/isolated/workspace") => {
    const requests = (await inspectRpcLog(page, result)).requests ?? [];
    return requests.filter(
      (request) => request.method === "config/read" && request.workspacePath === workspacePath,
    ).length;
  };
}

export async function waitFixtureButtonEnabled(page, name) {
  await page.getByRole("button", { name, exact: true }).waitFor();
  await page.waitForFunction(
    (label) =>
      [...document.querySelectorAll("button")].some(
        (button) => button.textContent === label && !button.disabled,
      ),
    name,
  );
}

export async function verifyModeTooltipOwnership(page, tooltipWarnings, checks) {
  const before = tooltipWarnings.length;
  for (let attempt = 0; attempt < 3; attempt++) {
    await page.getByRole("button", { name: "Switch mode", exact: true }).click();
    await page.getByRole("menu").waitFor();
    await page.keyboard.press("Escape");
    await page.getByRole("menu").waitFor({ state: "hidden" });
  }
  assert.equal(
    tooltipWarnings.length,
    before,
    "Opening/closing the native mode menu must not switch Tooltip ownership",
  );
  checks.push("Native mode picker keeps stable Tooltip ownership across repeated opens");
}

export async function verifyLocalConfigValidation(page, settings, result, checks) {
  await settings.getByRole("button", { name: "Configuration", exact: true }).click();
  await settings.getByRole("textbox", { name: "Configuration key path" }).fill("model");
  await settings.getByRole("textbox", { name: "JSON value" }).fill("{");
  await settings.getByRole("button", { name: "Write value" }).click();
  await settings.getByRole("alert").waitFor();
  // Alert 内容依赖 JSON.parse 引擎实现（V8/Safari/SpiderMonkey 措辞不同），
  // 此处仅断言 alert 存在且不为空，生产端用户侧的契约不依赖特定引擎文案。
  assert.ok((await settings.getByRole("alert").innerText()).length > 0);
  assert.equal(await settings.getByText(/Operation failed\. Refresh/).count(), 0);
  const rpcLog = await inspectRpcLog(page, result);
  assert.equal(
    rpcLog.requests.filter((request) => request.method === "config/value/write").length,
    0,
  );
  await settings.getByRole("button", { name: "Models & permissions" }).click();
  assert.equal(await settings.getByRole("alert").count(), 0);
  checks.push("Invalid native configuration JSON is form-local and sends no mutation RPC");
}

export async function verifyUsageHostReconnect(page, checks) {
  const fixture = page.getByTestId("usage-race-fixture");
  const summary = fixture.getByTestId("codex-usage-observations");
  await fixture.getByRole("button", { name: "Mount usage race" }).click();
  await fixture.getByRole("button", { name: "Advance usage Host" }).click();
  await fixture.getByRole("button", { name: "Complete current usage read" }).click();
  await summary.getByText("30", { exact: true }).waitFor();
  await fixture.getByRole("button", { name: "Complete stale usage read" }).click();
  assert.equal(await summary.getByText("30", { exact: true }).count(), 1);
  await fixture.getByRole("button", { name: "Advance usage Host" }).click();
  await fixture.getByRole("button", { name: "Advance usage Host" }).click();
  await fixture.getByRole("button", { name: "Complete current usage read" }).click();
  await summary.getByText("50", { exact: true }).waitFor();
  await fixture.getByRole("button", { name: "Reject stale usage read" }).click();
  assert.equal(await summary.getByText("50", { exact: true }).count(), 1);
  assert.equal(await fixture.getByRole("alert").count(), 0);
  checks.push("Same-workspace Host reconnect ignores stale observation success and failure");
}
