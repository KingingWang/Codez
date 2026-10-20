import { createHash } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import type {
  GitWorktreeEntry,
  GitWorktreeListResult,
  GitWorktreeRemovalPreview,
  GitWorktreeRemovePreviewRequest,
  GitWorktreeRemoveRequest,
  GitWorktreeRemoveResult,
} from "@codez/shared";
import type { GitCommandProvider } from "../providers/gitCommandProvider.js";
import { ensureGitCommandSucceeded, ensureRepositoryAvailable } from "./gitCliHelpers.js";
import type { GitResolvedRepository } from "./gitCliTypes.js";
import { worktreeRemovalError } from "./gitRemovalErrors.js";
import { scanWorktreeRemoval, type WorktreeRemovalScanBudget } from "./gitWorktreeRemovalScan.js";
import {
  loadRemovalRecord,
  saveRemovalRecord,
  validateRemovalOperationId,
  withRemovalLock,
  type WorktreeRemovalRecord,
} from "./gitWorktreeRemovalRecord.js";

interface RemovalOptions {
  commandProvider: GitCommandProvider;
  resolveRepository: (path: string) => Promise<GitResolvedRepository>;
  listWorktrees: (path: string) => Promise<GitWorktreeListResult>;
  invalidateRepository: (path: string) => void;
  scanBudget?: WorktreeRemovalScanBudget;
}
const executions = new Map<
  string,
  { fingerprint: string; result: Promise<GitWorktreeRemoveResult> }
>();
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const hostPath = (path: string) => (process.platform === "win32" ? path.replace(/\\/g, "/") : path);
const missing = (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT";

async function pathExists(path: string) {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (missing(error)) return false;
    throw error;
  }
}

async function repositoryIdentity(commonDir: string): Promise<string> {
  const info = await lstat(commonDir);
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw worktreeRemovalError("operation-conflict", "Repository metadata was replaced.");
  }
  // HEAD/refs 正常前进不能破坏未知结果恢复；身份绑定目录实体而不是可变分支快照。
  return digest([commonDir, info.dev, info.ino, info.birthtimeMs]);
}

function removalFailure(error: unknown): Error {
  if (error instanceof Error && (error as { data?: { code?: unknown } }).data?.code) return error;
  return worktreeRemovalError("unknown", error instanceof Error ? error.message : String(error));
}

