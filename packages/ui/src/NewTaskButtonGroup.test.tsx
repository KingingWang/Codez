import assert from "node:assert/strict";
import { execFile as nodeExecFile } from "node:child_process";
import { readFile, rm, writeFile } from "node:fs/promises";
import test from "node:test";
import { promisify } from "node:util";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactNode } from "react";
import type { IPlatformService } from "@codez/shared";
import type { IServiceAccessor } from "@codez/services";
import { PlatformProvider } from "@/hooks/usePlatform.js";
import { ServiceProvider } from "@/hooks/useServices.js";
import { CodezIntlProvider } from "@/i18n/IntlProvider.js";
import { NewTaskButtonGroup } from "./NewTaskButtonGroup.js";

const execFile = promisify(nodeExecFile);
const platform = { onSettingsChanged: undefined } as unknown as IPlatformService;
const services = {} as IServiceAccessor;

function testHarness({
  onCreateTask,
  disabled,
  menuContent,
  menuLabel,
}: {
  onCreateTask: () => void;
  disabled?: boolean;
  menuContent?: ReactNode;
  menuLabel?: string;
}) {
  return (
    <PlatformProvider platform={platform}>
      <ServiceProvider services={services}>
        <CodezIntlProvider initialLocale="zh-CN">
          <NewTaskButtonGroup
            onCreateTask={onCreateTask}
            disabled={disabled}
            menuContent={menuContent}
            menuLabel={menuLabel}
          />
        </CodezIntlProvider>
      </ServiceProvider>
    </PlatformProvider>
  );
}

test("R1 split button keeps the default primary action and an explicit dropdown trigger", () => {
  const html = renderToStaticMarkup(
    testHarness({
      onCreateTask: () => {},
      menuContent: <div>worktree menu</div>,
      menuLabel: "New task options",
    }),
  );

  assert.match(html, /<div[^>]*role="group"/);
  assert.match(
    html,
    /<button[^>]*type="button"[^>]*data-testid="task-new-button"[^>]*>.*新建任务.*Ctrl\+N.*<\/button>/s,
  );
  assert.match(
    html,
    /<button[^>]*type="button"[^>]*aria-label="New task options"[^>]*aria-haspopup="menu"/s,
  );
  assert.equal(html.includes("worktree menu"), false);
  assert.doesNotMatch(html, /<div[^>]*role="group"[^>]*onclick=/i);
});

test("the secondary trigger only renders with menu content", () => {
  const html = renderToStaticMarkup(testHarness({ onCreateTask: () => {} }));

  assert.match(html, /data-testid="task-new-button"/);
  assert.equal(html.includes('aria-haspopup="menu"'), false);
});

test("readOnly disabling keeps both native controls disabled without moving the primary test id", () => {
  const html = renderToStaticMarkup(
    testHarness({
      onCreateTask: () => {},
      disabled: true,
      menuContent: <div>worktree menu</div>,
    }),
  );

  assert.match(html, /<button[^>]*data-testid="task-new-button"[^>]*disabled/s);
  assert.match(html, /<button[^>]*disabled=""[^>]*aria-haspopup="menu"/s);
});

test("clicking the secondary arrow never routes through the default creation action", async () => {
  const fixtureSource = `/tmp/new-task-button-group-${process.pid}.tsx`;
  const fixture = `/tmp/new-task-button-group-${process.pid}.mjs`;
  await writeFile(
    fixtureSource,
    `
      import { createRoot } from "react-dom/client";
      import { PlatformProvider } from "@/hooks/usePlatform.js";
      import { ServiceProvider } from "@/hooks/useServices.js";
      import { CodezIntlProvider } from "@/i18n/IntlProvider.js";
      import { NewTaskButtonGroup } from "@/NewTaskButtonGroup.js";

      const platform = { onSettingsChanged: undefined } as unknown as import("@codez/shared").IPlatformService;
      const services = {} as import("@codez/services").IServiceAccessor;

      createRoot(document.body).render(
        <PlatformProvider platform={platform}>
          <ServiceProvider services={services}>
            <CodezIntlProvider initialLocale="zh-CN">
              <NewTaskButtonGroup
                onCreateTask={() => window.__recordDefaultCreate?.()}
                menuContent={<div>worktree menu</div>}
              />
            </CodezIntlProvider>
          </ServiceProvider>
        </PlatformProvider>,
      );
    `,
  );
  await execFile("node_modules/.bin/esbuild", [
    fixtureSource,
    "--bundle",
    `--outfile=${fixture}`,
    "--format=esm",
    "--platform=browser",
    "--jsx=automatic",
    "--tsconfig=packages/ui/tsconfig.json",
    "--alias:react=react",
    "--alias:react-dom=react-dom",
    `--define:process.env.NODE_ENV="production"`,
  ]);
  const { chromium } = await import("playwright-core");
  const browser = await chromium.launch({ executablePath: "/usr/bin/google-chrome" });
  try {
    const page = await browser.newPage();
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    let defaultCreates = 0;
    await page.goto("about:blank");
    await page.exposeFunction("__recordDefaultCreate", () => {
      defaultCreates++;
    });
    await page.addScriptTag({ type: "module", content: await readFile(fixture, "utf8") });
    await page.click('[data-testid="task-new-button"]');
    await page.locator('[aria-haspopup="menu"]').click();
    assert.equal(await page.getByText("worktree menu").isVisible(), true);
    assert.equal(defaultCreates, 1);
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
    await Promise.all([rm(fixture), rm(fixtureSource)]);
  }
});
