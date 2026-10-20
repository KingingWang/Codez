import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { createGitCliRepo } from "../src/git/repo/gitCliRepo.js";
import { createGitCommandProvider } from "../src/git/providers/gitCommandProvider.js";
import { createGitWorktreeCreationHelper } from "../src/git/repo/gitWorktreeCreation.js";
import { createGitService } from "../src/git/gitService.js";

const execFileAsync = promisify(execFile);

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync(
    "git",
    ["-c", "user.email=test@example.com", "-c", "user.name=test", ...args],
    { cwd },
  );
  return stdout;
}

async function createFixture(t: test.TestContext) {
  const root = await mkdtemp(join(tmpdir(), "codez-git-worktree-create-"));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const mainTree = join(root, "source repo");
  await mkdir(mainTree);
  await git(mainTree, ["init", "-q"]);
  await writeFile(join(mainTree, "tracked.txt"), "base\n");
  await git(mainTree, ["add", "."]);
  await git(mainTree, ["commit", "-q", "-m", "base"]);
  await git(mainTree, ["branch", "free-branch"]);
  await git(mainTree, ["worktree", "add", join(root, "occupied tree"), "free-branch", "-q"]);
  await writeFile(join(mainTree, "dirty.txt"), "uncommitted\n");

  return { root, mainTree, occupiedTree: join(root, "occupied tree") };
}

function norm(path: string): string {
  return path.replace(/[\\/]+$/, "").replace(/\\/g, "/");
}

async function readStatus(cwd: string): Promise<string> {
  return await git(cwd, ["status", "--porcelain"]);
}

test("new-branch preview/create resolves tree facts and preserves source dirty files", async (t) => {
  const { mainTree } = await createFixture(t);
  const repo = createGitCliRepo();
  const before = await readStatus(mainTree);
  const workspaceSubdir = join(mainTree, "nested dir");
  await mkdir(workspaceSubdir, { recursive: true });

  const preview = await repo.previewWorktreeCreation({
    workspacePath: workspaceSubdir,
    operationId: "019778d0-7c68-7ac0-91aa-38d945cd1111",
    mode: "new-branch",
    branchName: "feature/new-branch",
  });

  assert.equal(preview.repoRoot, norm(mainTree));
  assert.ok(preview.gitCommonDir.endsWith("/.git"));
  assert.equal(preview.startPoint, "HEAD");
  assert.match(preview.baselineCommit, /^[0-9a-f]{40}$/);
  assert.equal(
    preview.targetPath.includes("source repo-worktrees/feature-new-branch-019778d0"),
    true,
  );
  assert.equal(typeof preview.sourceBranchName, "string");
  assert.equal(preview.occupiedPath, null);

  const result = await repo.createWorktree({
    ...preview,
    operationId: "019778d0-7c68-7ac0-91aa-38d945cd1111",
  });
  assert.equal(result.created, true);
  assert.equal(await readFile(join(result.workspacePath, "tracked.txt"), "utf8"), "base\n");
  await assert.rejects(() => readFile(join(result.workspacePath, "dirty.txt"), "utf8"), /ENOENT/);
  assert.equal(await readStatus(mainTree), before);
  assert.equal(
    (await git(result.workspacePath, ["branch", "--show-current"])).trim(),
    "feature/new-branch",
  );

  const operations = await readdir(join(preview.gitCommonDir, "codez/worktree-operations"));
  assert.equal(operations.length, 1);
  const record = JSON.parse(
    await readFile(join(preview.gitCommonDir, "codez/worktree-operations", operations[0]!), "utf8"),
  );
  assert.equal(record.operationId, "019778d0-7c68-7ac0-91aa-38d945cd1111");
  assert.equal(record.targetPath, result.workspacePath);
});

test("existing-branch mode uses branch, detects occupied branch, and supports custom absolute path", async (t) => {
  const { mainTree, occupiedTree } = await createFixture(t);
  const repo = createGitCliRepo();

  const occupied = await repo.previewWorktreeCreation({
    workspacePath: mainTree,
    operationId: "019778d0-7c68-7ac0-91aa-38d945cd2222",
    mode: "existing-branch",
    branchName: "free-branch",
  });
  assert.equal(occupied.startPoint, "free-branch");
  assert.equal(occupied.occupiedPath, norm(occupiedTree));

  await git(mainTree, ["branch", "another-branch"]);
  const target = join(mainTree, "..", "target tree");
  const operationId = "019778d0-7c68-7ac0-91aa-38d945cd3333";
  const preview = await repo.previewWorktreeCreation({
    workspacePath: mainTree,
    operationId,
    mode: "existing-branch",
    branchName: "another-branch",
    targetPath: target,
  });
  assert.equal(preview.targetPath, norm(target));
  const created = await repo.createWorktree({ ...preview, operationId });
  assert.equal(created.created, true);
});

