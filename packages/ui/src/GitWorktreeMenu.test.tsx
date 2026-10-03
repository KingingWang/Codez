import assert from "node:assert/strict";
import { execFile as nodeExecFile } from "node:child_process";
import { readFile, rm, writeFile } from "node:fs/promises";
import test from "node:test";
import { promisify } from "node:util";
import { renderToStaticMarkup } from "react-dom/server";
import { CodezIntlProvider } from "@/i18n/IntlProvider.js";
import {
  GitWorktreeMenuActions,
  GitWorktreeMenuProvider,
  type GitWorktreeMenuValue,
} from "./GitWorktreeMenu.js";

const execFile = promisify(nodeExecFile);
const value: GitWorktreeMenuValue = {
  workspacePath: "/project",
  workspaceIdentity: "remote-a",
  entries: [],
  allowOpenWorkspace: true,
  onCreate: () => {},
  onOpenEntry: () => {},
  onRefresh: () => {},
};

function renderActions(params: {
  value?: GitWorktreeMenuValue;
  workspacePath?: string;
  workspaceIdentity?: string;
}) {
  return renderToStaticMarkup(
    <CodezIntlProvider initialLocale="zh-CN">
      <GitWorktreeMenuProvider value={params.value ?? value}>
        <GitWorktreeMenuActions
          workspacePath={params.workspacePath ?? "/project"}
          workspaceIdentity={params.workspaceIdentity ?? "remote-a"}
          onBeforeAction={() => {}}
        />
      </GitWorktreeMenuProvider>
    </CodezIntlProvider>,
  );
}

test("分支菜单直接展示创建和打开工作树，创建入口不嵌套在普通分支弹窗", () => {
  const html = renderActions({});
  assert.match(html, /新建独立工作区（工作树）…/);
  assert.match(html, /打开已有工作区…/);
  assert.doesNotMatch(html, /当前工作区|新建任务/);
});

test("不匹配的路径或远端身份不借用当前工作区的操作", () => {
  assert.equal(renderActions({ workspaceIdentity: "remote-b" }), "");
  assert.equal(renderActions({ workspacePath: "/other" }), "");
  assert.equal(renderActions({ workspaceIdentity: "" }), "");
  assert.match(
    renderActions({
      value: { ...value, workspaceIdentity: undefined },
      workspaceIdentity: "",
    }),
    /新建独立工作区/,
  );
});

test("创建不可用时仍显示原因，已有工作区入口不被一并禁用", () => {
  const html = renderActions({
    value: { ...value, disabledReason: "当前连接不支持创建工作树" },
  });
  assert.match(html, /<button[^>]*disabled=""[^>]*>.*新建独立工作区/s);
  assert.match(html, /当前连接不支持创建工作树/);
  const existingTrigger = html.match(/<button[^>]*aria-haspopup="menu"[^>]*>/)?.[0];
  assert.ok(existingTrigger);
  assert.doesNotMatch(existingTrigger, /\sdisabled=/);
});

test("无 shell 控制器时不提供工作树写入入口", () => {
  const html = renderToStaticMarkup(
    <CodezIntlProvider initialLocale="zh-CN">
      <GitWorktreeMenuActions workspacePath="/project" onBeforeAction={() => {}} />
    </CodezIntlProvider>,
  );
  assert.equal(html, "");
});

test("创建先关闭分支菜单；只读展开不创建，手机仅能切回已打开条目", async () => {
  const source = `/tmp/git-worktree-menu-${process.pid}.tsx`;
  const bundle = `/tmp/git-worktree-menu-${process.pid}.mjs`;
  await writeFile(
    source,
    `
      import { createRoot } from "react-dom/client";
      import { CodezIntlProvider } from "@/i18n/IntlProvider.js";
      import { GitWorktreeMenuActions, GitWorktreeMenuProvider } from "@/GitWorktreeMenu.js";
      createRoot(document.body).render(
        <CodezIntlProvider initialLocale="zh-CN">
          <GitWorktreeMenuProvider value={{
            workspacePath: "/project",
            entries: [
              { path: "/opened", branchName: "opened", isOpen: true },
              { path: "/unopened", branchName: "unopened", isOpen: false },
            ],
            allowOpenWorkspace: false,
            onCreate: () => window.__record?.("create"),
            onOpenEntry: (entry) => window.__record?.("open:" + entry.path),
            onRefresh: () => window.__record?.("refresh"),
          }}>
            <GitWorktreeMenuActions
              workspacePath="/project"
              onBeforeAction={() => window.__record?.("close")}
            />
          </GitWorktreeMenuProvider>
        </CodezIntlProvider>,
      );
    `,
  );
  const { chromium } = await import("playwright-core");
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  try {
    await execFile("node_modules/.bin/esbuild", [
      source,
      "--bundle",
      `--outfile=${bundle}`,
      "--format=esm",
      "--platform=browser",
      "--jsx=automatic",
      "--tsconfig=packages/ui/tsconfig.json",
      "--alias:react=react",
      "--alias:react-dom=react-dom",
      `--define:process.env.NODE_ENV="production"`,
    ]);
    browser = await chromium.launch({ executablePath: "/usr/bin/google-chrome" });
    const page = await browser.newPage();
    const actions: string[] = [];
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.exposeFunction("__record", (action: string) => actions.push(action));
    await page.goto("about:blank");
    await page.addScriptTag({ type: "module", content: await readFile(bundle, "utf8") });
    await page.getByRole("button", { name: "新建独立工作区（工作树）…", exact: true }).click();
    await page.waitForFunction(() => Boolean(document.querySelector("button")));
    assert.deepEqual(actions, ["close", "create"]);
    await page.getByRole("button", { name: "打开已有工作区…", exact: true }).click();
    const unavailable = page.getByRole("menuitem").filter({ hasText: "unopened" });
    await unavailable.waitFor();
    assert.equal(await unavailable.getAttribute("data-disabled"), "");
    assert.deepEqual(actions, ["close", "create"]);
    await page
      .getByRole("menuitem")
      .filter({ hasText: "opened" })
      .filter({ hasNotText: "unopened" })
      .click();
    await page.waitForFunction(() => !document.querySelector('[role="menu"]'));
    assert.deepEqual(actions, ["close", "create", "close", "open:/opened"]);
    assert.deepEqual(errors, []);
  } finally {
    await browser?.close();
    await Promise.all([rm(source, { force: true }), rm(bundle, { force: true })]);
  }
});
