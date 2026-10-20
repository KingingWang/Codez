import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { chromium } from "playwright-core";
import {
  verifyEmptySessionWorktreeCreation,
  verifyWorktreeRemovalReleaseRetries,
} from "./gitWorktreeDesktop.helpers.mjs";

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
      await verifyEmptySessionWorktreeCreation(page);
    } finally {
      await browser.close();
    }
  },
);

// 删除闭环（specs/git-worktree-removal.md 验收 22-26、33-38）：行尾入口、阻塞门控、
// 脏树勾选、ignored 敏感配置关注区、占用分支阻塞、合并/未合并分支删除，均以真实
// Git 台账断言，不发送模型回合。
test(
  "worktree removal and branch deletion from the GUI mutate git state safely",
  { skip: !qaRoot, timeout: 180_000 },
  async () => {
    assert.match(qaRoot, /codez-worktree-qa-/);
    const source = join(qaRoot, "project");
    const git = async (cwd, args) => (await run("git", args, { cwd })).stdout.trim();
    const sourceBranch = await git(source, ["branch", "--show-current"]);
    const stamp = Date.now();
    const removalBranch = `qa/remove-${stamp}`;
    const dirtyBranch = `qa/dirty-${stamp}`;
    const unmergedBranch = `qa/unmerged-${stamp}`;
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

      const branchSwitcher = page.getByRole("button", { name: "切换 Git 分支", exact: true });
      const switcherTrigger = page
        .getByRole("button", { name: /独立工作区（基于 Git worktree）/ })
        .first();
      const optionFor = (path) => page.getByRole("option").filter({ hasText: path });
      const sourceOption = () =>
        page
          .getByRole("option")
          .filter({ hasText: source })
          .filter({ hasNotText: "project-worktrees" });
      const switchTo = async (path, option) => {
        await switcherTrigger.click();
        await option.waitFor();
        await option.click();
        await page.waitForFunction((next) => {
          return window.__codezTabStoreE2E.getState().activeWorkspacePath === next;
        }, path);
      };
      const createWorktree = async (branch) => {
        await branchSwitcher.click();
        await page.getByRole("button", { name: "新建独立工作区（工作树）…", exact: true }).click();
        await page.getByRole("dialog").waitFor();
        await page.getByLabel("新分支名", { exact: true }).fill(branch);
        await page.waitForFunction(() => {
          const button = [...document.querySelectorAll("button")].find(
            (entry) => entry.textContent.trim() === "创建工作区",
          );
          return button && !button.disabled;
        });
        const target = await page.getByLabel("保存位置", { exact: true }).inputValue();
        await page.getByRole("button", { name: "创建工作区", exact: true }).click();
        await page.waitForFunction((path) => {
          return (
            window.__codezTabStoreE2E.getState().activeWorkspacePath === path &&
            !document.querySelector('[role="dialog"]')
          );
        }, target);
        return target;
      };

      // IA3：分支菜单收敛为纯分支操作，不再出现「打开已有工作区…」。
      await branchSwitcher.click();
      await page.getByRole("button", { name: "创建并检出新分支...", exact: true }).waitFor();
      assert.equal(await page.getByRole("button", { name: /打开已有工作区/ }).count(), 0);
      await page.keyboard.press("Escape");
      await page.getByRole("button", { name: "创建并检出新分支...", exact: true }).waitFor({
        state: "hidden",
      });

      // 场景 22 前置：创建干净工作树 wt1。
      const wt1 = await createWorktree(removalBranch);
      assert.equal(await git(wt1, ["branch", "--show-current"]), removalBranch);

      // 场景 25：删除当前工作区 → 阻塞态，不渲染确认按钮，不发生 git 写操作。
      await switcherTrigger.click();
      await optionFor(wt1).waitFor();
      await optionFor(wt1).getByRole("button", { name: "删除独立工作区…", exact: true }).click();
      const blockedDialog = page.getByRole("dialog");
      await blockedDialog.waitFor();
      await blockedDialog.getByText(/正在使用的工作区/).waitFor();
      assert.equal(
        await blockedDialog.getByRole("button", { name: "永久删除该目录", exact: true }).count(),
        0,
      );
      await blockedDialog.getByRole("button", { name: "取消", exact: true }).click();
      await blockedDialog.waitFor({ state: "hidden" });
      await access(wt1);

      // IA4：切换器底部「新的独立工作区」与分支菜单入口打开同一个创建对话框。
      await switcherTrigger.click();
      await page.getByRole("button", { name: "新的独立工作区", exact: true }).click();
      const createDialog = page.getByRole("dialog");
      await createDialog.waitFor();
      assert.match(await createDialog.innerText(), /创建工作区/);
      await createDialog.getByRole("button", { name: "取消", exact: true }).click();
      await createDialog.waitFor({ state: "hidden" });

      // 切回主目录：场景 36（当前分支无删除图标）+ 场景 35（占用分支阻塞）。
      await switchTo(source, sourceOption());
      await branchSwitcher.click();
      await page.getByRole("button", { name: "创建并检出新分支...", exact: true }).waitFor();
      assert.equal(
        await page.getByRole("button", { name: `删除分支 ${sourceBranch}…`, exact: true }).count(),
        0,
      );
      await page.getByRole("button", { name: `删除分支 ${removalBranch}…`, exact: true }).click();
      const occupiedDialog = page.getByRole("dialog");
      await occupiedDialog.waitFor();
      await occupiedDialog.getByText(/正被 .* 检出/).waitFor();
      assert.match(await occupiedDialog.innerText(), /跳转到该工作区/);
      assert.equal(
        await occupiedDialog.getByRole("button", { name: "删除分支", exact: true }).count(),
        0,
      );
      await occupiedDialog.getByRole("button", { name: "取消", exact: true }).click();
      await occupiedDialog.waitFor({ state: "hidden" });
      assert.notEqual(await git(source, ["branch", "--list", removalBranch]), "");

      // 场景 23/24 前置：创建脏工作树 wt2，写入已跟踪修改、未跟踪文件与 ignored 敏感配置。
      const wt2 = await createWorktree(dirtyBranch);
      await writeFile(join(wt2, "tracked.txt"), "base\ndirty\n");
      await writeFile(join(wt2, "dirty.txt"), "dirty\n");
      await writeFile(join(wt2, ".env"), "SECRET=qa\n");
      await switchTo(source, sourceOption());

      // 脏树删除：清单 + 敏感配置关注区；未勾选不可确认，勾选后删除成功。
      await switcherTrigger.click();
      await optionFor(wt2).waitFor();
      await optionFor(wt2).getByRole("button", { name: "删除独立工作区…", exact: true }).click();
      const dirtyDialog = page.getByRole("dialog");
      await dirtyDialog.waitFor();
      await dirtyDialog.getByText(/将被丢弃的改动/).waitFor();
      await dirtyDialog.getByText(/需要关注的本地配置/).waitFor();
      assert.match(await dirtyDialog.innerText(), /\.env/);
      const dirtyConfirm = dirtyDialog.getByRole("button", {
        name: "永久删除该目录",
        exact: true,
      });
      assert.equal(await dirtyConfirm.isDisabled(), true);
      await dirtyDialog.getByRole("checkbox", { name: /将被永久丢弃/ }).click();
      assert.equal(await dirtyConfirm.isDisabled(), false);
      await dirtyConfirm.click();
      await dirtyDialog.waitFor({ state: "hidden" });
      await assert.rejects(access(wt2));
      assert.equal(await git(source, ["branch", "--list", dirtyBranch]), dirtyBranch);

      // 场景 22：干净工作树删除，目录移除、台账刷新、分支保留。
      await switcherTrigger.click();
      await optionFor(wt1).waitFor();
      await optionFor(wt1).getByRole("button", { name: "删除独立工作区…", exact: true }).click();
      const cleanDialog = page.getByRole("dialog");
      await cleanDialog.waitFor();
      const cleanConfirm = cleanDialog.getByRole("button", {
        name: "永久删除该目录",
        exact: true,
      });
      await cleanConfirm.waitFor();
      assert.equal(await cleanConfirm.isDisabled(), false);
      // 验收 29：用隔离实例的服务代理注入释放失败，真实 hook 重试仍须再次释放，
      // 不允许先关 tab 后把第二次确认误当成“没有运行时可释放”。
      await verifyWorktreeRemovalReleaseRetries({
        page,
        dialog: cleanDialog,
        confirm: cleanConfirm,
        targetPath: wt1,
      });
      await assert.rejects(access(wt1));
      const trees = await git(source, ["worktree", "list", "--porcelain"]);
      // 用例一创建的工作树仍登记在册，这里只断言本次删除的两棵目标已移除。
      assert.ok(!trees.includes(`worktree ${wt1}\n`) && !trees.endsWith(`worktree ${wt1}`));
      assert.ok(!trees.includes(`worktree ${wt2}\n`) && !trees.endsWith(`worktree ${wt2}`));
      assert.equal(await git(source, ["branch", "--list", removalBranch]), removalBranch);

      // 场景 33：空闲已合并分支删除（wt1 删除后 removalBranch 已空闲且已合并）。
      await branchSwitcher.click();
      await page.getByRole("button", { name: "创建并检出新分支...", exact: true }).waitFor();
      await page.getByRole("button", { name: `删除分支 ${removalBranch}…`, exact: true }).click();
      const mergedDialog = page.getByRole("dialog");
      await mergedDialog.waitFor();
      await mergedDialog.getByText("已合并", { exact: true }).waitFor();
      const mergedConfirm = mergedDialog.getByRole("button", { name: "删除分支", exact: true });
      assert.equal(await mergedConfirm.isDisabled(), false);
      await mergedConfirm.click();
      await mergedDialog.waitFor({ state: "hidden" });
      assert.equal(await git(source, ["branch", "--list", removalBranch]), "");

      // 场景 34：未合并分支删除，未勾选不可确认，勾选后强删成功且提交对象保留。
      const headTree = await git(source, ["rev-parse", "HEAD^{tree}"]);
      const head = await git(source, ["rev-parse", "HEAD"]);
      const unmergedCommit = (
        await run("git", ["commit-tree", headTree, "-p", head, "-m", "unmerged"], {
          cwd: source,
        })
      ).stdout.trim();
      await git(source, ["update-ref", `refs/heads/${unmergedBranch}`, unmergedCommit]);
      await branchSwitcher.click();
      await page.getByRole("button", { name: `删除分支 ${unmergedBranch}…`, exact: true }).click();
      const unmergedDialog = page.getByRole("dialog");
      await unmergedDialog.waitFor();
      await unmergedDialog.getByText("包含未合并提交", { exact: true }).waitFor();
      const unmergedConfirm = unmergedDialog.getByRole("button", {
        name: "删除分支",
        exact: true,
      });
      assert.equal(await unmergedConfirm.isDisabled(), true);
      await unmergedDialog
        .getByRole("checkbox", { name: "我已知晓未合并提交将从分支引用中移除", exact: true })
        .click();
      assert.equal(await unmergedConfirm.isDisabled(), false);
      await unmergedConfirm.click();
      await unmergedDialog.waitFor({ state: "hidden" });
      assert.equal(await git(source, ["branch", "--list", unmergedBranch]), "");
      assert.equal(await git(source, ["cat-file", "-t", unmergedCommit]), "commit");
      assert.equal(await git(source, ["status", "--porcelain"]), "");
      assert.deepEqual(errors, []);
    } finally {
      await browser.close();
    }
  },
);
