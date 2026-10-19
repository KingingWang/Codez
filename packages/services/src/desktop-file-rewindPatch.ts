import { isAbsolute, relative, resolve } from "node:path";
import type { V4ConversationFileChangesResult } from "@codez/shared/codez-protocol-v4";

export type RewindPatchLine = "+" | "-" | " ";

export interface RewindPatch {
  readonly lines: readonly string[];
  readonly newLines: number;
  readonly newStart: number;
  readonly oldLines: number;
  readonly oldStart: number;
}

export interface RewindPathPlan {
  readonly absolutePath: string;
  readonly action: "restore" | "delete";
  readonly operationCount: number;
  readonly path: string;
  readonly patches: readonly RewindPatch[];
  readonly preimage: string;
  readonly toolNames: readonly string[];
}

export interface RewindPreview {
  readonly canApply: boolean;
  readonly ignoredFiles: Array<{
    readonly operationCount: number;
    readonly path: string;
    readonly reason: "bash_ignored";
    readonly toolNames: string[];
  }>;
  readonly safeFiles: Array<{
    readonly action: "restore" | "delete";
    readonly operationCount: number;
    readonly path: string;
    readonly toolNames: string[];
  }>;
  readonly unsafeFiles: Array<{
    readonly message?: string;
    readonly operationCount: number;
    readonly path: string;
    readonly reason:
      | "checkpoint_missing"
      | "checkpoint_unreadable"
      | "external_modified"
      | "file_read_failed"
      | "unsupported_checkpoint";
    readonly toolNames: string[];
  }>;
  readonly plans: readonly RewindPathPlan[];
}

function normalizeRelativePath(path: string): string {
  const normalized = path.replace(/\\/g, "/").replace(/^\/+/, "");
  if (normalized.length === 0 || normalized.split("/").includes("..") || isAbsolute(normalized))
    return "";
  return normalized;
}

export function resolveRewindFilePath(workspacePath: string, projectedPath: string): string {
  const workspaceRoot = resolve(workspacePath);
  // 原生 fileChange 的 path 是绝对路径（实测 codex app-server 0.156.x）。
  // 绝对路径必须按真实位置做工作区包含判定，不能剥掉根斜杠后拼回工作区。
  if (isAbsolute(projectedPath)) {
    const absolute = resolve(projectedPath);
    const rel = relative(workspaceRoot, absolute);
    return rel.startsWith("..") || isAbsolute(rel) ? "" : absolute;
  }
  const normalized = normalizeRelativePath(projectedPath);
  if (!normalized) return "";
  const absolute = resolve(workspaceRoot, normalized);
  const rel = relative(workspaceRoot, absolute);
  return rel.startsWith("..") || isAbsolute(rel) ? "" : absolute;
}

export function applyRewindPatches(
  current: string,
  patches: readonly RewindPatch[],
): string | null {
  // projection 的补丁按写入顺序描述 old -> new；撤销时必须反向消费。
  let lines = current.split("\n");
  for (const patch of [...patches].reverse()) {
    const start = patch.newStart - 1;
    if (start < 0 || start + patch.newLines > lines.length) return null;
    const actual = lines.slice(start, start + patch.newLines).join("\n");
    const projected = patch.lines
      .filter((line) => line[0] !== "-")
      .map((line) => line.slice(1))
      .join("\n");
    if (actual !== projected) return null;
    const replacement: string[] = [];
    for (const line of patch.lines) {
      if (line[0] === "-" || line[0] === " ") replacement.push(line.slice(1));
    }
    lines = [...lines.slice(0, start), ...replacement, ...lines.slice(start + patch.newLines)];
  }
  return lines.join("\n");
}

export function isTextFileContent(value: string): boolean {
  return !value.includes("\u0000");
}

export function buildRewindPreview(params: {
  currentFiles: ReadonlyMap<string, string>;
  workspacePath: string;
  projection: V4ConversationFileChangesResult;
}): RewindPreview {
  const ignoredFiles: RewindPreview["ignoredFiles"] = [];
  const safeFiles: RewindPreview["safeFiles"] = [];
  const unsafeFiles: RewindPreview["unsafeFiles"] = [];
  const plans: RewindPathPlan[] = [];
  for (const item of params.projection.items) {
    const operationCount = item.writeCount;
    const toolNames = [...item.toolNames];
    if (!item.toolNames.every((tool) => tool === "ApplyPatch")) {
      ignoredFiles.push({ operationCount, path: item.path, reason: "bash_ignored", toolNames });
      continue;
    }
    const absolutePath = resolveRewindFilePath(params.workspacePath, item.path);
    if (!absolutePath) {
      unsafeFiles.push({
        message: "Path is outside the workspace",
        operationCount,
        path: item.path,
        reason: "unsupported_checkpoint",
        toolNames,
      });
      continue;
    }
    const current = params.currentFiles.get(absolutePath);
    if (current === undefined) {
      unsafeFiles.push({
        operationCount,
        path: item.path,
        reason: "checkpoint_missing",
        toolNames,
      });
      continue;
    }
    if (!isTextFileContent(current)) {
      unsafeFiles.push({
        operationCount,
        path: item.path,
        reason: "unsupported_checkpoint",
        toolNames,
      });
      continue;
    }
    const preimage = applyRewindPatches(current, item.patches);
    if (preimage === null) {
      unsafeFiles.push({ operationCount, path: item.path, reason: "external_modified", toolNames });
      continue;
    }
    const action = preimage === "" ? "delete" : "restore";
    const plan: RewindPathPlan = {
      absolutePath,
      action,
      operationCount,
      path: item.path,
      patches: item.patches,
      preimage,

      toolNames,
    };
    plans.push(plan);
    safeFiles.push({ action, operationCount, path: item.path, toolNames });
  }
  return {
    canApply: unsafeFiles.length === 0 && safeFiles.length > 0,
    ignoredFiles,
    safeFiles,
    unsafeFiles,
    plans,
  };
}