export function createGitWorktreeRemovalHelper(options: RemovalOptions) {
  async function repository(request: GitWorktreeRemovePreviewRequest) {
    validateRemovalOperationId(request.operationId);
    if (
      typeof request.targetPath !== "string" ||
      !isAbsolute(request.targetPath) ||
      request.targetPath.includes("\0")
    ) {
      throw worktreeRemovalError(
        "not-found",
        "Removal target must be an absolute registered tree root.",
      );
    }
    const resolution = ensureRepositoryAvailable(
      await options.resolveRepository(request.workspacePath),
      "remove worktree",
    );
    if (!resolution.gitCommonDir)
      throw worktreeRemovalError("unknown", "Git common directory is unavailable.");
    const target = hostPath(resolve(request.targetPath));
    return {
      resolution,
      target,
      commonDir: resolution.gitCommonDir,
      repositoryIdentity: await repositoryIdentity(resolution.gitCommonDir),
    };
  }

  async function registered(request: GitWorktreeRemovePreviewRequest, target: string) {
    const list = await options.listWorktrees(request.workspacePath);
    if (!list.isGitAvailable || !list.isRepository)
      throw worktreeRemovalError("unknown", "Git worktree ledger unavailable.");
    return list.worktrees.find((entry) => hostPath(entry.path) === target) ?? null;
  }

  async function treeIdentity(target: string) {
    const rootInfo = await lstat(target);
    if (
      !rootInfo.isDirectory() ||
      rootInfo.isSymbolicLink() ||
      hostPath(await realpath(target)) !== target
    )
      throw new Error("Worktree root was replaced or is not canonical.");
    const metadata = join(target, ".git");
    const info = await lstat(metadata);
    if (info.isSymbolicLink()) throw new Error("Git metadata cannot be a symlink.");
    const gitdir = info.isFile() ? await readFile(metadata, "utf8") : "main-directory";
    return digest([
      target,
      rootInfo.dev,
      rootInfo.ino,
      rootInfo.birthtimeMs,
      info.dev,
      info.ino,
      info.birthtimeMs,
      gitdir,
    ]);
  }

  async function previewEntry(
    entry: GitWorktreeEntry,
    commonDir: string,
    repoIdentity: string,
  ): Promise<{ preview: GitWorktreeRemovalPreview; identity: string }> {
    const base: GitWorktreeRemovalPreview = {
      targetPath: entry.path,
      branchName: entry.branchName,
      isDetached: entry.isDetached,
      headCommitHash: entry.headCommitHash,
      headReachableFromRef: null,
      isMain: entry.isMain,
      isLocked: entry.isLocked,
      lockReason: entry.lockReason,
      isReachable: false,
      changes: [],
      totalChangeCount: 0,
      attentionPaths: [],
      attentionTotalCount: 0,
      scanComplete: false,
      statusFingerprint: "",
    };
    let identity = "";
    if (entry.isPrunable) return { preview: base, identity };
    try {
      identity = await treeIdentity(entry.path);
    } catch {
      return { preview: base, identity };
    }
    base.isReachable = true;
    try {
      // 台账路径虽已核对，还需确认目录内的 Git 实际解析仍属于该树与同一仓库。
      const targetRepository = await options.resolveRepository(entry.path);
      if (
        !targetRepository.isRepository ||
        hostPath(targetRepository.repoRoot) !== entry.path ||
        targetRepository.gitCommonDir !== commonDir ||
        (await repositoryIdentity(commonDir)) !== repoIdentity
      ) {
        throw new Error("Target is no longer the registered repository.");
      }
      const scan = await scanWorktreeRemoval(
        entry.path,
        options.commandProvider,
        options.scanBudget,
      );
      const { descriptors, ...fields } = scan;
      Object.assign(base, fields);
      if (base.headCommitHash && /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(base.headCommitHash)) {
        const refs = await options.commandProvider.run({
          cwd: entry.path,
          args: ["for-each-ref", `--contains=${base.headCommitHash}`, "--format=%(refname)"],
        });
        ensureGitCommandSucceeded("git for-each-ref --contains", refs);
        base.headReachableFromRef = Boolean(refs.stdout.trim());
      } else base.scanComplete = false;
      base.statusFingerprint = digest([
        repoIdentity,
        identity,
        base.headCommitHash,
        base.branchName,
        base.isDetached,
        base.headReachableFromRef,
        descriptors,
        base.scanComplete,
      ]);
    } catch {
      base.scanComplete = false;
      base.statusFingerprint = digest([identity, entry.headCommitHash, "scan-incomplete"]);
    }
    return { preview: base, identity };
  }

  function checkPreview(preview: GitWorktreeRemovalPreview, request: GitWorktreeRemoveRequest) {
    if (!preview.isReachable)
      throw worktreeRemovalError("unreachable", "Worktree is not reachable.", preview);
    if (!preview.scanComplete)
      throw worktreeRemovalError("scan-incomplete", "Worktree safety scan is incomplete.", preview);
    if (preview.statusFingerprint !== request.expectedFingerprint) {
      throw worktreeRemovalError("status-changed", "Worktree changed since confirmation.", preview);
    }
    if (
      (preview.totalChangeCount > 0 || preview.attentionTotalCount > 0) &&
      !request.allowDiscardChanges
    ) {
      throw worktreeRemovalError(
        "discard-changes-required",
        "Explicit permission to discard local files is required.",
        preview,
      );
    }
    if (
      preview.isDetached &&
      preview.headReachableFromRef !== true &&
      !request.allowDiscardDetachedHead
    ) {
      throw worktreeRemovalError(
        "discard-detached-head-required",
        "Explicit detached HEAD confirmation is required.",
        preview,
      );
    }
  }

  async function remove(request: GitWorktreeRemoveRequest): Promise<GitWorktreeRemoveResult> {
    const {
      resolution,
      target,
      commonDir,
      repositoryIdentity: repoIdentity,
    } = await repository(request);
    if (
      typeof request.allowDiscardChanges !== "boolean" ||
      typeof request.allowDiscardDetachedHead !== "boolean" ||
      typeof request.expectedFingerprint !== "string" ||
      !/^[a-f0-9]{64}$/.test(request.expectedFingerprint)
    ) {
      throw worktreeRemovalError("operation-conflict", "Removal confirmation request is invalid.");
    }
    const fingerprint = digest([
      commonDir,
      repoIdentity,
      target,
      request.expectedFingerprint,
      request.allowDiscardChanges,
      request.allowDiscardDetachedHead,
    ]);
    const key = `${commonDir}\0${request.operationId}`;
    const active = executions.get(key);
    if (active) {
      if (active.fingerprint !== fingerprint)
        throw worktreeRemovalError(
          "operation-conflict",
          "Operation request changed while executing.",
        );
      return await active.result;
    }
    const result = withRemovalLock(commonDir, request.operationId, async () => {
      const record = await loadRemovalRecord(
        commonDir,
        request.operationId,
        fingerprint,
        repoIdentity,
      );
      const entry = await registered(request, target);
      if (!entry) {
        if (!record || (await pathExists(target)))
          throw worktreeRemovalError("not-found", "Worktree is not registered for this removal.");
        await saveRemovalRecord(commonDir, { ...record, state: "completed" });
        options.invalidateRepository(request.workspacePath);
        options.invalidateRepository(target);
        return { removed: true } as const;
      }
      if (entry.isMain) throw worktreeRemovalError("is-main", "Main worktree cannot be removed.");
      if (entry.isLocked) throw worktreeRemovalError("locked", "Worktree is locked.");
      if (entry.isPrunable)
        throw worktreeRemovalError("unreachable", "Worktree is prunable or unreachable.");
      if (record?.state === "completed")
        throw worktreeRemovalError(
          "operation-conflict",
          "Removed target has been registered again.",
        );
      const { preview, identity } = await previewEntry(entry, commonDir, repoIdentity);
      if (record && record.treeIdentity !== identity)
        throw worktreeRemovalError("operation-conflict", "Operation target has been replaced.");
      checkPreview(preview, request);
      const pending: WorktreeRemovalRecord = record ?? {
        version: 1,
        action: "remove",
        operationId: request.operationId,
        requestFingerprint: fingerprint,
        repositoryIdentity: repoIdentity,
        targetPath: target,
        treeIdentity: identity,
        state: "reserved",
      };
      // 创建与删除共用记录目录；首次提交不能覆盖并发创建刚预留的同 ID。
      await saveRemovalRecord(commonDir, pending, !record);
      try {
        const args = ["worktree", "remove"];
        // 不根据客户端 allow 标志自动升格：只有本次复检确实有本地文件时才使用 --force。
        if (preview.totalChangeCount > 0 || preview.attentionTotalCount > 0) args.push("--force");
        args.push("--", target);
        const command = await options.commandProvider.run({ cwd: resolution.repoRoot, args });
        ensureGitCommandSucceeded("git worktree remove", command);
      } catch (error) {
        const stillRegistered = await registered(request, target);
        if (stillRegistered || (await pathExists(target))) throw error;
        // 命令返回未知但 Git 台账与物理目录均已消失，记录足以恢复同一操作的成功结果。
      }
      if ((await registered(request, target)) || (await pathExists(target))) {
        throw worktreeRemovalError(
          "unknown",
          "Removal command did not remove the registered directory.",
        );
      }
      await saveRemovalRecord(commonDir, { ...pending, state: "completed" });
      options.invalidateRepository(request.workspacePath);
      options.invalidateRepository(target);
      return { removed: true } as const;
    });
    executions.set(key, { fingerprint, result });
    try {
      return await result;
    } finally {
      if (executions.get(key)?.result === result) executions.delete(key);
    }
  }

  return {
    async preview(request: GitWorktreeRemovePreviewRequest): Promise<GitWorktreeRemovalPreview> {
      try {
        const { target, commonDir, repositoryIdentity: repoIdentity } = await repository(request);
        const entry = await registered(request, target);
        if (!entry)
          throw worktreeRemovalError("not-found", "Target is not a registered tree root.");
        const targetRepository = await options.resolveRepository(entry.path);
        if (targetRepository.isRepository && targetRepository.gitCommonDir !== commonDir) {
          throw worktreeRemovalError("not-found", "Target belongs to a different repository.");
        }
        return (await previewEntry(entry, commonDir, repoIdentity)).preview;
      } catch (error) {
        throw removalFailure(error);
      }
    },
    async remove(request: GitWorktreeRemoveRequest): Promise<GitWorktreeRemoveResult> {
      try {
        return await remove(request);
      } catch (error) {
        throw removalFailure(error);
      }
    },
  };
}
