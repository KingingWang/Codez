import { TOOL_DIFF_DISPLAY_MAX_HUNKS, TOOL_DIFF_DISPLAY_MAX_LINES } from "@codez/shared";
import type {
  ToolResultDisplay,
  V4ConversationFileChangesResult,
} from "@codez/shared/codez-protocol-v4";
import type { CodexKnownItem } from "./codex-types.js";
import { string } from "./json.js";

type Patch = V4ConversationFileChangesResult["items"][number]["patches"][number];
type FileDiffDisplay = Extract<ToolResultDisplay, { kind: "file_diff" }>;
type FileDiffGroupDisplay = Extract<ToolResultDisplay, { kind: "file_diffs" }>;
type NativeFileChange = Extract<CodexKnownItem, { type: "fileChange" }>["changes"][number];

// input/output 的 64 KiB 预览仍随行保留；display 单独限额，避免 60-row tail window 膨胀。
const MAX_NATIVE_FILE_DIFF_DISPLAY_BYTES = 48 * 1024;
const MAX_NATIVE_FILE_DIFF_DISPLAY_FILES = 32;

function contentLines(diff: string): string[] {
  if (!diff) return [];
  const lines = diff.split("\n");
  if (lines.at(-1) === "") lines.pop();
  return lines;
}

function fullContentPatch(diff: string, kind: "add" | "delete"): Patch {
  const lines = contentLines(diff);
  return kind === "add"
    ? {
        oldStart: 0,
        oldLines: 0,
        newStart: 1,
        newLines: lines.length,
        lines: lines.map((line) => `+${line}`),
      }
    : {
        oldStart: 1,
        oldLines: lines.length,
        newStart: 0,
        newLines: 0,
        lines: lines.map((line) => `-${line}`),
      };
}

function parseUpdatePatches(diff: string): Patch[] {
  const patches: Patch[] = [];
  let current: Patch | undefined;
  for (const line of diff.split("\n")) {
    const match = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (match) {
      current = {
        oldStart: Number(match[1]),
        oldLines: Number(match[2] ?? 1),
        newStart: Number(match[3]),
        newLines: Number(match[4] ?? 1),
        lines: [],
      };
      patches.push(current);
    } else if (current && /^[ +-]/.test(line)) {
      current.lines.push(line);
    }
  }
  return patches;
}

export function normalizeNativeFileChange(change: Record<string, unknown>) {
  const path = string(change.path);
  if (!path) return null;
  const diff = typeof change.diff === "string" ? change.diff : "";
  const rawKind =
    change.kind && typeof change.kind === "object" && !Array.isArray(change.kind)
      ? (change.kind as Record<string, unknown>)
      : {};
  const operation: "add" | "delete" | "update" =
    rawKind.type === "add" || rawKind.type === "delete" ? rawKind.type : "update";
  const movePath =
    operation === "update" && typeof rawKind.move_path === "string" ? rawKind.move_path : "";
  // 原因：原生 add/delete 的 diff 是文件全文，只有 update 才含 @@ hunk。
  // 按同一份完整事实归一化，轮次摘要与工具卡才能得到一致的准确统计。
  const patches =
    operation === "add" || operation === "delete"
      ? [fullContentPatch(diff, operation)]
      : parseUpdatePatches(diff);
  const lines = patches.flatMap((patch) => patch.lines);
  return {
    path,
    operation,
    ...(movePath ? { movePath } : {}),
    patches,
    additions: lines.filter((line) => line.startsWith("+")).length,
    deletions: lines.filter((line) => line.startsWith("-")).length,
  };
}

export function projectNativeFileChangeDisplay(
  changes: readonly NativeFileChange[],
): FileDiffDisplay | FileDiffGroupDisplay | undefined {
  const normalized = changes
    .map((change) => normalizeNativeFileChange(change))
    .filter((change): change is NonNullable<typeof change> => change !== null);
  if (normalized.length === 0) return undefined;

  let remainingHunks = TOOL_DIFF_DISPLAY_MAX_HUNKS;
  let remainingLines = TOOL_DIFF_DISPLAY_MAX_LINES;
  const files: FileDiffDisplay[] = [];
  for (const change of normalized.slice(0, MAX_NATIVE_FILE_DIFF_DISPLAY_FILES)) {
    const structuredPatch: Patch[] = [];
    for (const hunk of change.patches) {
      if (remainingHunks === 0 || remainingLines === 0) break;
      const lines = hunk.lines.slice(0, remainingLines);
      structuredPatch.push({ ...hunk, lines });
      remainingHunks--;
      remainingLines -= lines.length;
      if (lines.length < hunk.lines.length) break;
    }
    const truncated =
      structuredPatch.length < change.patches.length ||
      structuredPatch.some(
        (hunk, index) => hunk.lines.length < change.patches[index]!.lines.length,
      );
    files.push({
      kind: "file_diff",
      filePath: change.path,
      operation: change.operation,
      ...(change.movePath ? { movePath: change.movePath } : {}),
      additions: change.additions,
      deletions: change.deletions,
      structuredPatch,
      ...(truncated ? { truncated: true } : {}),
    });
  }

  // 原始 input/output 仍保留头尾预览；有界 display 只承担工具卡展示，绝不回写权威历史。
  const group: FileDiffGroupDisplay = {
    kind: "file_diffs",
    totalFiles: normalized.length,
    additions: normalized.reduce((sum, file) => sum + file.additions, 0),
    deletions: normalized.reduce((sum, file) => sum + file.deletions, 0),
    files,
    ...(files.length < normalized.length || files.some((file) => file.truncated)
      ? { truncated: true }
      : {}),
  };
  const display: FileDiffDisplay | FileDiffGroupDisplay =
    normalized.length === 1 ? files[0]! : group;
  while (Buffer.byteLength(JSON.stringify(display), "utf8") > MAX_NATIVE_FILE_DIFF_DISPLAY_BYTES) {
    // 原因：按尾部文件依次丢弃会被首文件的一条超长代码行吞掉整个预算，
    // 导致其余文件名也消失。优先缩减占字节最多的 patch，最后才省略文件元数据。
    let largest: FileDiffDisplay | undefined;
    let largestBytes = 0;
    for (const file of files) {
      if (!file.structuredPatch.some((hunk) => hunk.lines.length > 0)) continue;
      const bytes = Buffer.byteLength(JSON.stringify(file.structuredPatch), "utf8");
      if (bytes > largestBytes) {
        largest = file;
        largestBytes = bytes;
      }
    }
    const last = largest ?? files.at(-1);
    if (!last) return undefined;
    while (last.structuredPatch.at(-1)?.lines.length === 0) last.structuredPatch.pop();
    const hunk = last.structuredPatch.at(-1);
    if (hunk?.lines.length) {
      hunk.lines.pop();
      if (hunk.lines.length === 0) last.structuredPatch.pop();
      last.truncated = true;
    } else if (display.kind === "file_diffs") {
      files.pop();
    } else {
      return undefined;
    }
    if (display.kind === "file_diffs") display.truncated = true;
  }
  return display;
}
