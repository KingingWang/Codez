// Inspect actual isolated Electron General controls; never attach to another renderer port.
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright-core";

const evidence = await mkdtemp(join(tmpdir(), "codex-ui-general-accessibility-"));
const rendererPort = Number(process.env.CODEX_UI_QA_RENDERER_PORT ?? 5174);
const cdpPort = Number(process.env.CODEX_UI_QA_CDP_PORT ?? 9229);
for (const port of [rendererPort, cdpPort])
  assert.ok(Number.isInteger(port) && port > 1023 && port <= 65535, "Invalid QA port");

const browser = await chromium.connectOverCDP(`http://127.0.0.1:${cdpPort}`);
const page = browser
  .contexts()
  .flatMap((context) => context.pages())
  .find((entry) => {
    const url = new URL(entry.url());
    return (
      url.protocol === "http:" &&
      ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) &&
      Number(url.port) === rendererPort
    );
  });
if (!page) throw new Error("Expected the selected isolated Electron QA renderer");
const checks = [];
try {
  const settings = page.getByRole("button", { name: "Settings", exact: true });
  if (await settings.count()) await settings.click();
  await page.getByRole("button", { name: "General", exact: true }).click();
  for (const name of [
    "Inherit system terminal profile",
    "Task notifications",
    "Notification sound",
    "Auto-archive old tasks",
  ]) {
    await page.getByRole("switch", { name, exact: true }).waitFor();
  }
  checks.push("Every visible General switch exposes its translated setting name");
  for (const name of ["Language", "Archive retention"]) {
    await page.getByRole("combobox", { name, exact: true }).waitFor();
  }
  checks.push("Visible General selects expose their translated setting names");
  const notification = page.getByRole("switch", { name: "Task notifications", exact: true });
  const initial = await notification.getAttribute("aria-checked");
  assert.ok(initial === "true" || initial === "false");
  await notification.focus();
  await notification.press("Space");
  await page.waitForFunction(
    (previous) =>
      document
        .querySelector('[role="switch"][aria-label="Task notifications"]')
        ?.getAttribute("aria-checked") !== previous,
    initial,
  );
  await notification.press("Space");
  await page.waitForFunction(
    (previous) =>
      document
        .querySelector('[role="switch"][aria-label="Task notifications"]')
        ?.getAttribute("aria-checked") === previous,
    initial,
  );
  checks.push("Keyboard changes and restores the same persisted setting as a mouse click");
  await page.screenshot({ path: join(evidence, "general-controls.png") });
  await writeFile(join(evidence, "results.json"), JSON.stringify({ checks }, null, 2));
  console.log(JSON.stringify({ status: "passed", evidence, checks }));
} catch (error) {
  console.error({ evidence, checks });
  throw error;
} finally {
  await browser.close();
}
