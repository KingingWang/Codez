import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, opendir, readlink, realpath } from "node:fs/promises";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { GitChangeSectionId, GitFileChange } from "@codez/shared";
import { DEFAULT_GIT_OUTPUT_BYTES } from "../config.js";
import type { GitCommandProvider } from "../providers/gitCommandProvider.js";
import { ensureGitCommandSucceeded, parseNumstat, parseStatusPorcelain } from "./gitCliHelpers.js";
import type { GitStatusEntry } from "./gitCliTypes.js";

export interface WorktreeRemovalScanBudget {
  maxFiles: number;
  maxBytes: number;
}
export const DEFAULT_REMOVAL_SCAN_BUDGET: WorktreeRemovalScanBudget = {
  maxFiles: 5000,
  maxBytes: 256 * 1024 * 1024,
};
const hash = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");
const sensitiveName = (path: string) =>
  /^(?:\.env(?:\..*)?|\.npmrc|\.pypirc|\.netrc|_netrc|credentials(?:\.json)?|secrets\..*|.*\.(?:pem|key|p12|pfx))$/i.test(
    basename(path),
  );
const text = (result: { stdout: string; stdoutBuffer?: Buffer }) =>
  result.stdoutBuffer?.toString("utf8") ?? result.stdout;

export async function scanWorktreeRemoval(
  root: string,
  provider: GitCommandProvider,
  budget = DEFAULT_REMOVAL_SCAN_BUDGET,
) {
  const run = (args: string[], maxOutputBytes = DEFAULT_GIT_OUTPUT_BYTES) =>
    provider.run({ cwd: root, args, maxOutputBytes, binaryOutput: true });
  const [status, ignored, modules, stagedStats, unstagedStats] = await Promise.all([
    run(["status", "--porcelain=v2", "--branch", "--untracked-files=all", "-z"]),
    run(["ls-files", "--others", "--ignored", "--exclude-standard", "-z"]),
    run(["ls-files", "--stage", "-z"]),
    run([
      "diff",
      "--cached",
      "--no-ext-diff",
      "--no-textconv",
      "--numstat",
      "-z",
      "--find-renames",
      "--",
    ]),
    run(["diff", "--no-ext-diff", "--no-textconv", "--numstat", "-z", "--find-renames", "--"]),
  ]);
  let scanComplete =
    [status, ignored, modules, stagedStats, unstagedStats].every(
      (result) => result.exitCode === 0 && !result.timedOut && !result.outputTruncated,
    ) &&
    !text(modules)
      .split("\0")
      .some((record) => record.startsWith("160000 "));
  // .gitmodules 可被删除；全量 gitlink 与嵌套 .git 探测不能依赖 status 的改动列表。
  async function hasNoNestedRepository(): Promise<boolean> {
    const directories = [root];
    let inspected = 0;
    while (directories.length) {
      const directory = directories.pop()!;
      const rel = relative(root, await realpath(directory));
      if (
        rel === ".." ||
        rel.startsWith(`..${sep}`) ||
        isAbsolute(rel) ||
        (await lstat(directory)).isSymbolicLink()
      )
        return false;
      for await (const item of await opendir(directory)) {
        if (item.name === ".git") {
          if (directory !== root) return false;
          continue;
        }
        if (++inspected > budget.maxFiles) return false;
        if (item.isDirectory()) directories.push(join(directory, item.name));
      }
    }
    return true;
  }
  try {
    if (!(await hasNoNestedRepository())) scanComplete = false;
  } catch {
    scanComplete = false;
  }
  const rawStatus = text(status);
  const parsedStatus = parseStatusPorcelain(rawStatus, { literalPaths: true });
  const entries = parsedStatus.entries;
  const headCommitHash =
    rawStatus
      .split("\0")
      .find((record) => record.startsWith("# branch.oid "))
      ?.slice(13) ?? null;
  const ignoredPaths = text(ignored).split("\0").filter(Boolean);
  // 未跟踪的嵌套仓库会以目录项出现；不能把目录读取失败当作零字节文件。
  if (ignoredPaths.some((path) => path.endsWith("/"))) scanComplete = false;
  const attention = [
    ...new Set([
      ...entries
        .filter((entry) => entry.isUntracked && sensitiveName(entry.path))
        .map((entry) => entry.path),
      ...ignoredPaths.filter(sensitiveName),
    ]),
  ].sort();
  const changes: GitFileChange[] = [];
  const stagedLines = parseNumstat(text(stagedStats), { literalPaths: true });
  const unstagedLines = parseNumstat(text(unstagedStats), { literalPaths: true });
  const untrackedLines = new Map<string, number>();
  const descriptors: unknown[][] = [];
  let filesRead = 0;
  let bytesRead = 0;
  const consume = (size: number) => {
    filesRead++;
    bytesRead += size;
    if (filesRead > budget.maxFiles || bytesRead > budget.maxBytes) {
      scanComplete = false;
      return false;
    }
    return true;
  };

  async function absolutePath(path: string): Promise<string> {
    const full = resolve(root, path);
    const rel = relative(root, full);
    if (isAbsolute(path) || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
      throw new Error("Git path escapes worktree.");
    }
    const parts = rel.split(sep);
    let parent = root;
    for (const part of parts.slice(0, -1)) {
      parent = join(parent, part);
      if ((await lstat(parent)).isSymbolicLink()) throw new Error("Symlink parent is unsafe.");
    }
    return full;
  }

  async function workingBytes(path: string, missingExpected: boolean): Promise<[number, string]> {
    const full = await absolutePath(path);
    let info;
    try {
      info = await lstat(full);
    } catch (error) {
      if (missingExpected && (error as NodeJS.ErrnoException).code === "ENOENT")
        return [0, "deleted"];
      throw error;
    }
    if (missingExpected) throw new Error("Deleted file was recreated during scan.");
    if (info.isSymbolicLink()) {
      const bytes = Buffer.from(await readlink(full));
      if (!consume(bytes.length)) return [bytes.length, "over-budget"];
      untrackedLines.set(path, bytes.toString().split("\n").length);
      return [bytes.length, hash(bytes)];
    }
    if (!info.isFile()) throw new Error("Non-file path cannot be scanned.");
    if (!consume(info.size)) return [info.size, "over-budget"];
    // O_NOFOLLOW 防止检查后末端被替换成 symlink 时读取树外文件。
    const file = await open(full, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      const before = await file.stat();
      if (!before.isFile() || before.size !== info.size)
        throw new Error("File changed before scan.");
      const digest = createHash("sha256");
      const buffer = Buffer.allocUnsafe(64 * 1024);
      let count = 0;
      let newlines = 0;
      let binary = false;
      let lastByte = 10;
      for (;;) {
        const result = await file.read(buffer, 0, buffer.length, null);
        if (!result.bytesRead) break;
        count += result.bytesRead;
        if (count > info.size) throw new Error("File grew during scan.");
        const bytes = buffer.subarray(0, result.bytesRead);
        digest.update(bytes);
        binary ||= bytes.includes(0);
        for (const byte of bytes) if (byte === 10) newlines++;
        lastByte = bytes[bytes.length - 1]!;
      }
      const after = await file.stat();
      if (
        count !== before.size ||
        after.size !== before.size ||
        after.mtimeMs !== before.mtimeMs ||
        after.ctimeMs !== before.ctimeMs
      ) {
        throw new Error("File changed during scan.");
      }
      untrackedLines.set(path, binary ? 0 : newlines + (count > 0 && lastByte !== 10 ? 1 : 0));
      return [count, digest.digest("hex")];
    } finally {
      await file.close();
    }
  }

  const stagedPaths = entries
    .filter(
      (entry) =>
        !entry.isUntracked && !entry.isConflicted && entry.x && entry.x !== "." && entry.x !== "D",
    )
    .map((entry) => entry.path);
  const indexObjects = new Map<string, { oid: string; mode: string }>();
  if (stagedPaths.length) {
    const index = await run([
      "--literal-pathspecs",
      "ls-files",
      "--stage",
      "-z",
      "--",
      ...stagedPaths,
    ]);
    if (index.exitCode !== 0 || index.timedOut || index.outputTruncated) scanComplete = false;
    for (const record of text(index).split("\0").filter(Boolean)) {
      const tab = record.indexOf("\t");
      const [mode, oid, stage] = record.slice(0, tab).split(" ");
      if (tab < 0 || !mode || !oid || stage !== "0") {
        scanComplete = false;
        continue;
      }
      indexObjects.set(record.slice(tab + 1), { mode, oid });
    }
  }

  async function indexedBytes(path: string, deleted: boolean): Promise<[number, string]> {
    if (deleted) return [0, "deleted"];
    const object = indexObjects.get(path);
    if (!object || object.mode === "160000") throw new Error("Index blob unavailable.");
    const sizeResult = await run(["cat-file", "-s", object.oid]);
    ensureGitCommandSucceeded("git cat-file -s", sizeResult);
    const size = Number(text(sizeResult).trim());
    if (!Number.isSafeInteger(size) || size < 0) throw new Error("Invalid blob size.");
    if (!consume(size)) return [size, "over-budget"];
    const blob = await run(["cat-file", "blob", object.oid], Math.max(size + 1, 1024));
    ensureGitCommandSucceeded("git cat-file blob", blob);
    if (!blob.stdoutBuffer || blob.stdoutBuffer.length !== size)
      throw new Error("Incomplete blob.");
    return [size, hash(blob.stdoutBuffer)];
  }

  const workingCache = new Map<string, [number, string]>();
  async function describe(path: string, section: string, kind: string, deleted = false) {
    let content: [number, string];
    try {
      if (section === "staged") content = await indexedBytes(path, deleted);
      else {
        content = workingCache.get(path) ?? (await workingBytes(path, deleted));
        workingCache.set(path, content);
      }
    } catch {
      scanComplete = false;
      content = [0, "unreadable"];
    }
    descriptors.push([path, section, kind, ...content]);
  }

  async function addChange(entry: GitStatusEntry, section: GitChangeSectionId, deleted: boolean) {
    await describe(entry.path, section, deleted ? "deleted" : entry.kind, deleted);
    const lines =
      section === "staged" ? stagedLines.get(entry.path) : unstagedLines.get(entry.path);
    changes.push({
      path: resolve(root, entry.path),
      repoRelativePath: entry.path,
      workspaceRelativePath: entry.path,
      x: entry.x ?? undefined,
      y: entry.y ?? undefined,
      kind: deleted ? "deleted" : entry.kind,
      section,
      added: section === "untracked" ? (untrackedLines.get(entry.path) ?? 0) : (lines?.added ?? 0),
      removed: lines?.removed ?? 0,
      isStaged: section === "staged",
      isUntracked: entry.isUntracked,
      isConflicted: entry.isConflicted,
    });
    if (entry.originalPath) descriptors.push([entry.path, "renamed-from", entry.originalPath]);
  }
  for (const entry of entries) {
    if (entry.isConflicted) {
      scanComplete = false;
      await addChange(entry, "conflicted", false);
    } else if (entry.isUntracked) await addChange(entry, "untracked", false);
    else {
      if (entry.x && entry.x !== ".") await addChange(entry, "staged", entry.x === "D");
      if (entry.y && entry.y !== ".") await addChange(entry, "unstaged", entry.y === "D");
    }
  }
  for (const path of attention) await describe(path, "attention", "local-config");
  changes.sort(
    (a, b) =>
      a.repoRelativePath.localeCompare(b.repoRelativePath) || a.section.localeCompare(b.section),
  );
  descriptors.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  const finalStatus = await run([
    "status",
    "--porcelain=v2",
    "--branch",
    "--untracked-files=all",
    "-z",
  ]);
  // status 与 index/blob 读取分步完成；期间台账快照变化必须降级，不能拼接两个版本。
  if (
    finalStatus.exitCode !== 0 ||
    finalStatus.timedOut ||
    finalStatus.outputTruncated ||
    text(finalStatus) !== rawStatus
  )
    scanComplete = false;
  return {
    changes: changes.slice(0, 100),
    totalChangeCount: changes.length,
    attentionPaths: attention.slice(0, 100).map((path) => resolve(root, path)),
    attentionTotalCount: attention.length,
    scanComplete,
    descriptors,
    headCommitHash,
    branchName: parsedStatus.branchName,
    isDetached: parsedStatus.headRefType === "detached",
  };
}
