// 创建闭环必须在一个原子流程中完成“预检 -> 独占预留 -> Git 写入 -> 精确复核”。
// 拆到多个文件会让跨进程竞态与超时恢复的时序边界失去单处审计视图。
/* eslint-disable max-lines */
import { lstat, mkdir, open, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type {
  GitWorktreeCreatePreview,
  GitWorktreeCreatePreviewRequest,
  GitWorktreeCreateRequest,
  GitWorktreeCreateResult,
  GitWorktreeListResult,
} from "@codez/shared";
import { DEFAULT_GIT_COMMAND_TIMEOUT_MS } from "../config.js";
import type { GitCommandProvider } from "../providers/gitCommandProvider.js";
import { ensureGitCommandSucceeded, ensureRepositoryAvailable } from "./gitCliHelpers.js";
import type { GitResolvedRepository } from "./gitCliTypes.js";

interface WorktreeOperationRecord {
  version: 1;
  operationId: string;
  fingerprint: string;
  workspacePath: string;
  repoRoot: string;
  gitCommonDir: string;
  mode: GitWorktreeCreatePreview["mode"];
  branchName: string;
  startPoint: string;
  baselineCommit: string;
  targetPath: string;
  sourceBranchName: string | null;
  state: "reserved" | "completed";
  createdAt: number;
  updatedAt: number;
}

type WorktreeOperationIdentity = Omit<WorktreeOperationRecord, "state" | "createdAt" | "updatedAt">;

export interface GitWorktreeCreationHelper {
  preview(request: GitWorktreeCreatePreviewRequest): Promise<GitWorktreeCreatePreview>;
  create(request: GitWorktreeCreateRequest): Promise<GitWorktreeCreateResult>;
}

const OPERATION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const COMMIT_PATTERN = /^[0-9a-f]{40}$/i;

function normalizeHostPath(path: string): string {
  return path.trim().replace(/\\/g, "/").replace(/\/+$/, "");
}

function isNoentError(error: unknown): boolean {
  return (
    typeof error === "object" && error !== null && (error as { code?: unknown }).code === "ENOENT"
  );
}

function pathContains(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

function safePathSegment(value: string): string {
  return normalizeHostPath(value)
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 72)
    .replace(/^-+|-+$/g, "");
}

function validateOperationId(operationId: string): void {
  if (!OPERATION_ID_PATTERN.test(operationId ?? "")) {
    throw new Error(
      "Worktree operationId is invalid: use 1-128 letters, digits, dot, underscore, or hyphen, and do not start with a symbol.",
    );
  }
}

function validateMode(mode: GitWorktreeCreatePreviewRequest["mode"]): void {
  if (mode !== "new-branch" && mode !== "existing-branch") {
    throw new Error(`Unsupported worktree creation mode: ${String(mode)}`);
  }
}

function operationRecordPath(commonDir: string, operationId: string): string {
  return join(commonDir, "codez/worktree-operations", `${operationId}.json`);
}

function fingerprintRequest(identity: WorktreeOperationIdentity): string {
  const keys: Array<keyof WorktreeOperationIdentity> = [
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
  ];
  return keys.map((key) => `${key}=${JSON.stringify(identity[key])}`).join("\n");
}

function parseWorktreeOperationRecord(value: unknown): WorktreeOperationRecord | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const record = value as Partial<WorktreeOperationRecord>;
  if (
    record.version !== 1 ||
    typeof record.operationId !== "string" ||
    typeof record.fingerprint !== "string" ||
    typeof record.workspacePath !== "string" ||
    typeof record.repoRoot !== "string" ||
    typeof record.gitCommonDir !== "string" ||
    (record.mode !== "new-branch" && record.mode !== "existing-branch") ||
    typeof record.branchName !== "string" ||
    typeof record.startPoint !== "string" ||
    typeof record.baselineCommit !== "string" ||
    typeof record.targetPath !== "string" ||
    (record.sourceBranchName !== null && typeof record.sourceBranchName !== "string") ||
    (record.state !== "reserved" && record.state !== "completed") ||
    typeof record.createdAt !== "number" ||
    !Number.isSafeInteger(record.createdAt) ||
    typeof record.updatedAt !== "number" ||
    !Number.isSafeInteger(record.updatedAt)
  ) {
    return null;
  }
  return record as WorktreeOperationRecord;
}

