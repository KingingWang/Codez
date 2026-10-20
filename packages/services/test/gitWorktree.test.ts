import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { createGitCliRepo } from "../src/git/repo/gitCliRepo.js";

const execFileAsync = promisify(execFile);

async function git(cwd: string, args: string[]): Promise<void> {
  await execFileAsync(
    "git",
    ["-c", "user.email=test@example.com", "-c", "user.name=test", ...args],
    {
      cwd,
    },
  );
}

interface Fixture {
  root: string;
  mainTree: string;
  linkedTree: string;
  detachedTree: string;
  prunableTree: string;
}

// 真实 git 集成测试：锁定 specs/git-worktree-projects.md 阶段一的 Git 事实契约——
// common dir 跨树一致（分组原料）、分支占用可见、worktree 台账只读投影。

async function createFixture(t: test.TestContext): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), "codez-git-worktree-"));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const mainTree = join(root, "main");
  await mkdir(mainTree);
  await git(mainTree, ["init", "-q"]);
  await git(mainTree, ["commit", "-q", "--allow-empty", "-m", "init"]);
  await git(mainTree, ["branch", "feature-a"]);
  await git(mainTree, ["branch", "free-branch"]);

  // 路径带空格：porcelain 路径行整行即路径，解析不得截断。
  const linkedTree = join(root, "linked tree");
  await git(mainTree, ["worktree", "add", linkedTree, "feature-a", "-q"]);
  await git(mainTree, ["worktree", "lock", linkedTree, "--reason", "mounted later"]);

  const detachedTree = join(root, "detached-tree");
  await git(mainTree, ["worktree", "add", detachedTree, "--detach", "-q"]);

  const prunableTree = join(root, "prunable-tree");
  await git(mainTree, ["worktree", "add", prunableTree, "-b", "gone-branch", "-q"]);
  await rm(prunableTree, { recursive: true, force: true });

  return { root, mainTree, linkedTree, detachedTree, prunableTree };
}

function norm(path: string): string {
  return path.replace(/[\\/]+$/, "").replace(/\\/g, "/");
}

test("listWorktrees 投影 git 台账：主目录、锁定原因、detached、prunable", async (t) => {
  const fixture = await createFixture(t);
  const repo = createGitCliRepo();

  const result = await repo.listWorktrees(fixture.mainTree);
  assert.equal(result.isGitAvailable, true);
  assert.equal(result.isRepository, true);
  assert.equal(result.worktrees.length, 4);

  const byPath = new Map(result.worktrees.map((entry) => [entry.path, entry]));
  const main = result.worktrees[0]!;
  const linked = byPath.get(norm(fixture.linkedTree))!;
  const detached = byPath.get(norm(fixture.detachedTree))!;
  const prunable = byPath.get(norm(fixture.prunableTree))!;
  assert.equal(main.isMain, true);
  assert.equal(norm(fixture.mainTree), main.path);
  assert.ok(main.branchName, "主目录应检出某个分支");

  assert.equal(linked.isMain, false);
  assert.equal(linked.path, norm(fixture.linkedTree));
  assert.equal(linked.branchName, "feature-a");
  assert.equal(linked.isLocked, true);
  assert.equal(linked.lockReason, "mounted later");

  assert.equal(detached.isDetached, true);
  assert.equal(detached.branchName, null);

  assert.equal(prunable.isPrunable, true);
  assert.ok(prunable.prunableReason, "prunable 应携带原因");
});

