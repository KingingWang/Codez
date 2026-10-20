import type {
  GitBranchDeletePreview,
  GitBranchDeletePreviewRequest,
  GitBranchDeleteResult,
  GitDeleteBranchRequest,
} from "@codez/shared";
import { DEFAULT_GIT_COMMAND_TIMEOUT_MS } from "../config.js";
import type { GitCommandProvider } from "../providers/gitCommandProvider.js";
import { ensureGitCommandSucceeded, ensureRepositoryAvailable } from "./gitCliHelpers.js";
import type { GitResolvedRepository } from "./gitCliTypes.js";
import { branchDeletionError } from "./gitRemovalErrors.js";

interface BranchSnapshot extends GitBranchDeletePreview {
  mergeBase: string | null;
}

interface ProviderFailure extends Error {
  result?: {
    stderr?: string;
    stdout?: string;
    timedOut?: boolean;
  };
}

const OID_PATTERN = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/i;
const BRANCH_ISSUE_CODES = new Set([
  "branch-is-current",
  "branch-checked-out",
  "branch-not-merged",
  "branch-not-found",
  "invalid-branch-name",
  "branch-moved",
  "unknown",
]);

function isBranchIssue(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const data = (error as { data?: unknown }).data;
  return (
    typeof data === "object" &&
    data !== null &&
    BRANCH_ISSUE_CODES.has(String((data as { code?: unknown }).code))
  );
}

function commandFailureMessage(error: unknown): string {
  if (error instanceof Error) {
    const providerFailure = error as ProviderFailure;
    const output = [providerFailure.result?.stderr, providerFailure.result?.stdout]
      .filter(Boolean)
      .join("\n")
      .trim();
    if (output) return output;
    return error.message;
  }
  return String(error);
}

