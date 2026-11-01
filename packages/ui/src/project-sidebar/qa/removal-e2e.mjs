import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createServer } from "vite";
import { chromium } from "playwright-core";

const evidence = await mkdtemp(join(tmpdir(), "codez-project-removal-"));
const checks = [];
const errors = [];
const server = await createServer({
  configFile: resolve("packages/desktop/vite.config.ts"),
  root: resolve("packages/ui/src/project-sidebar/qa"),
  cacheDir: join(evidence, "vite-cache"),
  server: { host: "127.0.0.1", port: 5194, strictPort: true },
});
await server.listen();
const browser = await chromium.launch({
  executablePath: process.env.CODEZ_UI_QA_CHROME ?? "/usr/bin/google-chrome",
  headless: true,
  args: ["--no-sandbox"],
  env: {
    PATH: process.env.PATH,
    HOME: evidence,
    XDG_CONFIG_HOME: evidence,
    XDG_CACHE_HOME: evidence,
  },
});
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  page.on("pageerror", (error) => errors.push(error.message));
  await page.route("**/*", (route) =>
    new URL(route.request().url()).hostname === "127.0.0.1" ? route.continue() : route.abort(),
  );
  const open = async (mode) => {
    await page.goto("http://127.0.0.1:5194/removal.html");
    await page.getByRole("button", { name: `Open ${mode}`, exact: true }).click();
  };
  const dialog = page.getByTestId("project-management-confirm");
  await open("error");
  await dialog.locator('[data-status="error"]').waitFor();
  assert.equal(await dialog.getByRole("checkbox").count(), 0);
  assert.equal((await dialog.innerText()).includes("private error"), false);
  await page.evaluate(() =>
    document.querySelectorAll("button").forEach((button) => {
      if (button.textContent === "Next measurement succeeds") button.click();
    }),
  );
  await dialog.getByRole("button", { name: "Measure again", exact: true }).click();
  const checkbox = dialog.getByRole("checkbox");
  await checkbox.waitFor();
  assert.equal(await checkbox.getAttribute("aria-checked"), "false");
  await checkbox.click();
  const confirm = dialog.getByTestId("project-management-confirm-remove");
  assert.equal(await confirm.isDisabled(), true);
  await dialog.getByTestId("project-management-confirm-data-word").fill("delete");
  assert.equal(await confirm.isEnabled(), true);
  await checkbox.click();
  await checkbox.click();
  assert.equal(await dialog.getByTestId("project-management-confirm-data-word").inputValue(), "");
  await dialog.getByTestId("project-management-confirm-data-word").fill("delete");
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await page.getByRole("button", { name: "Reopen same batch", exact: true }).click();
  await checkbox.waitFor();
  assert.equal(await checkbox.getAttribute("aria-checked"), "false");
  assert.equal(await dialog.getByTestId("project-management-confirm-data-word").count(), 0);
  checks.push(
    "Read failure cannot enable deletion; explicit retry restores unchecked data option and confirmation-word guard",
  );
  await open("unsupported");
  await dialog.locator('[data-status="unsupported"]').waitFor();
  assert.equal(await dialog.getByRole("checkbox").count(), 0);
  assert.equal(await dialog.getByRole("button", { name: "Measure again" }).count(), 0);
  await open("empty");
  await page.waitForFunction(
    () =>
      JSON.parse(document.querySelector('[data-testid="removal-evidence"]').textContent).calls ===
      1,
  );
  assert.equal(await dialog.getByRole("checkbox").count(), 0);
  checks.push("Unsupported is explicit; truly empty data does not offer deletion");
  await open("held");
  assert.equal(await dialog.getByRole("checkbox").isDisabled(), true);
  await page.evaluate(() =>
    document.querySelectorAll("button").forEach((button) => {
      if (button.textContent === "Replace batch") button.click();
    }),
  );
  await dialog.locator('[data-status="error"]').waitFor();
  await page.evaluate(() =>
    document.querySelectorAll("button").forEach((button) => {
      if (button.textContent === "Release held") button.click();
    }),
  );
  assert.equal(await dialog.getByRole("checkbox").count(), 0);
  checks.push("Late measurement from a replaced batch cannot restore destructive eligibility");
  for (const width of [390, 1280])
    for (const locale of ["en-US", "zh-CN"])
      for (const theme of ["light", "dark"]) {
        await page.setViewportSize({ width, height: 900 });
        await page.goto(`http://127.0.0.1:5194/removal.html?locale=${locale}&theme=${theme}`);
        await page.getByRole("button", { name: "Open error", exact: true }).click();
        await dialog.locator('[data-status="error"]').waitFor();
        assert.ok(
          (await dialog.innerText()).includes(
            locale === "zh-CN" ? "无法安全测量会话数据" : "Could not measure session data safely",
          ),
        );
        assert.equal(
          await dialog.evaluate((element) => element.scrollWidth > element.clientWidth),
          false,
        );
        await page.screenshot({ path: join(evidence, `${width}-${locale}-${theme}.png`) });
      }
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ status: "passed", checks, layouts: 8, evidence }, null, 2));
} finally {
  await writeFile(join(evidence, "results.json"), JSON.stringify({ checks, errors }, null, 2));
  await browser.close();
  await server.close();
}
