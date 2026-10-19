import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
  access,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { ChannelClient, ChannelServer, ProxyChannel, createQueuePair } from "@codez/rpc";
import type { IGitService } from "../src/git/git.js";
import { createGitCliRepo } from "../src/git/repo/gitCliRepo.js";
import { createGitService } from "../src/git/gitService.js";
import {
  createGitCommandProvider,
  type GitCommandProvider,
} from "../src/git/providers/gitCommandProvider.js";
import { createGitWorktreeRemovalHelper } from "../src/git/repo/gitWorktreeRemoval.js";

const exec = promisify(execFile);
async function git(cwd: string, args: string[]): Promise<string> {
  return (
    await exec("git", ["-c", "user.name=test", "-c", "user.email=test@example.invalid", ...args], {
      cwd,
    })
  ).stdout;
}

async function fixture(t: test.TestContext) {
  const root = await mkdtemp(join(tmpdir(), "codez-git-worktree-remove-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const main = join(root, "source repo");
  const tree = join(root, "target tree");
  await mkdir(main);
  await git(main, ["init", "-q"]);
  await writeFile(join(main, "tracked.txt"), "base\n");
  await writeFile(join(main, ".gitignore"), ".env\nignored/\n");
  await git(main, ["add", "."]);
  await git(main, ["commit", "-qm", "base"]);
  await git(main, ["worktree", "add", "-qb", "removable", tree]);
  const repo = createGitCliRepo();
  const service = createGitService({ repo });
  const request = { workspacePath: main, targetPath: tree, operationId: "remove-operation" };
  const confirm = async () => ({
    ...request,
    expectedFingerprint: (await service.previewWorktreeRemoval(request)).statusFingerprint,
    allowDiscardChanges: false,
    allowDiscardDetachedHead: false,
  });
  return { root, main, tree, repo, service, request, confirm };
}

test("concurrent creation reservation under the same ID cannot be overwritten by removal", async (t) => {
  const f = await fixture(t);
  const request = await f.confirm();
  const provider = createGitCommandProvider();
  let createdPath = "";
  const wrapped: GitCommandProvider = {
    resolveGitBinary: () => provider.resolveGitBinary(),
    async run(params) {
      if (!createdPath && params.cwd === f.tree && params.args[0] === "status") {
        const preview = await f.repo.previewWorktreeCreation({
          workspacePath: f.main,
          operationId: request.operationId,
          mode: "new-branch",
          branchName: "concurrent-created",
        });
        createdPath = preview.targetPath;
        await f.repo.createWorktree({ ...preview, operationId: request.operationId });
      }
      return await provider.run(params);
    },
  };
  const service = createGitService({ repo: createGitCliRepo({ commandProvider: wrapped }) });
  await assert.rejects(() => service.removeWorktree(request), issue("operation-conflict"));
  await access(f.tree);
  await access(createdPath);
  const record = JSON.parse(
    await readFile(
      join(f.main, ".git/codez/worktree-operations", `${request.operationId}.json`),
      "utf8",
    ),
  );
  assert.equal(record.mode, "new-branch");
  assert.equal(record.targetPath, createdPath);
});

function issue(code: string) {
  return (error: unknown) => {
    assert.equal((error as { code: string }).code, code);
    assert.equal((error as { data: { code: string } }).data.code, code);
    return true;
  };
}

test("preview is read-only; clean remove preserves branch and supports durable retry", async (t) => {
  const f = await fixture(t);
  const before = await git(f.main, ["worktree", "list", "--porcelain"]);
  const preview = await f.service.previewWorktreeRemoval(f.request);
  assert.equal(preview.scanComplete, true);
  assert.equal(preview.isReachable, true);
  assert.equal(preview.totalChangeCount, 0);
  assert.equal(preview.attentionTotalCount, 0);
  assert.equal(await git(f.main, ["worktree", "list", "--porcelain"]), before);
  await assert.rejects(() => access(join(f.main, ".git/codez/worktree-operations")));
  const request = await f.confirm();
  assert.deepEqual(await f.service.removeWorktree(request), { removed: true });
  await assert.rejects(() => access(f.tree));
  await git(f.main, ["show-ref", "--verify", "refs/heads/removable"]);
  const newService = createGitService({ repo: createGitCliRepo() });
  assert.deepEqual(await newService.removeWorktree(request), { removed: true });
  await assert.rejects(
    () => newService.removeWorktree({ ...request, allowDiscardChanges: true }),
    issue("operation-conflict"),
  );
});

test("ignored sensitive config is independently counted and needs explicit intent", async (t) => {
  const f = await fixture(t);
  await writeFile(join(f.tree, ".env"), "SYNTHETIC_FIXTURE=1\n");
  assert.equal((await f.repo.getStatus(f.tree)).summary.isDirty, false);
  const preview = await f.service.previewWorktreeRemoval(f.request);
  assert.equal(preview.totalChangeCount, 0);
  assert.equal(preview.attentionTotalCount, 1);
  assert.deepEqual(preview.attentionPaths, [join(f.tree, ".env")]);
  await assert.rejects(
    () =>
      f.service.removeWorktree({
        ...f.request,
        expectedFingerprint: preview.statusFingerprint,
        allowDiscardChanges: false,
        allowDiscardDetachedHead: false,
      }),
    issue("discard-changes-required"),
  );
  assert.deepEqual(
    await f.service.removeWorktree({
      ...f.request,
      operationId: "confirmed-ignored",
      expectedFingerprint: preview.statusFingerprint,
      allowDiscardChanges: true,
      allowDiscardDetachedHead: false,
    }),
    { removed: true },
  );
});

test("equal-line rewrite of tracked, untracked and ignored bytes changes fingerprint", async (t) => {
  const f = await fixture(t);
  for (const name of ["tracked.txt", "new.txt", ".env"]) {
    await writeFile(join(f.tree, name), "AAAA\n");
  }
  let preview = await f.service.previewWorktreeRemoval(f.request);
  assert.equal(
    preview.changes.find((change) => change.repoRelativePath === "tracked.txt")?.added,
    1,
  );
  assert.equal(preview.changes.find((change) => change.repoRelativePath === "new.txt")?.added, 1);
  for (const name of ["tracked.txt", "new.txt", ".env"]) {
    await writeFile(join(f.tree, name), "BBBB\n");
    const latest = await f.service.previewWorktreeRemoval(f.request);
    assert.notEqual(latest.statusFingerprint, preview.statusFingerprint, name);
    preview = latest;
  }
});

test("staged bytes are fingerprinted independently of unchanged working bytes", async (t) => {
  const f = await fixture(t);
  await writeFile(join(f.tree, "tracked.txt"), "AAAA\n");
  await git(f.tree, ["add", "tracked.txt"]);
  await writeFile(join(f.tree, "tracked.txt"), "CCCC\n");
  const before = await f.service.previewWorktreeRemoval(f.request);
  await writeFile(join(f.tree, "tracked.txt"), "BBBB\n");
  await git(f.tree, ["add", "tracked.txt"]);
  await writeFile(join(f.tree, "tracked.txt"), "CCCC\n");
  const after = await f.service.previewWorktreeRemoval(f.request);
  assert.notEqual(after.statusFingerprint, before.statusFingerprint);
});

test("binary and empty untracked files remain visible; deleted files are not unreadable", async (t) => {
  const f = await fixture(t);
  await writeFile(join(f.tree, "empty"), "");
  await writeFile(join(f.tree, "binary"), Buffer.from([0, 255, 10, 128]));
  await rm(join(f.tree, "tracked.txt"));
  const before = await f.service.previewWorktreeRemoval(f.request);
  assert.equal(before.scanComplete, true);
  assert.equal(before.totalChangeCount, 3);
  assert.ok(before.changes.some((change) => change.repoRelativePath === "empty"));
  await writeFile(join(f.tree, "binary"), Buffer.from([0, 254, 10, 128]));
  assert.notEqual(
    (await f.service.previewWorktreeRemoval(f.request)).statusFingerprint,
    before.statusFingerprint,
  );
  const request = await f.confirm();
  assert.deepEqual(await f.service.removeWorktree({ ...request, allowDiscardChanges: true }), {
    removed: true,
  });
});

test("status-changed includes latest preview and leaves the directory intact", async (t) => {
  const f = await fixture(t);
  const request = await f.confirm();
  await writeFile(join(f.tree, "new.txt"), "new data\n");
  await assert.rejects(
    () => f.service.removeWorktree(request),
    (error: unknown) => {
      issue("status-changed")(error);
      assert.equal(
        (error as { data: { latestPreview: { totalChangeCount: number } } }).data.latestPreview
          .totalChangeCount,
        1,
      );
      return true;
    },
  );
  await access(f.tree);
});

test("main, locked, unknown and prunable targets are rejected before writes", async (t) => {
  const f = await fixture(t);
  const mainPreview = await f.service.previewWorktreeRemoval({ ...f.request, targetPath: f.main });
  await assert.rejects(
    async () =>
      f.service.removeWorktree({
        ...(await f.confirm()),
        targetPath: f.main,
        expectedFingerprint: mainPreview.statusFingerprint,
      }),
    issue("is-main"),
  );
  await git(f.main, ["worktree", "lock", "--reason", "keep mounted", f.tree]);
  const locked = await f.service.previewWorktreeRemoval(f.request);
  assert.equal(locked.isLocked, true);
  assert.equal(locked.lockReason, "keep mounted");
  await assert.rejects(async () => f.service.removeWorktree(await f.confirm()), issue("locked"));
  await git(f.main, ["worktree", "unlock", f.tree]);
  await assert.rejects(
    () =>
      f.service.previewWorktreeRemoval({
        ...f.request,
        targetPath: join(f.root, "not-registered"),
      }),
    issue("not-found"),
  );
  const request = await f.confirm();
  await rm(f.tree, { recursive: true });
  assert.equal((await f.service.previewWorktreeRemoval(f.request)).isReachable, false);
  await assert.rejects(() => f.service.removeWorktree(request), issue("unreachable"));
});

test("detached HEAD reachable from refs is safe; unreferenced HEAD needs independent intent", async (t) => {
  const f = await fixture(t);
  await git(f.tree, ["checkout", "--detach", "-q"]);
  assert.equal((await f.service.previewWorktreeRemoval(f.request)).headReachableFromRef, true);
  await git(f.tree, ["commit", "--allow-empty", "-qm", "detached-only"]);
  const preview = await f.service.previewWorktreeRemoval(f.request);
  assert.equal(preview.isDetached, true);
  assert.equal(preview.headReachableFromRef, false);
  const request = await f.confirm();
  await assert.rejects(
    () => f.service.removeWorktree(request),
    issue("discard-detached-head-required"),
  );
  assert.deepEqual(
    await f.service.removeWorktree({
      ...request,
      operationId: "detached-confirmed",
      allowDiscardDetachedHead: true,
    }),
    { removed: true },
  );
});

test("display truncation does not truncate fingerprint coverage", async (t) => {
  const f = await fixture(t);
  await Promise.all(
    Array.from({ length: 105 }, (_, i) =>
      writeFile(join(f.tree, `untracked-${String(i).padStart(3, "0")}`), "A\n"),
    ),
  );
  const preview = await f.service.previewWorktreeRemoval(f.request);
  assert.equal(preview.changes.length, 100);
  assert.equal(preview.totalChangeCount, 105);
  await writeFile(join(f.tree, "untracked-104"), "B\n");
  assert.notEqual(
    (await f.service.previewWorktreeRemoval(f.request)).statusFingerprint,
    preview.statusFingerprint,
  );
});

test("scan budget exhaustion blocks removal rather than truncating safety", async (t) => {
  const f = await fixture(t);
  await writeFile(join(f.tree, "new.txt"), "too large\n");
  const provider = createGitCommandProvider();
  const helper = createGitWorktreeRemovalHelper({
    commandProvider: provider,
    resolveRepository: (path) => f.repo.resolveRepository(path),
    listWorktrees: (path) => f.repo.listWorktrees(path),
    invalidateRepository: () => {},
    scanBudget: { maxFiles: 1, maxBytes: 2 },
  });
  const preview = await helper.preview(f.request);
  assert.equal(preview.scanComplete, false);
  await assert.rejects(
    () =>
      helper.remove({
        ...f.request,
        expectedFingerprint: preview.statusFingerprint,
        allowDiscardChanges: true,
        allowDiscardDetachedHead: true,
      }),
    issue("scan-incomplete"),
  );
});

test("symlink files hash the link itself and do not read external target contents", async (t) => {
  const f = await fixture(t);
  const outside = join(f.root, "outside");
  await writeFile(outside, "outside\n");
  await symlink(outside, join(f.tree, "link"));
  const before = await f.service.previewWorktreeRemoval(f.request);
  assert.equal(before.scanComplete, true);
  await writeFile(outside, "outside changed\n");
  assert.equal(
    (await f.service.previewWorktreeRemoval(f.request)).statusFingerprint,
    before.statusFingerprint,
  );
  await f.service.removeWorktree({ ...(await f.confirm()), allowDiscardChanges: true });
  assert.equal(await readFile(outside, "utf8"), "outside changed\n");
});

test("unknown command response is recovered from exact operation record and Git facts", async (t) => {
  const f = await fixture(t);
  const provider = createGitCommandProvider();
  let removals = 0;
  const wrapped: GitCommandProvider = {
    resolveGitBinary: () => provider.resolveGitBinary(),
    async run(params) {
      const result = await provider.run(params);
      if (params.args[0] === "worktree" && params.args[1] === "remove") {
        removals++;
        throw new Error("response lost after successful command");
      }
      return result;
    },
  };
  const service = createGitService({ repo: createGitCliRepo({ commandProvider: wrapped }) });
  const request = await f.confirm();
  assert.deepEqual(await service.removeWorktree(request), { removed: true });
  assert.deepEqual(await service.removeWorktree(request), { removed: true });
  assert.equal(removals, 1);
});

test("concurrent requests singleflight and old IDs never delete recreated trees", async (t) => {
  const f = await fixture(t);
  const request = await f.confirm();
  assert.deepEqual(
    await Promise.all([f.service.removeWorktree(request), f.service.removeWorktree(request)]),
    [{ removed: true }, { removed: true }],
  );
  await git(f.main, ["worktree", "add", "-q", f.tree, "removable"]);
  await assert.rejects(() => f.service.removeWorktree(request), issue("operation-conflict"));
  await access(f.tree);
  const records = await readdir(join(f.main, ".git/codez/worktree-operations"));
  assert.equal(records.filter((name) => name.endsWith(".json")).length, 1);
});

test("paths cannot authorize another repository or accept child directories", async (t) => {
  const f = await fixture(t);
  await mkdir(join(f.tree, "child"));
  await assert.rejects(
    () => f.service.previewWorktreeRemoval({ ...f.request, targetPath: join(f.tree, "child") }),
    issue("not-found"),
  );
  await assert.rejects(
    () => f.service.previewWorktreeRemoval({ ...f.request, targetPath: join(f.root, "..") }),
    issue("not-found"),
  );
  await assert.rejects(
    () => f.service.previewWorktreeRemoval({ ...f.request, operationId: "../escape" }),
    issue("operation-conflict"),
  );
});

test("staged deletion of a sensitive tracked file does not become unreadable attention", async (t) => {
  const f = await fixture(t);
  await writeFile(join(f.tree, ".env"), "SYNTHETIC_FIXTURE=1\n");
  await git(f.tree, ["add", "-f", ".env"]);
  await git(f.tree, ["commit", "-qm", "tracked config"]);
  await git(f.tree, ["rm", ".env"]);
  const preview = await f.service.previewWorktreeRemoval(f.request);
  assert.equal(preview.scanComplete, true);
  assert.equal(preview.attentionTotalCount, 0);
  assert.equal(preview.changes[0]?.kind, "deleted");
});

test("head advanced between ledger and scan is reflected in confirmation fingerprint", async (t) => {
  const f = await fixture(t);
  const request = await f.confirm();
  const provider = createGitCommandProvider();
  let advanced = false;
  const wrapped: GitCommandProvider = {
    resolveGitBinary: () => provider.resolveGitBinary(),
    async run(params) {
      const result = await provider.run(params);
      if (!advanced && params.args[0] === "worktree" && params.args[1] === "list") {
        advanced = true;
        await git(f.tree, ["commit", "--allow-empty", "-qm", "advance after ledger"]);
      }
      return result;
    },
  };
  const service = createGitService({ repo: createGitCliRepo({ commandProvider: wrapped }) });
  await assert.rejects(() => service.removeWorktree(request), issue("status-changed"));
  await access(f.tree);
});

test("staged binary bytes survive invalid UTF-8 without lossy fingerprint conversion", async (t) => {
  const f = await fixture(t);
  await writeFile(join(f.tree, "tracked.txt"), Buffer.from([0, 255, 128]));
  await git(f.tree, ["add", "tracked.txt"]);
  await writeFile(join(f.tree, "tracked.txt"), "stable working bytes\n");
  const first = await f.service.previewWorktreeRemoval(f.request);
  await writeFile(join(f.tree, "tracked.txt"), Buffer.from([0, 254, 129]));
  await git(f.tree, ["add", "tracked.txt"]);
  await writeFile(join(f.tree, "tracked.txt"), "stable working bytes\n");
  assert.notEqual(
    (await f.service.previewWorktreeRemoval(f.request)).statusFingerprint,
    first.statusFingerprint,
  );
});

test("existing creation records cannot authorize removal under the same operation ID", async (t) => {
  const f = await fixture(t);
  const operationId = "created-and-not-removable";
  const created = await f.repo.previewWorktreeCreation({
    workspacePath: f.main,
    operationId,
    mode: "new-branch",
    branchName: "created-record",
  });
  await f.repo.createWorktree({ ...created, operationId });
  const request = { ...f.request, operationId, targetPath: created.targetPath };
  const preview = await f.service.previewWorktreeRemoval(request);
  await assert.rejects(
    () =>
      f.service.removeWorktree({
        ...request,
        expectedFingerprint: preview.statusFingerprint,
        allowDiscardChanges: false,
        allowDiscardDetachedHead: false,
      }),
    issue("operation-conflict"),
  );
  await access(created.targetPath);
});

test("latest removal preview survives the actual Channel RPC error transport", async (t) => {
  const f = await fixture(t);
  const [clientProtocol, serverProtocol] = createQueuePair();
  const client = new ChannelClient(clientProtocol);
  const server = new ChannelServer(serverProtocol, "test", 1000, true);
  t.after(() => {
    client.dispose();
    server.dispose();
  });
  server.registerChannel("git", ProxyChannel.fromService(f.service));
  server.ready();
  const remote = ProxyChannel.toService<IGitService>(client.getChannel("git"));
  const preview = await remote.previewWorktreeRemoval(f.request);
  await writeFile(join(f.tree, "later.txt"), "new\n");
  await assert.rejects(
    () =>
      remote.removeWorktree({
        ...f.request,
        expectedFingerprint: preview.statusFingerprint,
        allowDiscardChanges: false,
        allowDiscardDetachedHead: false,
      }),
    (error: unknown) => {
      issue("status-changed")(error);
      assert.equal(
        (error as { data: { latestPreview: { totalChangeCount: number } } }).data.latestPreview
          .totalChangeCount,
        1,
      );
      return true;
    },
  );
});

test("a crashed execution releases its stale PID lock and retries the original operation", async (t) => {
  const f = await fixture(t);
  const request = await f.confirm();
  const script = `
    import { createGitCliRepo } from './packages/services/src/git/repo/gitCliRepo.ts';
    import { createGitCommandProvider } from './packages/services/src/git/providers/gitCommandProvider.ts';
    const provider = createGitCommandProvider();
    const repo = createGitCliRepo({ commandProvider: {
      resolveGitBinary: () => provider.resolveGitBinary(),
      run: async (params) => {
        if (params.args[0] === 'worktree' && params.args[1] === 'remove') process.exit(7);
        return await provider.run(params);
      },
    }});
    await repo.removeWorktree(JSON.parse(process.env.CODEZ_REMOVAL_TEST_REQUEST));
  `;
  await assert.rejects(
    () =>
      exec(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
        cwd: process.cwd(),
        env: { ...process.env, CODEZ_REMOVAL_TEST_REQUEST: JSON.stringify(request) },
      }),
    (error: unknown) => (error as { code: number }).code === 7,
  );
  await access(f.tree);
  assert.deepEqual(await f.service.removeWorktree(request), { removed: true });
});

test("native failure does not authorize success when an unregistered directory still exists", async (t) => {
  const f = await fixture(t);
  const provider = createGitCommandProvider();
  const wrapped: GitCommandProvider = {
    resolveGitBinary: () => provider.resolveGitBinary(),
    async run(params) {
      if (params.args[0] === "worktree" && params.args[1] === "remove") {
        const metadata = (await git(f.tree, ["rev-parse", "--absolute-git-dir"])).trim();
        await rm(metadata, { recursive: true });
        throw new Error("ledger disappeared without deleting directory");
      }
      return await provider.run(params);
    },
  };
  const request = await f.confirm();
  const service = createGitService({ repo: createGitCliRepo({ commandProvider: wrapped }) });
  await assert.rejects(() => service.removeWorktree(request));
  await access(f.tree);
  await assert.rejects(() => service.removeWorktree(request), issue("not-found"));
});

test("index/status snapshot changes during scan degrade to risk unknown", async (t) => {
  const f = await fixture(t);
  await writeFile(join(f.tree, "tracked.txt"), "first\n");
  await git(f.tree, ["add", "tracked.txt"]);
  const provider = createGitCommandProvider();
  let changed = false;
  const wrapped: GitCommandProvider = {
    resolveGitBinary: () => provider.resolveGitBinary(),
    async run(params) {
      const result = await provider.run(params);
      if (!changed && params.args.includes("cat-file") && params.args.includes("blob")) {
        changed = true;
        await writeFile(join(f.tree, "tracked.txt"), "second\n");
        await git(f.tree, ["add", "tracked.txt"]);
      }
      return result;
    },
  };
  const service = createGitService({ repo: createGitCliRepo({ commandProvider: wrapped }) });
  assert.equal((await service.previewWorktreeRemoval(f.request)).scanComplete, false);
});

test("gitlink protection survives removal of .gitmodules from the index", async (t) => {
  const f = await fixture(t);
  const sub = join(f.tree, "sub");
  await mkdir(sub);
  await git(sub, ["init", "-q"]);
  await writeFile(join(sub, ".gitignore"), ".env\n");
  await git(sub, ["add", ".gitignore"]);
  await git(sub, ["commit", "-qm", "nested baseline"]);
  await writeFile(join(sub, ".env"), "SYNTHETIC_NESTED_DATA=1\n");
  const subHead = (await git(sub, ["rev-parse", "HEAD"])).trim();
  await writeFile(
    join(f.tree, ".gitmodules"),
    '[submodule "sub"]\n\tpath = sub\n\turl = ../synthetic-sub\n',
  );
  await git(f.tree, ["add", ".gitmodules"]);
  await git(f.tree, ["update-index", "--add", "--cacheinfo", `160000,${subHead},sub`]);
  await git(f.tree, ["commit", "-qm", "gitlink"]);
  await git(f.tree, ["rm", ".gitmodules"]);
  const preview = await f.service.previewWorktreeRemoval(f.request);
  assert.equal(preview.scanComplete, false);
  await assert.rejects(
    () =>
      f.service.removeWorktree({
        ...f.request,
        expectedFingerprint: preview.statusFingerprint,
        allowDiscardChanges: true,
        allowDiscardDetachedHead: true,
      }),
    issue("scan-incomplete"),
  );
  assert.equal(await readFile(join(sub, ".env"), "utf8"), "SYNTHETIC_NESTED_DATA=1\n");
});

test("clean tracked directories with nested Git metadata are not removable", async (t) => {
  const f = await fixture(t);
  const nested = join(f.tree, "nested");
  await mkdir(nested);
  await writeFile(join(nested, "tracked"), "outer tracked data\n");
  await git(f.tree, ["add", "nested/tracked"]);
  await git(f.tree, ["commit", "-qm", "nested directory"]);
  await git(nested, ["init", "-q"]);
  assert.equal((await git(f.tree, ["status", "--porcelain"])).trim(), "");
  assert.equal((await f.service.previewWorktreeRemoval(f.request)).scanComplete, false);
});

test("copied repository metadata at the same path cannot replay another repository's record", async (t) => {
  const f = await fixture(t);
  const request = await f.confirm();
  await f.service.removeWorktree(request);
  await git(f.main, ["commit", "--allow-empty", "-qm", "normal HEAD advance"]);
  assert.deepEqual(await f.service.removeWorktree(request), { removed: true });
  const commonDir = join(f.main, ".git");
  const backup = join(f.root, "old-common-dir");
  await rename(commonDir, backup);
  await cp(backup, commonDir, { recursive: true });
  await assert.rejects(() => f.service.removeWorktree(request), issue("operation-conflict"));
});

test("service and Channel RPC expose branch CAS and carry latest branch preview", async (t) => {
  const f = await fixture(t);
  await git(f.main, ["branch", "rpc-branch"]);
  const [clientProtocol, serverProtocol] = createQueuePair();
  const client = new ChannelClient(clientProtocol);
  const server = new ChannelServer(serverProtocol, "test", 1000, true);
  t.after(() => {
    client.dispose();
    server.dispose();
  });
  server.registerChannel("git", ProxyChannel.fromService(f.service));
  server.ready();
  const remote = ProxyChannel.toService<IGitService>(client.getChannel("git"));
  const preview = await remote.previewBranchDeletion({
    workspacePath: f.main,
    branchName: "rpc-branch",
  });
  const result = await remote.deleteBranch({
    workspacePath: f.main,
    branchName: "rpc-branch",
    expectedCommitHash: preview.commitHash,
    force: false,
  });
  assert.deepEqual(result, { deleted: true, configCleanupSucceeded: true });
  await git(f.main, ["branch", "rpc-moved"]);
  const before = await remote.previewBranchDeletion({
    workspacePath: f.main,
    branchName: "rpc-moved",
  });
  await git(f.main, ["commit", "--allow-empty", "-qm", "new tip"]);
  const moved = (await git(f.main, ["rev-parse", "HEAD"])).trim();
  await git(f.main, ["update-ref", "refs/heads/rpc-moved", moved]);
  await assert.rejects(
    () =>
      remote.deleteBranch({
        workspacePath: f.main,
        branchName: "rpc-moved",
        expectedCommitHash: before.commitHash,
        force: false,
      }),
    (error: unknown) => {
      assert.equal((error as { code: string }).code, "branch-moved");
      assert.equal(
        (error as { data: { latestPreview: { commitHash: string } } }).data.latestPreview
          .commitHash,
        moved,
      );
      return true;
    },
  );
});