function invalidBranchName(branchName: string): boolean {
  return (
    !branchName ||
    branchName !== branchName.trim() ||
    branchName.startsWith("-") ||
    branchName === "@" ||
    branchName.endsWith("/") ||
    branchName.endsWith(".") ||
    branchName.endsWith(".lock") ||
    branchName.includes("..") ||
    branchName.includes("//") ||
    branchName.includes("@{") ||
    /[\s~^:?[\\"]/.test(branchName) ||
    branchName.includes("\0") ||
    branchName.includes("\n") ||
    branchName.includes("\r")
  );
}

function validateBranchName(branchName: string): void {
  if (invalidBranchName(branchName)) {
    throw branchDeletionError(
      "invalid-branch-name",
      `Branch name is invalid: ${branchName || "<empty>"}`,
    );
  }
}

function validateDeleteRequest(request: GitDeleteBranchRequest): string {
  const branchName = typeof request.branchName === "string" ? request.branchName : "";
  validateBranchName(branchName);
  if (typeof request.force !== "boolean") {
    throw branchDeletionError("unknown", "Branch deletion force flag must be boolean.");
  }
  const expectedCommitHash = request.expectedCommitHash;
  if (typeof expectedCommitHash !== "string" || !OID_PATTERN.test(expectedCommitHash)) {
    throw branchDeletionError(
      "unknown",
      "Branch deletion requires a complete 40- or 64-hex expected commit hash.",
    );
  }
  return expectedCommitHash.toLowerCase();
}

function runOptions(resolution: GitResolvedRepository, args: string[]) {
  return {
    cwd: resolution.repoRoot,
    args,
    timeoutMs: DEFAULT_GIT_COMMAND_TIMEOUT_MS,
  };
}

function resultMessage(result: { stderr?: string; stdout?: string }): string {
  return [result.stderr, result.stdout].filter(Boolean).join("\n").trim();
}

function isCasFailure(message: string): boolean {
  const normalized = message.toLowerCase();
  return normalized.includes("cannot lock ref") && normalized.includes("but expected");
}

function toPreview(snapshot: BranchSnapshot): GitBranchDeletePreview {
  const {
    branchName,
    isCurrent,
    checkedOutPath,
    isMerged,
    commitHash,
    commitSubject,
    upstreamName,
  } = snapshot;
  return {
    branchName,
    isCurrent,
    checkedOutPath,
    isMerged,
    commitHash,
    commitSubject,
    upstreamName,
  };
}

export function createGitBranchDeletionHelper(options: {
  commandProvider: GitCommandProvider;
  resolveRepository: (workspacePath: string) => Promise<GitResolvedRepository>;
  invalidateRepository: (workspacePath: string) => void;
}): {
  preview(request: GitBranchDeletePreviewRequest): Promise<GitBranchDeletePreview>;
  delete(request: GitDeleteBranchRequest): Promise<GitBranchDeleteResult>;
} {
  const { commandProvider } = options;

  async function runGit(
    resolution: GitResolvedRepository,
    label: string,
    args: string[],
    allowedExitCodes: number[],
  ) {
    const result = await commandProvider.run(runOptions(resolution, args));
    ensureGitCommandSucceeded(label, result, allowedExitCodes);
    return result;
  }

  async function currentBranchName(resolution: GitResolvedRepository): Promise<string | null> {
    const result = await runGit(
      resolution,
      "git symbolic-ref --short HEAD",
      ["symbolic-ref", "--quiet", "--short", "HEAD"],
      [0, 1],
    );
    return result.exitCode === 1 ? null : result.stdout.trim() || null;
  }

  async function revisionExists(
    resolution: GitResolvedRepository,
    revision: string,
  ): Promise<boolean> {
    const result = await commandProvider.run(
      runOptions(resolution, ["rev-parse", "--verify", "--end-of-options", revision]),
    );
    return result.exitCode === 0 && !result.timedOut && !result.outputTruncated;
  }

  async function branchIsAncestor(
    resolution: GitResolvedRepository,
    branchName: string,
    baseRef: string,
  ): Promise<boolean | null> {
    const result = await commandProvider.run(
      runOptions(resolution, ["merge-base", "--is-ancestor", `refs/heads/${branchName}`, baseRef]),
    );
    if (
      !result.timedOut &&
      !result.outputTruncated &&
      (result.exitCode === 0 || result.exitCode === 1)
    ) {
      return result.exitCode === 0;
    }
    return null;
  }

  async function loadSnapshot(
    resolution: GitResolvedRepository,
    branchName: string,
  ): Promise<BranchSnapshot | null> {
    const current = await currentBranchName(resolution);
    const result = await runGit(
      resolution,
      "git for-each-ref refs/heads",
      [
        "for-each-ref",
        "refs/heads",
        "--format=%(refname)%00%(objectname)%00%(upstream:short)%00%(worktreepath)%00%(contents:subject)",
      ],
      [0],
    );
    const wanted = `refs/heads/${branchName}`;
    const line = result.stdout
      .replace(/\r\n/g, "\n")
      .split("\n")
      .find((item) => item.startsWith(`${wanted}\0`));
    if (!line) return null;

    const [, commitHash, upstreamName, checkedOutPath, commitSubject] = line.split("\0");
    const normalizedCommit = commitHash?.toLowerCase() ?? "";
    if (!OID_PATTERN.test(normalizedCommit)) {
      throw branchDeletionError(
        "unknown",
        "Git local branch did not resolve to a complete commit hash.",
      );
    }

    return {
      branchName,
      isCurrent: current === branchName,
      checkedOutPath: checkedOutPath?.trim() || null,
      isMerged: null,
      commitHash: normalizedCommit,
      commitSubject: commitSubject || null,
      upstreamName: upstreamName || null,
      mergeBase: null,
    };
  }

  async function withMergeState(
    resolution: GitResolvedRepository,
    snapshot: BranchSnapshot,
  ): Promise<BranchSnapshot> {
    const baseRef = snapshot.upstreamName || "HEAD";
    if (!(await revisionExists(resolution, `${baseRef}^{commit}`))) return snapshot;
    const merged = await branchIsAncestor(resolution, snapshot.branchName, baseRef);
    if (merged === null) return snapshot;
    snapshot.mergeBase = baseRef;
    snapshot.isMerged = merged;
    return snapshot;
  }

  async function buildPreview(
    resolution: GitResolvedRepository,
    branchName: string,
  ): Promise<BranchSnapshot> {
    const snapshot = await loadSnapshot(resolution, branchName);
    if (!snapshot) {
      throw branchDeletionError("branch-not-found", `Git branch was not found: ${branchName}`);
    }
    return await withMergeState(resolution, snapshot);
  }

  async function removeBranchConfig(
    resolution: GitResolvedRepository,
    branchName: string,
  ): Promise<boolean> {
    try {
      const result = await commandProvider.run(
        runOptions(resolution, ["config", "--remove-section", `branch.${branchName}`]),
      );
      if (result.timedOut || result.outputTruncated) return false;
      if (result.exitCode === 0) return true;
      // 真实 Git 对 absent section 返回 128 与 fatal: no such section；它已经是目标状态。
      if (result.exitCode === 128 && result.stderr.toLowerCase().includes("no such section")) {
        return true;
      }
      return false;
    } catch {
      // 配置清理不参与删除授权：provider 抛错只降级为 false，不把已成功的 CAS 包装成失败。
      return false;
    }
  }

  async function deleteRefWithCas(
    resolution: GitResolvedRepository,
    branchName: string,
    expectedCommitHash: string,
  ): Promise<void> {
    // 只删除严格本地 ref，并让 Git 在同一命令内做 expected-OID CAS；
    // 禁用 git branch -d|-D，避免复检与删除之间没有原子保护。
    const result = await commandProvider.run(
      runOptions(resolution, ["update-ref", "-d", `refs/heads/${branchName}`, expectedCommitHash]),
    );
    if (result.exitCode === 0 && !result.timedOut && !result.outputTruncated) return;
    const message = resultMessage(result);
    if (!result.timedOut && !result.outputTruncated && isCasFailure(message)) {
      // CAS 失败发生在最新预览之后；重查一次只为给 UI 刷新数据，不作为删除授权。
      const latestSnapshot = await loadSnapshot(resolution, branchName);
      throw branchDeletionError(
        "branch-moved",
        "Branch moved before deletion.",
        latestSnapshot ? toPreview(await withMergeState(resolution, latestSnapshot)) : undefined,
      );
    }
    ensureGitCommandSucceeded("git update-ref -d refs/heads/<branch>", result);
  }

  return {
    async preview(request: GitBranchDeletePreviewRequest): Promise<GitBranchDeletePreview> {
      const branchName = typeof request.branchName === "string" ? request.branchName : "";
      validateBranchName(branchName);
      try {
        const resolution = ensureRepositoryAvailable(
          await options.resolveRepository(request.workspacePath),
          "preview branch deletion",
        );
        return toPreview(await buildPreview(resolution, branchName));
      } catch (error) {
        if (isBranchIssue(error)) throw error;
        throw branchDeletionError(
          "unknown",
          `Preview branch deletion failed: ${commandFailureMessage(error)}`,
        );
      }
    },

    async delete(request: GitDeleteBranchRequest): Promise<GitBranchDeleteResult> {
      const branchName = typeof request.branchName === "string" ? request.branchName : "";
      const expectedCommitHash = validateDeleteRequest({ ...request, branchName });
      let latestPreview: BranchSnapshot | undefined;
      try {
        const resolution = ensureRepositoryAvailable(
          await options.resolveRepository(request.workspacePath),
          "delete branch",
        );
        // 删除前禁止复用 preview 缓存；以下预览包含实时 current、占用与合并状态。
        latestPreview = await buildPreview(resolution, branchName);
        if (latestPreview.isCurrent) {
          throw branchDeletionError(
            "branch-is-current",
            "Cannot delete the current branch.",
            latestPreview ? toPreview(latestPreview) : undefined,
          );
        }
        if (latestPreview.checkedOutPath) {
          throw branchDeletionError(
            "branch-checked-out",
            `Branch is checked out in: ${latestPreview.checkedOutPath}`,
            latestPreview ? toPreview(latestPreview) : undefined,
          );
        }
        if (latestPreview.commitHash !== expectedCommitHash) {
          throw branchDeletionError(
            "branch-moved",
            "Branch moved before deletion.",
            latestPreview ? toPreview(latestPreview) : undefined,
          );
        }
        if (!request.force && latestPreview.isMerged !== true) {
          throw branchDeletionError(
            "branch-not-merged",
            latestPreview.isMerged === null
              ? "Branch merge status is unknown; refusing safe deletion."
              : "Branch contains commits not present in its merge base.",
            latestPreview ? toPreview(latestPreview) : undefined,
          );
        }

        await deleteRefWithCas(resolution, branchName, expectedCommitHash);
        const configCleanupSucceeded = await removeBranchConfig(resolution, branchName);
        options.invalidateRepository(request.workspacePath);
        return { deleted: true, configCleanupSucceeded };
      } catch (error) {
        if (isBranchIssue(error)) throw error;
        const action = latestPreview ? "Delete branch" : "Resolve branch for deletion";
        throw branchDeletionError(
          "unknown",
          `${action} failed: ${commandFailureMessage(error)}`,
          latestPreview ? toPreview(latestPreview) : undefined,
        );
      }
    },
  };
}