test("common dir 跨工作树一致：分组 Git 事实成立", async (t) => {
  const fixture = await createFixture(t);
  const repo = createGitCliRepo();

  const mainStatus = await repo.getStatus(fixture.mainTree);
  const linkedStatus = await repo.getStatus(fixture.linkedTree);
  assert.ok(mainStatus.summary.gitCommonDir, "主目录应返回 common dir");
  assert.equal(linkedStatus.summary.gitCommonDir, mainStatus.summary.gitCommonDir);
  assert.ok(mainStatus.summary.gitCommonDir!.endsWith("/.git"));

  // 子目录 workspace 也必须归到同一个 common dir（子目录归组不改身份的前提）。
  const subdir = join(fixture.linkedTree, "sub");
  await mkdir(subdir);
  const subStatus = await repo.getStatus(subdir);
  assert.equal(subStatus.summary.gitCommonDir, mainStatus.summary.gitCommonDir);
});

test("分支列表携带检出位置：占用分支有路径，空闲分支为 null", async (t) => {
  const fixture = await createFixture(t);
  const repo = createGitCliRepo();

  const { branches } = await repo.listLocalBranches(fixture.mainTree);
  const featureA = branches.find((branch) => branch.name === "feature-a");
  const freeBranch = branches.find((branch) => branch.name === "free-branch");
  assert.ok(featureA);
  assert.equal(featureA!.worktreePath, norm(fixture.linkedTree));
  assert.ok(freeBranch);
  assert.equal(freeBranch!.worktreePath, null);

  // 主目录当前分支被主目录占用。
  const mainStatus = await repo.getStatus(fixture.mainTree);
  const current = branches.find((branch) => branch.name === mainStatus.summary.branchName);
  assert.ok(current);
  assert.equal(current!.worktreePath, norm(fixture.mainTree));
});

test("非仓库与缺失目录不产生错误，且不返回 common dir", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "codez-git-nonrepo-"));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });
  const repo = createGitCliRepo();

  const worktrees = await repo.listWorktrees(root);
  assert.equal(worktrees.isRepository, false);
  assert.deepEqual(worktrees.worktrees, []);

  const status = await repo.getStatus(root);
  assert.equal(status.summary.isRepository, false);
  assert.equal(status.summary.gitCommonDir ?? null, null);

  const missing = await repo.listWorktrees(join(root, "does-not-exist"));
  assert.equal(missing.isRepository, false);
  assert.deepEqual(missing.worktrees, []);
});

test("主目录经符号链接打开：common dir 仍与 linked tree 一致（评审 M1 回归）", async (t) => {
  const fixture = await createFixture(t);
  const link = join(fixture.root, "link-to-main");
  await symlink(fixture.mainTree, link, "dir");
  const repo = createGitCliRepo();

  const viaLink = await repo.getStatus(link);
  const viaTree = await repo.getStatus(fixture.linkedTree);
  assert.ok(viaLink.summary.gitCommonDir);
  assert.equal(viaLink.summary.gitCommonDir, viaTree.summary.gitCommonDir);
});

test("porcelain 边界：无原因 lock 与 bare 仓库（评审 L3）", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "codez-git-wt-edge-"));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });

  // 无 --reason 的 lock：porcelain 输出裸 "locked" 行。
  const main = join(root, "main");
  await mkdir(main);
  await git(main, ["init", "-q"]);
  await git(main, ["commit", "-q", "--allow-empty", "-m", "init"]);
  await git(main, ["worktree", "add", join(root, "locked-tree"), "-b", "locked-branch", "-q"]);
  await git(main, ["worktree", "lock", join(root, "locked-tree")]);

  const repo = createGitCliRepo();
  const result = await repo.listWorktrees(main);
  const locked = result.worktrees.find((entry) => entry.path.endsWith("locked-tree"));
  assert.ok(locked);
  assert.equal(locked!.isLocked, true);
  assert.equal(locked!.lockReason, null);

  // bare 仓库：无工作树，按非可用仓库降级，不抛错（R16）。
  const bare = join(root, "bare-repo");
  await mkdir(bare);
  await git(bare, ["init", "-q", "--bare"]);
  const bareResult = await repo.listWorktrees(bare);
  assert.equal(bareResult.isRepository, false);
  assert.deepEqual(bareResult.worktrees, []);
});
