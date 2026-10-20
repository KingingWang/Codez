import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import type { GitBranchDeletePreview } from "@codez/shared";
import { createGitCliRepo } from "../src/git/repo/gitCliRepo.js";
import { createGitBranchDeletionHelper } from "../src/git/repo/gitBranchDeletion.js";
import { createGitCommandProvider } from "../src/git/providers/gitCommandProvider.js";

const execFileAsync = promisify(execFile);

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync(
    "git",
    ["-c", "user.email=test@example.com", "-c", "user.name=test", ...args],
    { cwd },
  );
  return stdout;
}

async function commit(cwd: string, message: string): Promise<string> {
  const file = message.toLowerCase().replace(/[^a-z0-9]+/g, "-");
  await writeFile(join(cwd, `${file}.txt`), `${message}\n`);
  await git(cwd, ["add", "."]);
  await git(cwd, ["commit", "-q", "-m", message]);
  return (await git(cwd, ["rev-parse", "HEAD"])).trim();
}

async function createFixture(t: test.TestContext) {
  const root = await mkdtemp(join(tmpdir(), "codez-git-branch-delete-"));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });
  const mainTree = join(root, "source repo");
  await mkdir(mainTree);
  await git(mainTree, ["init", "-q", "--initial-branch=main"]);
  await commit(mainTree, "base");
  return { root, mainTree };
}

function createHelper(t: test.TestContext) {
  const repo = createGitCliRepo();
  let invalidated = 0;
  const helper = createGitBranchDeletionHelper({
    commandProvider: createGitCommandProvider(),
    resolveRepository: repo.resolveRepository,
    invalidateRepository(workspacePath) {
      invalidated += 1;
      repo.invalidate(workspacePath);
    },
  });
  assert.ok(t.assert);
  return {
    repo,
    helper,
    get invalidated() {
      return invalidated;
    },
  };
}

function issue(error: unknown): {
  code?: string;
  message?: string;
  latestPreview?: GitBranchDeletePreview;
} {
  assert.ok(error instanceof Error);
  const issueData = (error as { data?: unknown }).data;
  assert.ok(typeof issueData === "object" && issueData !== null);
  return issueData as { code?: string; message?: string; latestPreview?: GitBranchDeletePreview };
}

test("preview and safe delete use configured upstream as merge base", async (t) => {
  const { mainTree } = await createFixture(t);
  const base = (await git(mainTree, ["rev-parse", "HEAD"])).trim();
  await git(mainTree, ["remote", "add", "origin", "https://example.invalid/codez.git"]);
  await git(mainTree, ["branch", "safe"]);
  await git(mainTree, ["config", "branch.safe.remote", "origin"]);
  await git(mainTree, ["config", "branch.safe.merge", "refs/heads/main"]);
  await git(mainTree, ["update-ref", "refs/remotes/origin/main", base]);
  const harness = createHelper(t);
  const helper = harness.helper;

  const preview = await helper.preview({ workspacePath: mainTree, branchName: "safe" });
  assert.deepEqual(preview, {
    branchName: "safe",
    isCurrent: false,
    checkedOutPath: null,
    isMerged: true,
    commitHash: base,
    commitSubject: "base",
    upstreamName: "origin/main",
  });
  const result = await helper.delete({
    workspacePath: mainTree,
    branchName: "safe",
    force: false,
    expectedCommitHash: base,
  });
  assert.deepEqual(result, { deleted: true, configCleanupSucceeded: true });
  await assert.rejects(() => git(mainTree, ["config", "--get", "branch.safe.remote"]));
  await assert.rejects(
    () => git(mainTree, ["show-ref", "--verify", "refs/heads/safe"]),
    /not a valid ref/,
  );
  assert.equal(harness.invalidated, 1);
});

test("safe delete uses initiating worktree HEAD without upstream", async (t) => {
  const { mainTree } = await createFixture(t);
  const base = (await git(mainTree, ["rev-parse", "HEAD"])).trim();
  await git(mainTree, ["branch", "safe-head"]);
  const { helper } = createHelper(t);
  const preview = await helper.preview({ workspacePath: mainTree, branchName: "safe-head" });
  assert.equal(preview.upstreamName, null);
  assert.equal(preview.isMerged, true);
  const result = await helper.delete({
    workspacePath: mainTree,
    branchName: "safe-head",
    force: false,
    expectedCommitHash: base,
  });
  assert.equal(result.deleted, true);
});

