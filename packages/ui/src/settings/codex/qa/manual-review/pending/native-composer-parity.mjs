// Pending browser acceptance: real Composer/hooks, synthetic Host facts, never real credentials.
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createServer } from "vite";
import { chromium } from "playwright-core";
import { verifyMessageFeedback } from "../../settings-regressions-e2e.mjs";

const evidence = await mkdtemp(join(tmpdir(), "native-composer-parity-"));
const server = await createServer({
  configFile: resolve("packages/desktop/vite.config.ts"),
  root: resolve("packages/ui/src/settings/codex/qa"),
  cacheDir: resolve("packages/ui/node_modules/.vite-native-composer-parity"),
  logLevel: "error",
  server: { host: "127.0.0.1", port: 0, hmr: false },
});
await server.listen();
const browser = await chromium.launch({
  executablePath: process.env.CODEZ_UI_QA_CHROME ?? "/opt/google/chrome/chrome",
  headless: true,
  args: ["--no-sandbox"],
});
const checks = [];
try {
  for (const surface of ["mobile", "desktop"]) {
    for (const theme of ["light", "dark"]) {
      const page = await browser.newPage({
        viewport: { width: surface === "mobile" ? 390 : 1200, height: 900 },
        hasTouch: surface === "mobile",
        isMobile: surface === "mobile",
      });
      const errors = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await page.route("**/*", (route) =>
        new URL(route.request().url()).hostname === "127.0.0.1" ? route.continue() : route.abort(),
      );
      try {
        await page.goto(`${server.resolvedUrls.local[0]}?native-parity&surface=${surface}`);
        await page.evaluate(
          (theme) => document.documentElement.classList.toggle("dark", theme === "dark"),
          theme,
        );
        const draft = () => page.getByTestId("parity-draft").innerText().then(JSON.parse);
        const commands = () => page.getByTestId("parity-commands").innerText().then(JSON.parse);
        const model = page.getByTestId("chat-model-select-trigger");
        const effort = page.getByTestId("chat-thought-level-select-trigger");
        await model.waitFor();
        for (const phase of ["running", "prewarming", "stopping"]) {
          await page.getByRole("button", { name: phase, exact: true }).click();
          assert.equal(await model.isDisabled(), true, phase);
          assert.equal(await effort.isDisabled(), true, phase);
          assert.equal((await draft()).modelSelection.modelId, "model-a");
        }
        await page.getByRole("button", { name: "idle", exact: true }).click();
        assert.equal(await model.isEnabled(), true);
        await model.click();
        await page.getByRole("menuitem", { name: "provider-b", exact: true }).click();
        await page.getByRole("menuitemradio", { name: "model-b", exact: true }).click();
        assert.deepEqual((await draft()).modelSelection, {
          providerId: "provider-b",
          modelId: "model-b",
          options: { reasoningLevel: "medium" },
        });
        const input = page.getByTestId("v4-composer-input");
        await input.fill("E2E_NATIVE_PARITY 继续");
        await page.getByRole("button", { name: "Send", exact: true }).click();
        await page.waitForFunction(
          () =>
            JSON.parse(document.querySelector('[data-testid="parity-commands"]').textContent)
              .length === 1,
        );
        assert.deepEqual((await commands())[0].modelSelection, (await draft()).modelSelection);
        await page.getByRole("button", { name: "Edit resend fixture", exact: true }).click();
        assert.deepEqual(
          (await commands())[1].modelSelection,
          (await commands())[0].modelSelection,
        );
        await input.fill("E2E_NATIVE_PARITY retained");
        await page.getByRole("button", { name: "Toggle Host pending", exact: true }).click();
        assert.equal(
          await page.getByRole("button", { name: "Send", exact: true }).isDisabled(),
          true,
        );
        await page.getByRole("button", { name: "Edit resend fixture", exact: true }).click();
        assert.equal((await commands()).length, 2);
        await page.getByRole("button", { name: "Toggle Host pending", exact: true }).click();
        await model.waitFor();
        await page.getByRole("button", { name: "Toggle catalog failure", exact: true }).click();
        await page.getByRole("alert").filter({ hasText: "Parity catalog unavailable" }).waitFor();
        await page.getByRole("button", { name: "Edit resend fixture", exact: true }).click();
        assert.equal((await commands()).length, 2);
        assert.match(await input.innerText(), /retained/);
        assert.equal(
          JSON.parse(await page.getByTestId("parity-intent").innerText()).modelId,
          "model-b",
        );
        await page.getByRole("button", { name: "Toggle catalog failure", exact: true }).click();
        await model.waitFor();
        assert.equal((await draft()).modelSelection.modelId, "model-b");
        await page.getByRole("button", { name: "Switch scope", exact: true }).click();
        await page.waitForFunction(() =>
          document.querySelector('[data-testid="parity-draft"]').textContent.includes("model-a"),
        );
        assert.equal(await page.getByTestId("parity-legacy").innerText(), "0");
        assert.equal(await page.getByTestId("v4-queue-resume").count(), 0);
        assert.equal(await page.getByText(/Starts after the current task finishes/).count(), 1);
        assert.equal(await page.getByText(/queue is paused/i).count(), 0);
        await verifyMessageFeedback(page, checks);
        assert.deepEqual(errors, []);
        await page.screenshot({ path: join(evidence, `${surface}-${theme}.png`), fullPage: true });
        checks.push(
          `${surface}/${theme}: busy locks, B immediate send/default effort, frozen edit fixture, pending/error no dispatch, scope isolation, no legacy reads/resume`,
        );
      } catch (error) {
        await page.screenshot({
          path: join(evidence, `${surface}-${theme}-failure.png`),
          fullPage: true,
        });
        await writeFile(
          join(evidence, "failure.json"),
          JSON.stringify(
            { error: error.message, errors, body: await page.locator("body").innerText() },
            null,
            2,
          ),
        );
        throw new Error(
          `${surface}/${theme}: ${error.message}; pageerrors=${JSON.stringify(errors)}`,
          { cause: error },
        );
      } finally {
        await page.close();
      }
    }
  }
  await writeFile(join(evidence, "result.json"), JSON.stringify({ checks, evidence }, null, 2));
  console.log(JSON.stringify({ status: "passed", evidence, checks }, null, 2));
} finally {
  console.log(`Evidence: ${evidence}`);
  await browser.close();
  await server.close();
}
