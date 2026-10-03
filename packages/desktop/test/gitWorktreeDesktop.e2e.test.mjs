import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { chromium } from "playwright-core";

const run = promisify(execFile);
const qaRoot = process.env.CODEZ_WORKTREE_QA_ROOT;
const cdp = process.env.CODEZ_WORKTREE_QA_CDP || "http://127.0.0.1:9229";

// 仅连接显式指定的隔离 Dev 实例；不启动模型回合，不碰用户项目或真实配置。
test(
  "desktop worktree creation preserves default new task, source files and both drafts",
  {
    skip: !qaRoot,
    timeout: 90_000,
  },
  async () => {
    assert.match(qaRoot, /codez-worktree-qa-/);
    const source = join(qaRoot, "project");
    const git = async (cwd, args) => (await run("git", args, { cwd })).stdout.trim();
    const head = await git(source, ["rev-parse", "HEAD"]);
    const status = await git(source, ["status", "--porcelain"]);
    const branch = `qa/e2e-${Date.now()}`;
    const sourceDraft = `source ${branch}`;
    const targetDraft = `target ${branch}`;
    const browser = await chromium.connectOverCDP(cdp);
    try {
      const page = browser.contexts()[0].pages()[0];
      const errors = [];
      page.on("pageerror", (error) => errors.push(error.message));
      const url = new URL(page.url());
      url.searchParams.set("restoreSession", "false");
      url.searchParams.set("initialWorkspacePurpose", "project");
      url.searchParams.set("initialWorkspacePath", source);
      await page.goto(url.toString());
      await page.getByTestId("task-new-button").waitFor();
      await page.waitForFunction(() => Boolean(window.__codezTabStoreE2E));
      const navigation = () =>
        page.evaluate(() => {
          const state = window.__codezTabStoreE2E.getState();
          return {
            path: state.activeWorkspacePath,
            identity: state.activeWorkspaceIdentity,
            tabs: state.tabs.map((tab) => ({
              path: tab.workspacePath,
              identity: tab.workspaceIdentity,
            })),
          };
        });
      const before = await navigation();
      await page.getByTestId("task-new-button").click();
      assert.deepEqual(await navigation(), before);
      assert.equal(await page.getByRole("menu").count(), 0);
      await page.getByRole("textbox").first().fill(sourceDraft);
      const options = page.getByRole("button", { name: "新建会话选项", exact: true });
      const openCreation = async () => {
        await options.click();
        await page.getByRole("menuitem", { name: /^新的独立工作区/ }).waitFor();
        await page.waitForFunction(() => {
          const item = [...document.querySelectorAll('[role="menuitem"]')].find((entry) =>
            entry.textContent.startsWith("新的独立工作区"),
          );
          return item && !item.hasAttribute("data-disabled");
        });
        assert.deepEqual(await navigation(), before);
        await page.getByRole("menuitem", { name: "新的独立工作区", exact: true }).click();
        await page.getByRole("dialog").waitFor();
      };
      await openCreation();
      await page.getByRole("button", { name: "取消", exact: true }).click();
      assert.equal(await page.getByRole("textbox").first().innerText(), sourceDraft);
      await openCreation();
      await page.getByLabel("新分支名", { exact: true }).fill(branch);
      await page.waitForFunction(() => {
        const button = [...document.querySelectorAll("button")].find(
          (entry) => entry.textContent.trim() === "创建工作区",
        );
        return button && !button.disabled;
      });
      const target = await page.getByLabel("保存位置", { exact: true }).inputValue();
      assert.ok((await page.getByRole("dialog").innerText()).includes(head));
      assert.ok(target.startsWith(join(qaRoot, "project-worktrees")));
      await page.getByRole("button", { name: "创建工作区", exact: true }).click();
      await page.waitForFunction((path) => {
        return (
          window.__codezTabStoreE2E.getState().activeWorkspacePath === path &&
          !document.querySelector('[role="dialog"]')
        );
      }, target);
      assert.equal(await git(source, ["rev-parse", "HEAD"]), head);
      assert.equal(await git(source, ["status", "--porcelain"]), status);
      assert.equal(await git(target, ["branch", "--show-current"]), branch);
      await assert.rejects(access(join(target, ".env")));
      assert.equal(await readFile(join(target, "tracked.txt"), "utf8"), "base\n");
      await page.getByTestId("task-new-button").click();
      assert.equal((await navigation()).path, target);
      assert.equal(await page.getByRole("menu").count(), 0);
      await page.keyboard.press(process.platform === "darwin" ? "Meta+n" : "Control+n");
      assert.equal((await navigation()).path, target);
      assert.equal(await page.getByRole("menu").count(), 0);
      await page.getByRole("textbox").first().fill(targetDraft);
      const switchTo = async (path) => {
        await page
          .getByRole("button", { name: /独立工作区（基于 Git worktree）/ })
          .first()
          .click();
        const entry = page.getByRole("option").filter({ hasText: path });
        await (path === source ? entry.filter({ hasNotText: "project-worktrees" }) : entry).click();
        await page.waitForFunction((next) => {
          return window.__codezTabStoreE2E.getState().activeWorkspacePath === next;
        }, path);
      };
      await switchTo(source);
      assert.equal(await page.getByRole("textbox").first().innerText(), sourceDraft);
      await switchTo(target);
      assert.equal(await page.getByRole("textbox").first().innerText(), targetDraft);
      assert.deepEqual(errors, []);
    } finally {
      await browser.close();
    }
  },
);