test("current and other-worktree branches are blocked without deletion", async (t) => {
  const { root, mainTree } = await createFixture(t);
  await git(mainTree, ["branch", "occupied"]);
  await git(mainTree, ["worktree", "add", "-q", join(root, "occupied tree"), "occupied"]);
  const { helper } = createHelper(t);

  await assert.rejects(
    () =>
      helper.delete({
        workspacePath: mainTree,
        branchName: "main",
        force: true,
        expectedCommitHash: "0".repeat(40),
      }),
    (error: unknown) => issue(error).code === "branch-is-current",
  );
  const preview = await helper.preview({ workspacePath: mainTree, branchName: "occupied" });
  assert.ok(preview.checkedOutPath);
  await assert.rejects(
    () =>
      helper.delete({
        workspacePath: mainTree,
        branchName: "occupied",
        force: true,
        expectedCommitHash: preview.commitHash,
      }),
    (error: unknown) => issue(error).code === "branch-checked-out",
  );
  assert.match(await git(mainTree, ["show-ref", "refs/heads/occupied"]), /refs\/heads\/occupied/);
});

test("invalid names, missing branches, malformed OIDs, and force type are rejected", async (t) => {
  const { mainTree } = await createFixture(t);
  const { helper } = createHelper(t);
  const cases = [
    ["../escape", "invalid-branch-name"],
    ["main\nx", "invalid-branch-name"],
    [" main", "invalid-branch-name"],
    ["missing", "branch-not-found"],
  ] as const;
  for (const [branchName, code] of cases) {
    await assert.rejects(
      () => helper.preview({ workspacePath: mainTree, branchName }),
      (error: unknown) => issue(error).code === code,
    );
  }
  const request = {
    workspacePath: mainTree,
    branchName: "main",
    force: true,
    expectedCommitHash: "short",
  };
  await assert.rejects(
    () => helper.delete(request),
    (error: unknown) =>
      issue(error).code === "unknown" && /complete/.test(issue(error).message ?? ""),
  );
  await assert.rejects(
    () => helper.delete({ ...request, expectedCommitHash: ` ${"0".repeat(40)}` }),
    (error: unknown) =>
      issue(error).code === "unknown" && /complete/.test(issue(error).message ?? ""),
  );
  await assert.rejects(
    () =>
      helper.delete({
        ...request,
        expectedCommitHash: "0".repeat(40),
        force: 1 as unknown as boolean,
      }),
    (error: unknown) =>
      issue(error).code === "unknown" && /boolean/.test(issue(error).message ?? ""),
  );
});

test("unmerged branch requires force and delete uses update-ref CAS", async (t) => {
  const { mainTree } = await createFixture(t);
  await git(mainTree, ["branch", "unmerged"]);
  await git(mainTree, ["checkout", "-q", "unmerged"]);
  const branchHead = await commit(mainTree, "unique");
  await git(mainTree, ["checkout", "-q", "main"]);
  const { helper } = createHelper(t);
  const preview = await helper.preview({ workspacePath: mainTree, branchName: "unmerged" });
  assert.equal(preview.isMerged, false);
  await assert.rejects(
    () =>
      helper.delete({
        workspacePath: mainTree,
        branchName: "unmerged",
        force: false,
        expectedCommitHash: branchHead,
      }),
    (error: unknown) => issue(error).code === "branch-not-merged",
  );
  assert.equal(
    (
      await helper.delete({
        workspacePath: mainTree,
        branchName: "unmerged",
        force: true,
        expectedCommitHash: branchHead,
      })
    ).deleted,
    true,
  );
  await assert.rejects(
    () => git(mainTree, ["show-ref", "--verify", "refs/heads/unmerged"]),
    /not a valid ref/,
  );
});

test("external movement and CAS-race movement are mapped to branch-moved with fresh preview", async (t) => {
  const { mainTree } = await createFixture(t);
  await git(mainTree, ["branch", "racy"]);
  await git(mainTree, ["checkout", "-q", "racy"]);
  const oldHead = await commit(mainTree, "racy-base");
  const newHead = await commit(mainTree, "racy-next");
  await git(mainTree, ["checkout", "-q", "main"]);
  await git(mainTree, ["update-ref", "refs/remotes/origin/main", newHead]);
  await git(mainTree, ["config", "branch.racy.remote", "origin"]);
  await git(mainTree, ["config", "branch.racy.merge", "refs/heads/main"]);
  const { helper } = createHelper(t);
  const latest = await helper.preview({ workspacePath: mainTree, branchName: "racy" });
  assert.equal(latest.commitHash, newHead);
  await assert.rejects(
    () =>
      helper.delete({
        workspacePath: mainTree,
        branchName: "racy",
        force: false,
        expectedCommitHash: oldHead,
      }),
    (error: unknown) => {
      const data = issue(error);
      return data.code === "branch-moved" && data.latestPreview?.commitHash === newHead;
    },
  );

  let raceInjected = false;
  const baseProvider = createGitCommandProvider();
  const racingHelper = createGitBranchDeletionHelper({
    commandProvider: {
      ...baseProvider,
      async run(command) {
        if (command.args[0] === "update-ref" && !raceInjected) {
          raceInjected = true;
          await git(mainTree, ["update-ref", "refs/heads/racy", newHead]);
        }
        return await baseProvider.run(command);
      },
    },
    resolveRepository: createGitCliRepo().resolveRepository,
    invalidateRepository: () => {},
  });
  // CAS 请求仍旧携带旧值，provider 在命令执行前让外部进程推进分支。
  await assert.rejects(
    () =>
      racingHelper.delete({
        workspacePath: mainTree,
        branchName: "racy",
        force: true,
        expectedCommitHash: oldHead,
      }),
    (error: unknown) => issue(error).code === "branch-moved",
  );
  assert.match(await git(mainTree, ["show-ref", "refs/heads/racy"]), /refs\/heads\/racy/);
});

