import assert from "node:assert/strict";

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

export function createCatalogConfigReadCounter(page, result) {
  return async (workspacePath = "/isolated/workspace") => {
    await page.getByRole("button", { name: "Inspect RPC log", exact: true }).click();
    const requests = (await result()).requests ?? [];
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
  await page.getByRole("button", { name: "Inspect RPC log", exact: true }).click();
  assert.equal(
    (await result()).requests.filter((request) => request.method === "config/value/write").length,
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
