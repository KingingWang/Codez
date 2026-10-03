import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
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
    // 原生会话初始化使用隔离 QA 配置；地址不提供模型服务，测试不发送任何回合。
    const nativeHome = join(qaRoot, "home", ".codex");
    await mkdir(nativeHome, { recursive: true });
    await writeFile(
      join(nativeHome, "config.toml"),
      `model = "qa-no-turn"
model_provider = "qa-local"
[model_providers.qa-local]
name = "QA local - no model calls"
base_url = "http://127.0.0.1:9/v1"
wire_api = "responses"
requires_openai_auth = false
`,
    );
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
      const composer = page.locator('[contenteditable="true"][role="textbox"]').first();

      // 普通新建分支与工作树创建是两个入口。先分别取消一次，锁住菜单展开和
      // 普通分支入口都不会抢占草稿、增加标签页或改变工作区归属。
      const branchSwitcher = page.getByRole("button", { name: "切换 Git 分支", exact: true });
      const openBranchMenu = async () => {
        await branchSwitcher.click();
        await page.getByRole("button", { name: "创建并检出新分支...", exact: true }).waitFor();
        assert.deepEqual(await navigation(), before);
      };
      await openBranchMenu();
      await page.getByRole("button", { name: "创建并检出新分支...", exact: true }).click();
      const branchDialogText = await page.getByRole("dialog").innerText();
      assert.match(branchDialogText, /创建并检出新分支/);
      assert.doesNotMatch(branchDialogText, /保存位置|创建工作区/);
      await page.getByRole("button", { name: "取消", exact: true }).click();
      await page.getByRole("dialog").waitFor({ state: "hidden" });
      assert.deepEqual(await navigation(), before);
      assert.equal(await composer.innerText(), sourceDraft);

      const openCreation = async () => {
        await branchSwitcher.click();
        await page.getByRole("button", { name: "新建独立工作区（工作树）…", exact: true }).click();
        await page.getByRole("dialog").waitFor();
        assert.match(await page.getByRole("dialog").innerText(), /创建工作区/);
      };
      await openCreation();
      await page.getByRole("button", { name: "取消", exact: true }).click();
      await page.getByRole("dialog").waitFor({ state: "hidden" });
      assert.deepEqual(await navigation(), before);
      assert.equal(await composer.innerText(), sourceDraft);
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

      // 普通新建分支仍只改变当前目录的检出分支，不创建额外树或抢占草稿。
      const plainBranch = `qa/plain-${Date.now()}`;
      const treesBeforeBranch = await git(source, ["worktree", "list", "--porcelain"]);
      const beforeBranch = await navigation();
      await branchSwitcher.click();
      await page.getByRole("button", { name: "创建并检出新分支...", exact: true }).click();
      await page.locator("#git-branch-switcher-create-input").fill(plainBranch);
      await page.getByRole("button", { name: "创建并切换", exact: true }).click();
      await page.getByRole("dialog").waitFor({ state: "hidden" });
      assert.equal(await git(target, ["branch", "--show-current"]), plainBranch);
      assert.deepEqual(await navigation(), beforeBranch);
      assert.equal(await composer.innerText(), targetDraft);
      const treesAfterBranch = await git(source, ["worktree", "list", "--porcelain"]);
      assert.deepEqual(
        treesAfterBranch.match(/^worktree .+$/gm),
        treesBeforeBranch.match(/^worktree .+$/gm),
      );
      assert.deepEqual(errors, []);
    } finally {
      await browser.close();
    }
  },
);

test(
  "real empty session exposes worktree creation in its branch menu without model turns",
  { skip: !qaRoot, timeout: 30_000 },
  async () => {
    assert.match(qaRoot, /codez-worktree-qa-/);
    const browser = await chromium.connectOverCDP(cdp);
    try {
      const page = browser.contexts()[0].pages()[0];
      const moduleUrl = `/@fs${join(process.cwd(), "packages/ui/src/store/remoteWorkspaceSessionStore.ts")}`;
      const session = await page.evaluate(async (url) => {
        const { useRemoteWorkspaceSessionStore } = await import(url);
        const services = useRemoteWorkspaceSessionStore.getState().baseServices;
        const workspacePath = window.__codezTabStoreE2E.getState().activeWorkspacePath;
        const task = await services.codezTaskService.createTask({
          workspacePath,
          v4Create: true,
        });
        const store = window.__codezSessionStoreE2E.getState();
        store.upsertOptimisticTaskListItem(workspacePath, task);
        store.setActiveTaskId(workspacePath, task.taskId);
        return { workspacePath, taskId: task.taskId };
      }, moduleUrl);
      await page.getByRole("button", { name: "展开状态", exact: true }).click();
      await page.getByTestId("chat-summary-panel").waitFor();
      await page.getByRole("button", { name: "切换 Git 分支", exact: true }).click();
      await page.getByRole("button", { name: "新建独立工作区（工作树）…", exact: true }).click();
      await page.getByLabel("新分支名", { exact: true }).waitFor();
      await page.getByRole("button", { name: "取消", exact: true }).click();
      await page.getByRole("dialog").waitFor({ state: "hidden" });
      const after = await page.evaluate((path) => {
        return {
          workspacePath: window.__codezTabStoreE2E.getState().activeWorkspacePath,
          taskId: window.__codezSessionStoreE2E.getState().getWorkspaceState(path).activeTaskId,
        };
      }, session.workspacePath);
      assert.deepEqual(after, session);
    } finally {
      await browser.close();
    }
  },
);