test("custom paths through a sibling symlink are canonicalized before confirmation", async (t) => {
  const { mainTree, root } = await createFixture(t);
  const physicalParent = join(root, "physical worktrees");
  const alias = join(root, "alias worktrees");
  await mkdir(physicalParent);
  await symlink(physicalParent, alias, process.platform === "win32" ? "junction" : "dir");
  const repo = createGitCliRepo();
  const preview = await repo.previewWorktreeCreation({
    workspacePath: mainTree,
    operationId: "symlink-target-operation",
    mode: "new-branch",
    branchName: "feature/symlink-target",
    targetPath: join(alias, "tree"),
  });
  assert.equal(preview.targetPath, norm(join(await realpath(physicalParent), "tree")));
  const result = await repo.createWorktree({ ...preview, operationId: "symlink-target-operation" });
  assert.equal(result.workspacePath, preview.targetPath);
  const list = await repo.listWorktrees(mainTree);
  assert.ok(list.worktrees.some((entry) => entry.path === preview.targetPath));
});

test("create revalidates stale baseline, collisions, and immutable operation identity", async (t) => {
  const { mainTree, root } = await createFixture(t);
  const repo = createGitCliRepo();
  const operationId = "019778d0-7c68-7ac0-91aa-38d945cd4444";
  const preview = await repo.previewWorktreeCreation({
    workspacePath: mainTree,
    operationId,
    mode: "new-branch",
    branchName: "stale-branch",
  });

  await writeFile(join(mainTree, "second.txt"), "second\n");
  await git(mainTree, ["add", "."]);
  await git(mainTree, ["commit", "-q", "-m", "second"]);
  await assert.rejects(
    () => repo.createWorktree({ ...preview, operationId }),
    /baseline.*changed/i,
  );

  const fresh = await repo.previewWorktreeCreation({
    workspacePath: mainTree,
    operationId,
    mode: "new-branch",
    branchName: "stale-branch",
  });
  await mkdir(fresh.targetPath, { recursive: true });
  await writeFile(join(fresh.targetPath, "user-file"), "keep\n");
  await assert.rejects(() => repo.createWorktree({ ...fresh, operationId }), /target.*exists/i);
  await rm(fresh.targetPath, { recursive: true, force: true });

  const next = await repo.previewWorktreeCreation({
    workspacePath: mainTree,
    operationId,
    mode: "new-branch",
    branchName: "stale-branch",
  });
  const created = await repo.createWorktree({ ...next, operationId });
  assert.equal(created.created, true);
  const retry = await repo.createWorktree({ ...next, operationId });
  assert.equal(retry.created, false);

  await writeFile(join(mainTree, "third.txt"), "third\n");
  await git(mainTree, ["add", "."]);
  await git(mainTree, ["commit", "-q", "-m", "third"]);
  const beforeRetry = await readdir(dirname(next.targetPath));
  const lostRpcRetry = await repo.createWorktree({ ...next, operationId });
  assert.equal(lostRpcRetry.created, false);
  assert.equal(lostRpcRetry.baselineCommit, next.baselineCommit);
  assert.deepEqual(await readdir(dirname(next.targetPath)), beforeRetry);
  const conflictPreview = await repo.previewWorktreeCreation({
    workspacePath: mainTree,
    operationId,
    mode: "new-branch",
    branchName: "conflict-branch",
  });
  await assert.rejects(
    () =>
      repo.createWorktree({
        ...conflictPreview,
        operationId,
        targetPath: join(root, "changed-target"),
      }),
    /operation.*already/i,
  );

  const recordPath = join(next.gitCommonDir, "codez/worktree-operations", `${operationId}.json`);
  const completedRecord = JSON.parse(await readFile(recordPath, "utf8")) as {
    fingerprint: string;
  } & Record<string, unknown>;
  await writeFile(recordPath, JSON.stringify({ fingerprint: completedRecord.fingerprint }) + "\n");
  await assert.rejects(() => repo.createWorktree({ ...next, operationId }), /invalid record/i);
  const forgedRequest = {
    ...next,
    repoRoot: join(root, "forged-root"),
    gitCommonDir: join(root, "forged-root/.git"),
  };
  const forgedIdentity = {
    ...completedRecord,
    repoRoot: forgedRequest.repoRoot,
    gitCommonDir: forgedRequest.gitCommonDir,
  };
  const fingerprintFields = [
    "operationId",
    "workspacePath",
    "repoRoot",
    "gitCommonDir",
    "mode",
    "branchName",
    "startPoint",
    "baselineCommit",
    "targetPath",
    "sourceBranchName",
  ] as const;
  forgedIdentity.fingerprint = fingerprintFields
    .map((field) => field + "=" + JSON.stringify(forgedIdentity[field]))
    .join("\n");
  const forgedDir = join(forgedRequest.gitCommonDir, "codez/worktree-operations");
  await mkdir(forgedDir, { recursive: true });
  await writeFile(
    join(forgedDir, operationId + ".json"),
    JSON.stringify({ ...forgedIdentity, state: "completed" }) + "\n",
  );
  await assert.rejects(
    () => repo.createWorktree({ ...forgedRequest, operationId }),
    /repository identity/i,
  );
});

