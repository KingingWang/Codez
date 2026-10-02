import assert from "node:assert/strict";

/** Exercise the real Codex Memory panel and scoped role actions in both UI locales. */
export async function verifyCodexMemoryLocale(page, checks) {
  await page.getByRole("button", { name: "Toggle settings", exact: true }).click();
  const memory = page.getByTestId("codex-settings");
  await memory.getByRole("button", { name: "Memory", exact: true }).click();
  for (const [label, defaultValue] of [
    ["Max threads processed per startup", 2],
    ["Max thread age (days)", 10],
    ["Min thread idle (hours)", 6],
    ["Max raw memories for consolidation", 256],
    ["Max unused days", 30],
    ["Min rate-limit remaining (%)", 25],
  ]) {
    const row = memory.getByRole("textbox", { name: label }).locator("..");
    await row.getByText(`Default: ${defaultValue}`, { exact: false }).waitFor();
    assert.equal(await row.getByText("默认", { exact: false }).count(), 0);
  }
  checks.push("All six native Memory numeric defaults are localized in English");
  await page.getByRole("button", { name: "Use Chinese locale fixture" }).click();
  for (const [label, defaultValue] of [
    ["单次启动最大处理会话数", 2],
    ["会话最大年龄（天）", 10],
    ["会话最小空闲（小时）", 6],
    ["整合最大原始记忆数", 256],
    ["记忆最长未使用（天）", 30],
    ["启动所需最低额度（%）", 25],
  ]) {
    const row = memory.getByRole("textbox", { name: label }).locator("..");
    await row.getByText(`默认：${defaultValue}`, { exact: false }).waitFor();
    assert.equal(await row.getByText("Default:", { exact: false }).count(), 0);
  }
  checks.push("All six native Memory numeric defaults are localized in Chinese");
  const invalidMemoryValue = memory.getByRole("textbox", { name: "单次启动最大处理会话数" });
  await invalidMemoryValue.fill("999");
  await invalidMemoryValue.press("Tab");
  await invalidMemoryValue.locator("..").getByText("数值超出范围，未保存。").waitFor();
  checks.push("Invalid native Memory numeric draft keeps a localized inline error");
  await memory.getByRole("button", { name: "子智能体", exact: true }).click();
  await memory
    .getByRole("button", { name: "新建角色: 用户角色 (~/.codex/agents)", exact: true })
    .waitFor();
  await memory
    .getByRole("button", { name: "新建角色: 项目角色 (.codex/agents)", exact: true })
    .waitFor();
  checks.push("Subagent scope-specific action names follow the Chinese locale");
  await page.getByRole("button", { name: "Use English locale fixture" }).click();
  await page.getByRole("button", { name: "Toggle settings", exact: true }).click();
}