async function exclusiveWriteIfAbsent(path: string, content: string): Promise<boolean> {
  await mkdir(dirname(path), { recursive: true });
  let handle: Awaited<ReturnType<typeof open>>;
  try {
    handle = await open(path, "wx", 0o600);
  } catch (error) {
    if (isNoentError(error)) throw error;
    if (
      typeof error === "object" &&
      error !== null &&
      (error as { code?: unknown }).code === "EEXIST"
    )
      return false;
    throw error;
  }
  try {
    await handle.writeFile(content, "utf8");
  } finally {
    await handle.close();
  }
  return true;
}

async function atomicReplace(path: string, content: string): Promise<void> {
  const temporaryPath = `${path}.${process.pid}.${Date.now()}.tmp`;
  try {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(temporaryPath, content, { encoding: "utf8", mode: 0o600 });
    await rename(temporaryPath, path);
  } catch (error) {
    await rm(temporaryPath, { force: true });
    throw error;
  }
}

async function readRecord(path: string): Promise<WorktreeOperationRecord | null> {
  try {
    const value: unknown = JSON.parse(await readFile(path, "utf8"));
    return parseWorktreeOperationRecord(value);
  } catch {
    return null;
  }
}

/**
 * Resolve an existing path physically. For an absent path, resolve through its
 * nearest existing ancestor so a symlinked parent cannot make a lexical sibling
 * escape into the source tree or Git metadata.
 */
async function resolvePhysicalPath(path: string): Promise<string> {
  const normalized = normalizeHostPath(path);
  try {
    return normalizeHostPath(await realpath(normalized));
  } catch {
    let ancestor = dirname(normalized);
    while (true) {
      try {
        const physicalAncestor = normalizeHostPath(await realpath(ancestor));
        const suffix = relative(ancestor, normalized);
        return suffix ? normalizeHostPath(resolve(physicalAncestor, suffix)) : physicalAncestor;
      } catch (error) {
        if (!isNoentError(error)) return normalized;
        const parent = dirname(ancestor);
        if (parent === ancestor) return normalized;
        ancestor = parent;
      }
    }
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (isNoentError(error)) return false;
    throw error;
  }
}

async function assertSafeTarget(
  target: string,
  resolution: GitResolvedRepository,
): Promise<string> {
  const normalized = normalizeHostPath(target);
  if (!isAbsolute(normalized)) {
    throw new Error("Worktree target path must be an absolute host path.");
  }
  if (normalized === "/" || /^[A-Za-z]:\/?$/.test(normalized)) {
    throw new Error("Worktree target path cannot be a filesystem root.");
  }

  const physical = await resolvePhysicalPath(normalized);
  const physicalRepo = await resolvePhysicalPath(normalizeHostPath(resolution.repoRoot));
  const physicalCommon = resolution.gitCommonDir
    ? await resolvePhysicalPath(normalizeHostPath(resolution.gitCommonDir))
    : "";
  if (pathContains(physicalRepo, physical) || pathContains(physical, physicalRepo)) {
    throw new Error(
      "Worktree target path cannot be equal to or inside the source repository tree.",
    );
  }
  if (physicalCommon && pathContains(physicalCommon, physical)) {
    throw new Error("Worktree target path cannot be inside the Git common directory.");
  }
  // Git 台账记录物理树根；预览若保留父目录别名，创建后的结果复检会把成功误判为未知。
  return physical;
}