test("same operation is singleflight across concurrent create calls", async (t) => {
  const { mainTree } = await createFixture(t);
  let worktreeAddCount = 0;
  const provider = createGitCommandProvider();
  const repo = createGitCliRepo({
    commandProvider: {
      ...provider,
      async run(options) {
        if (options.args[0] === "worktree" && options.args[1] === "add") worktreeAddCount += 1;
        return await provider.run(options);
      },
    },
  });
  const operationId = "019778d0-7c68-7ac0-91aa-38d945cd5555";
  const preview = await repo.previewWorktreeCreation({
    workspacePath: mainTree,
    operationId,
    mode: "new-branch",
    branchName: "concurrent-branch",
  });
  const results = await Promise.all([
    repo.createWorktree({ ...preview, operationId }),
    repo.createWorktree({ ...preview, operationId }),
  ]);
  assert.equal(results.filter((result) => result.created).length, 1);
  assert.equal(results.filter((result) => !result.created).length, 1);
  assert.equal(worktreeAddCount, 1);
});

test("malicious ids, refs, and target paths are rejected without writes", async (t) => {
  const { mainTree, root } = await createFixture(t);
  const repo = createGitCliRepo();

  await assert.rejects(
    () =>
      repo.previewWorktreeCreation({
        workspacePath: mainTree,
        operationId: "../escape",
        mode: "new-branch",
        branchName: "safe-branch",
      }),
    /operationId/i,
  );
  await assert.rejects(
    () =>
      repo.previewWorktreeCreation({
        workspacePath: mainTree,
        operationId: "019778d0-7c68-7ac0-91aa-38d945cd6666",
        mode: "new-branch",
        branchName: "../evil",
      }),
    /branch/i,
  );
  await assert.rejects(
    () =>
      repo.previewWorktreeCreation({
        workspacePath: mainTree,
        operationId: "019778d0-7c68-7ac0-91aa-38d945cd7777",
        mode: "new-branch",
        branchName: "safe-branch",
        startPoint: "refs/heads/missing",
      }),
    /start point/i,
  );
  for (const targetPath of [mainTree, join(mainTree, ".git"), join(root, ".."), "/"]) {
    await assert.rejects(
      () =>
        repo.previewWorktreeCreation({
          workspacePath: mainTree,
          operationId: "019778d0-7c68-7ac0-91aa-38d945cd8888",
          mode: "new-branch",
          branchName: "safe-branch",
          targetPath,
        }),
      /target/i,
    );
  }
});

test("service delegates preview/create without duplicating ownership", async (t) => {
  const { mainTree } = await createFixture(t);
  const repo = createGitCliRepo();
  const service = createGitService({ repo });
  const request = {
    workspacePath: mainTree,
    operationId: "019778d0-7c68-7ac0-91aa-38d945cd9999",
    mode: "new-branch",
    branchName: "service-branch",
  } as const;
  const preview = await service.previewWorktreeCreation(request);
  const result = await service.createWorktree({ ...preview, operationId: request.operationId });
  assert.equal(result.created, true);
});

test("singleflight setup failures reject every concurrent caller", async () => {
  const helper = createGitWorktreeCreationHelper({
    commandProvider: createGitCommandProvider(),
    parseWorktreeListPorcelain: () => [],
    resolveRepository: async () => {
      throw new Error("resolve failed before worker");
    },
    invalidateRepository: () => {},
  });
  const request = {
    workspacePath: "/tmp/codez-missing-worktree",
    repoRoot: "/tmp/source",
    gitCommonDir: "/tmp/source/.git",
    mode: "new-branch",
    branchName: "branch",
    startPoint: "HEAD",
    baselineCommit: "0".repeat(40),
    targetPath: "/tmp/codez-target",
    sourceBranchName: null,
    operationId: "019778d0-7c68-7ac0-91aa-38d945cdaaaa",
  } as const;
  await assert.rejects(
    Promise.race([
      Promise.all([helper.create(request), helper.create(request)]),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("singleflight promise stayed pending")), 1000),
      ),
    ]),
    /resolve failed before worker/,
  );
});