test("absent config section counts as clean", async (t) => {
  const { mainTree } = await createFixture(t);
  const head = (await git(mainTree, ["rev-parse", "HEAD"])).trim();
  await git(mainTree, ["branch", "absent-config"]);
  const repo = createGitCliRepo();
  const helper = createGitBranchDeletionHelper({
    commandProvider: createGitCommandProvider(),
    resolveRepository: repo.resolveRepository,
    invalidateRepository: repo.invalidate,
  });
  const result = await helper.delete({
    workspacePath: mainTree,
    branchName: "absent-config",
    force: false,
    expectedCommitHash: head,
  });
  assert.equal(result.configCleanupSucceeded, true);
});

test("cleanup provider throw, timeout, and truncation do not turn deletion into failure", async (t) => {
  const { mainTree } = await createFixture(t);
  const head = (await git(mainTree, ["rev-parse", "HEAD"])).trim();
  const branches = ["cleanup-throw", "cleanup-timeout", "cleanup-truncated"];
  for (const branchName of branches) await git(mainTree, ["branch", branchName]);
  const baseProvider = createGitCommandProvider();
  const failures = new Map([
    ["cleanup-throw", "throw" as const],
    ["cleanup-timeout", "timeout" as const],
    ["cleanup-truncated", "truncate" as const],
  ]);
  const repo = createGitCliRepo();
  const helper = createGitBranchDeletionHelper({
    commandProvider: {
      ...baseProvider,
      async run(command) {
        if (command.args[0] !== "config" || command.args[1] !== "--remove-section") {
          return await baseProvider.run(command);
        }
        const branchName = command.args[2]?.slice("branch.".length) ?? "";
        const failure = failures.get(branchName);
        if (failure === "throw") throw new Error("simulated provider crash");
        const result = await baseProvider.run(command);
        if (failure === "timeout") return { ...result, timedOut: true };
        return { ...result, outputTruncated: true };
      },
    },
    resolveRepository: repo.resolveRepository,
    invalidateRepository: repo.invalidate,
  });
  for (const branchName of branches) {
    const result = await helper.delete({
      workspacePath: mainTree,
      branchName,
      force: false,
      expectedCommitHash: head,
    });
    assert.deepEqual(result, { deleted: true, configCleanupSucceeded: false });
  }
});

test("config cleanup failure is best-effort after deletion", async (t) => {
  const { mainTree } = await createFixture(t);
  const head = (await git(mainTree, ["rev-parse", "HEAD"])).trim();
  await git(mainTree, ["branch", "cleanup"]);
  await git(mainTree, ["config", "branch.cleanup.remote", "origin"]);
  const configPath = join(mainTree, ".git", "config");
  await chmod(configPath, 0o444);
  const baseProvider = createGitCommandProvider();
  const helper = createGitBranchDeletionHelper({
    commandProvider: {
      ...baseProvider,
      async run(command) {
        if (command.args[0] === "config" && command.args[1] === "--remove-section") {
          return {
            ...(await baseProvider.run(command)),
            exitCode: 5,
            stderr: "simulated config cleanup failure",
          };
        }
        return await baseProvider.run(command);
      },
    },
    resolveRepository: createGitCliRepo().resolveRepository,
    invalidateRepository: () => {},
  });
  try {
    const result = await helper.delete({
      workspacePath: mainTree,
      branchName: "cleanup",
      force: false,
      expectedCommitHash: head,
    });
    assert.deepEqual(result, { deleted: true, configCleanupSucceeded: false });
    await assert.rejects(
      () => git(mainTree, ["show-ref", "--verify", "refs/heads/cleanup"]),
      /not a valid ref/,
    );
  } finally {
    await chmod(configPath, 0o644);
  }
});