export function createGitWorktreeCreationHelper(options: {
  commandProvider: GitCommandProvider;
  parseWorktreeListPorcelain: (stdout: string) => GitWorktreeListResult["worktrees"];
  resolveRepository: (workspacePath: string) => Promise<GitResolvedRepository>;
  invalidateRepository: (workspacePath: string) => void;
}): GitWorktreeCreationHelper {
  const { commandProvider, parseWorktreeListPorcelain } = options;
  const activeCreations = new Map<string, Promise<GitWorktreeCreateResult>>();

  async function listWorktrees(
    resolution: GitResolvedRepository,
  ): Promise<GitWorktreeListResult["worktrees"]> {
    const result = await commandProvider.run({
      cwd: resolution.repoRoot,
      args: ["worktree", "list", "--porcelain"],
      timeoutMs: DEFAULT_GIT_COMMAND_TIMEOUT_MS,
    });
    ensureGitCommandSucceeded("git worktree list --porcelain", result);
    return parseWorktreeListPorcelain(result.stdout);
  }

  async function validateBranchName(
    resolution: GitResolvedRepository,
    branchName: string,
  ): Promise<void> {
    if (
      !branchName ||
      branchName !== branchName.trim() ||
      branchName.startsWith("-") ||
      branchName.includes("..") ||
      branchName.includes("//") ||
      branchName.endsWith("/") ||
      branchName.endsWith(".") ||
      branchName.endsWith(".lock") ||
      branchName.includes("\0") ||
      branchName.includes("\n")
    ) {
      throw new Error(`Branch name is invalid: ${branchName}`);
    }
    const result = await commandProvider.run({
      cwd: resolution.repoRoot,
      args: ["check-ref-format", "--branch", branchName],
      timeoutMs: DEFAULT_GIT_COMMAND_TIMEOUT_MS,
    });
    ensureGitCommandSucceeded("git check-ref-format --branch", result);
  }

  async function resolveLocalBranch(
    resolution: GitResolvedRepository,
    branchName: string,
  ): Promise<string | null> {
    const ref = `refs/heads/${branchName}`;
    const result = await commandProvider.run({
      cwd: resolution.repoRoot,
      args: ["show-ref", "--verify", "--", ref],
      timeoutMs: DEFAULT_GIT_COMMAND_TIMEOUT_MS,
    });
    if (result.exitCode === 0 && !result.timedOut && !result.outputTruncated) {
      const commit = result.stdout.trim().split(/\s+/)[0] ?? "";
      if (COMMIT_PATTERN.test(commit)) return commit.toLowerCase();
      throw new Error("Git local branch did not resolve to a commit hash.");
    }
    const absent =
      !result.timedOut &&
      !result.outputTruncated &&
      (result.exitCode === 1 ||
        (result.exitCode === 128 && result.stderr.toLowerCase().includes("not a valid ref")));
    if (absent) return null;
    ensureGitCommandSucceeded("git show-ref --verify refs/heads/<branch>", result);
    return null;
  }

  async function revParseCommit(
    resolution: GitResolvedRepository,
    revision: string,
    label: string,
  ): Promise<string> {
    if (
      !revision ||
      revision.startsWith("-") ||
      revision.includes("\0") ||
      revision.includes("\n") ||
      revision !== revision.trim()
    ) {
      throw new Error(`Invalid Git ${label}: ${revision || "<empty>"}`);
    }
    const result = await commandProvider.run({
      cwd: resolution.repoRoot,
      args: ["rev-parse", "--verify", "--end-of-options", `${revision}^{commit}`],
      timeoutMs: DEFAULT_GIT_COMMAND_TIMEOUT_MS,
    });
    ensureGitCommandSucceeded(`git rev-parse --verify ${label}`, result);
    const commit = result.stdout.trim();
    if (!COMMIT_PATTERN.test(commit))
      throw new Error(`Git ${label} did not resolve to a commit hash.`);
    return commit.toLowerCase();
  }

  async function resolveSourceBranchName(
    resolution: GitResolvedRepository,
  ): Promise<string | null> {
    const result = await commandProvider.run({
      cwd: resolution.repoRoot,
      args: ["branch", "--show-current"],
      timeoutMs: DEFAULT_GIT_COMMAND_TIMEOUT_MS,
    });
    if (result.exitCode === 1 && !result.timedOut && !result.outputTruncated) return null;
    ensureGitCommandSucceeded("git branch --show-current", result, [0, 1]);
    return result.stdout.trim() || null;
  }

  function findOccupied(entries: GitWorktreeListResult["worktrees"], branchName: string) {
    return entries.find((entry) => entry.branchName === branchName) ?? null;
  }

  function verifyRegisteredTree(
    entries: GitWorktreeListResult["worktrees"],
    request: Omit<GitWorktreeCreateRequest, "operationId">,
  ): boolean {
    const entry = entries.find((item) => normalizeHostPath(item.path) === request.targetPath);
    return Boolean(
      entry &&
      entry.branchName === request.branchName &&
      entry.headCommitHash?.toLowerCase() === request.baselineCommit,
    );
  }

  async function loadMatchingRecord(
    identity: WorktreeOperationIdentity,
  ): Promise<WorktreeOperationRecord | null> {
    const path = operationRecordPath(identity.gitCommonDir, identity.operationId);
    if (!(await pathExists(path))) return null;
    const record = await readRecord(path);
    if (
      !record ||
      record.fingerprint !== fingerprintRequest(identity) ||
      !(
        [
          "version",
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
        ] as const
      ).every((field) => record[field] === identity[field])
    ) {
      throw new Error(
        `Worktree operation ${identity.operationId} already exists with a different request or an invalid record.`,
      );
    }
    return record;
  }

  async function buildPreview(
    resolution: GitResolvedRepository,
    request: GitWorktreeCreatePreviewRequest,
  ): Promise<GitWorktreeCreatePreview> {
    validateOperationId(request.operationId);
    validateMode(request.mode);
    const branchName = request.branchName?.trim() ?? "";
    await validateBranchName(resolution, branchName);
    const localBranchCommit = await resolveLocalBranch(resolution, branchName);
    if (request.mode === "existing-branch" && !localBranchCommit) {
      throw new Error(`Git branch was not found: ${branchName}`);
    }
    const entries = await listWorktrees(resolution);
    const occupied = findOccupied(entries, branchName);
    if (request.mode === "new-branch" && (localBranchCommit || occupied)) {
      throw new Error(`Branch already exists: ${branchName}`);
    }

    let startPoint: string;
    if (request.mode === "existing-branch") {
      if (request.startPoint && request.startPoint.trim() !== branchName) {
        throw new Error(
          "Existing-branch worktree creation requires startPoint to equal branchName.",
        );
      }
      startPoint = branchName;
    } else {
      startPoint = request.startPoint?.trim() || "HEAD";
    }
    const baselineCommit =
      localBranchCommit ?? (await revParseCommit(resolution, startPoint, "start point"));
    const sourceBranchName = await resolveSourceBranchName(resolution);

    const repoPath = normalizeHostPath(resolution.repoRoot);
    const repositoryName = repoPath.split("/").pop()?.trim() || "repository";
    const worktreesBase = join(dirname(repoPath), `${repositoryName}-worktrees`);
    const candidate: GitWorktreeCreatePreview = {
      workspacePath: request.workspacePath,
      repoRoot: repoPath,
      gitCommonDir: normalizeHostPath(resolution.gitCommonDir ?? ""),
      mode: request.mode,
      branchName,
      startPoint,
      baselineCommit,
      targetPath: "",
      sourceBranchName,
      occupiedPath: occupied?.path ?? null,
    };
    candidate.targetPath = await assertSafeTarget(
      request.targetPath ||
        join(
          worktreesBase,
          `${safePathSegment(branchName) || "branch"}-${request.operationId.slice(0, 8)}`,
        ),
      resolution,
    );

    if (await pathExists(candidate.targetPath)) {
      const identity: WorktreeOperationIdentity = {
        ...candidate,
        version: 1,
        operationId: request.operationId,
        fingerprint: "",
      };
      identity.fingerprint = fingerprintRequest(identity);
      const record = await loadMatchingRecord(identity);
      if (!record || !verifyRegisteredTree(entries, candidate)) {
        throw new Error(`Worktree target path already exists: ${candidate.targetPath}`);
      }
    }
    return candidate;
  }

  function assertRepositoryIdentity(
    resolution: GitResolvedRepository,
    request: Pick<GitWorktreeCreateRequest, "repoRoot" | "gitCommonDir">,
  ): void {
    if (
      normalizeHostPath(resolution.repoRoot) !== request.repoRoot ||
      normalizeHostPath(resolution.gitCommonDir ?? "") !== request.gitCommonDir
    ) {
      throw new Error("Worktree repository identity changed; preview is stale.");
    }
  }

  async function validateCreatePreview(
    resolution: GitResolvedRepository,
    request: GitWorktreeCreateRequest,
  ): Promise<GitWorktreeListResult["worktrees"]> {
    validateOperationId(request.operationId);
    validateMode(request.mode);
    const branchName = request.branchName?.trim() ?? "";
    await validateBranchName(resolution, branchName);
    assertRepositoryIdentity(resolution, request);

    const localBranchCommit = await resolveLocalBranch(resolution, branchName);
    const entries = await listWorktrees(resolution);
    const registeredCandidate = verifyRegisteredTree(entries, request);
    if (request.mode === "existing-branch" && !localBranchCommit) {
      throw new Error(`Git branch was not found: ${branchName}`);
    }
    if (request.mode === "new-branch" && localBranchCommit && !registeredCandidate) {
      throw new Error(`Branch already exists: ${branchName}`);
    }

    let currentBaseline: string;
    if (request.mode === "existing-branch") {
      if (request.startPoint !== branchName) {
        throw new Error(
          "Existing-branch worktree creation requires startPoint to equal branchName.",
        );
      }
      currentBaseline = localBranchCommit!;
    } else {
      currentBaseline = await revParseCommit(resolution, request.startPoint, "start point");
    }
    if (currentBaseline !== request.baselineCommit) {
      throw new Error(
        `Worktree baseline commit changed: expected ${request.baselineCommit}, found ${currentBaseline}.`,
      );
    }

    const target = await assertSafeTarget(request.targetPath, resolution);
    if (normalizeHostPath(target) !== request.targetPath) {
      throw new Error("Worktree target path changed; preview is stale.");
    }
    const occupied = findOccupied(entries, branchName);
    if (occupied && normalizeHostPath(occupied.path) !== request.targetPath) {
      throw new Error(`Branch is already checked out in another worktree: ${occupied.path}`);
    }
    return entries;
  }

  async function runWorktreeAdd(
    resolution: GitResolvedRepository,
    request: GitWorktreeCreateRequest,
  ): Promise<void> {
    const args =
      request.mode === "new-branch"
        ? [
            "worktree",
            "add",
            "-b",
            request.branchName,
            "--",
            request.targetPath,
            request.startPoint,
          ]
        : ["worktree", "add", "--checkout", "--", request.targetPath, request.branchName];
    const result = await commandProvider.run({
      cwd: resolution.repoRoot,
      args,
      timeoutMs: DEFAULT_GIT_COMMAND_TIMEOUT_MS,
    });
    ensureGitCommandSucceeded("git worktree add", result);
  }

  return {
    async preview(request) {
      const resolution = ensureRepositoryAvailable(
        await options.resolveRepository(request.workspacePath),
        "preview worktree creation",
      );
      if (!resolution.gitCommonDir) throw new Error("Git common directory is unavailable.");
      return await buildPreview(resolution, request);
    },

    async create(request) {
      validateOperationId(request.operationId);
      validateMode(request.mode);
      const now = Date.now();
      const identity: WorktreeOperationIdentity = {
        version: 1,
        operationId: request.operationId,
        fingerprint: "",
        workspacePath: request.workspacePath,
        repoRoot: request.repoRoot,
        gitCommonDir: request.gitCommonDir,
        mode: request.mode,
        branchName: request.branchName,
        startPoint: request.startPoint,
        baselineCommit: request.baselineCommit,
        targetPath: request.targetPath,
        sourceBranchName: request.sourceBranchName,
      };
      identity.fingerprint = fingerprintRequest(identity);
      const key = `${identity.gitCommonDir}\0${identity.operationId}\0${identity.fingerprint}`;
      let execution = activeCreations.get(key);
      if (execution) {
        const shared = await execution;
        return { ...shared, created: false };
      }
      const executionController = Promise.withResolvers<GitWorktreeCreateResult>();
      execution = executionController.promise;
      activeCreations.set(key, execution);
      const cleanup = () => {
        if (activeCreations.get(key) === execution) activeCreations.delete(key);
      };
      void execution.then(cleanup, cleanup);
      try {
        const resolution = ensureRepositoryAvailable(
          await options.resolveRepository(request.workspacePath),
          "create worktree",
        );
        if (!resolution.gitCommonDir) throw new Error("Git common directory is unavailable.");
        assertRepositoryIdentity(resolution, request);
        void (async () => {
          const recordPath = operationRecordPath(identity.gitCommonDir, identity.operationId);
          let record = await loadMatchingRecord(identity);
          let reservedByThisCall = false;

          // RPC 结果丢失后的恢复优先于当前 startPoint 复检：同操作记录 + Git 台账
          // 中 target/branch/baseline 全部精确匹配，说明原请求已完成，源分支前进不是新请求。
          if (record && verifyRegisteredTree(await listWorktrees(resolution), request)) {
            if (record.state !== "completed") {
              await atomicReplace(
                recordPath,
                JSON.stringify({ ...record, state: "completed", updatedAt: Date.now() }, null, 2) +
                  "\n",
              );
            }
            options.invalidateRepository(request.workspacePath);
            options.invalidateRepository(request.targetPath);
            return {
              workspacePath: request.targetPath,
              branchName: request.branchName,
              baselineCommit: request.baselineCommit,
              created: false,
            };
          }

          const entries = await validateCreatePreview(resolution, request);
          const alreadyRegistered = verifyRegisteredTree(entries, request);
          if (!record) {
            if (alreadyRegistered || (await pathExists(identity.targetPath))) {
              throw new Error(`Worktree target path already exists: ${identity.targetPath}`);
            }
            record = {
              ...identity,
              state: "reserved",
              createdAt: now,
              updatedAt: now,
            };
            // wx is the cross-provider filesystem reservation; a losing process reads and validates the exact record.
            if (
              !(await exclusiveWriteIfAbsent(recordPath, `${JSON.stringify(record, null, 2)}\n`))
            ) {
              record = await loadMatchingRecord(identity);
              if (!record) {
                throw new Error(
                  `Worktree operation ${identity.operationId} already exists with a different request or an invalid record.`,
                );
              }
            } else {
              reservedByThisCall = true;
            }
          }

          const retryEntries = await listWorktrees(resolution);
          if (verifyRegisteredTree(retryEntries, request)) {
            if (record.state !== "completed") {
              await atomicReplace(
                recordPath,
                `${JSON.stringify({ ...record, state: "completed", updatedAt: Date.now() }, null, 2)}\n`,
              );
            }
            options.invalidateRepository(request.workspacePath);
            options.invalidateRepository(request.targetPath);
            return {
              workspacePath: request.targetPath,
              branchName: request.branchName,
              baselineCommit: request.baselineCommit,
              created: false,
            };
          }
          if (record.state === "completed") {
            throw new Error(
              `Worktree operation ${identity.operationId} is incomplete or its registered target is missing.`,
            );
          }
          if (!reservedByThisCall && (await pathExists(identity.targetPath))) {
            throw new Error(`Worktree target path already exists: ${identity.targetPath}`);
          }

          try {
            await runWorktreeAdd(resolution, request);
          } catch (error) {
            // Timeout/process failure is unknown only until Git facts are inspected.
            const latestEntries = await listWorktrees(resolution);
            if (!verifyRegisteredTree(latestEntries, request)) throw error;
            await atomicReplace(
              recordPath,
              `${JSON.stringify({ ...record, state: "completed", updatedAt: Date.now() }, null, 2)}\n`,
            );
            options.invalidateRepository(request.workspacePath);
            options.invalidateRepository(request.targetPath);
            return {
              workspacePath: request.targetPath,
              branchName: request.branchName,
              baselineCommit: request.baselineCommit,
              created: true,
            };
          }

          const latestEntries = await listWorktrees(resolution);
          if (!verifyRegisteredTree(latestEntries, request)) {
            throw new Error(
              "Git worktree creation result did not match the registered target, branch, and baseline commit.",
            );
          }
          await atomicReplace(
            recordPath,
            `${JSON.stringify({ ...record, state: "completed", updatedAt: Date.now() }, null, 2)}\n`,
          );
          options.invalidateRepository(request.workspacePath);
          options.invalidateRepository(request.targetPath);
          return {
            workspacePath: request.targetPath,
            branchName: request.branchName,
            baselineCommit: request.baselineCommit,
            created: true,
          };
        })().then(executionController.resolve, executionController.reject);
      } catch (error) {
        executionController.reject(error instanceof Error ? error : new Error(String(error)));
      }
      return await execution;
    },
  };
}
