import {
  v4ConversationFileChangesResultSchema,
  type V4ConversationFileChangesResult,
} from "@codez/shared/codez-protocol-v4";
import { array, object, string } from "./json.js";

type Patch = V4ConversationFileChangesResult["items"][number]["patches"][number];

/**
 * 实测 wire 形状（codex app-server 0.156.x）：add/delete 的 diff 是完整文件正文
 * （add=新内容，delete=旧内容），不是 unified hunk；update 才是 @@ 段。
 * 正文按行拆分，末尾换行产生的空尾巴不是真实行。
 */
function contentLines(diff: string): string[] {
  if (!diff) return [];
  const lines = diff.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  return lines;
}

/** add/delete 合成为等效全量行补丁，使统计与撤销 preimage 推导都基于真实内容。 */
function synthesizeFullRangePatch(diff: string, kind: "add" | "delete"): Patch {
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

function changeKind(change: Record<string, unknown>): "add" | "delete" | "update" | undefined {
  const kind = change.kind;
  if (!kind || typeof kind !== "object" || Array.isArray(kind)) return undefined;
  const type = (kind as Record<string, unknown>).type;
  return type === "add" || type === "delete" || type === "update" ? type : undefined;
}

function parsePatches(diff: string): Patch[] {
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
    } else if (current && /^[ +\\-]/.test(line)) current.lines.push(line);
  }
  return patches;
}

/** Facts describe what Codex applied during this turn, not the current Git working tree. */
export function projectTurnFileChanges(
  turn: unknown,
  state: "active" | "reverted" = "active",
): V4ConversationFileChangesResult {
  const byPath = new Map<string, V4ConversationFileChangesResult["items"][number]>();
  for (const item of array(object(turn).items).map(object)) {
    if (item.type !== "fileChange" || item.status !== "completed") continue;
    for (const change of array(item.changes).map(object)) {
      const path = string(change.path);
      const diff = typeof change.diff === "string" ? change.diff : "";
      const kind = changeKind(change);
      // add/delete 的正文不能走 hunk 解析：正文行恰好形如 @@ 头时会被误读。
      // kind 缺失（旧版本）保持 hunk 解析的兼容行为。
      const patches =
        kind === "add" || kind === "delete"
          ? [synthesizeFullRangePatch(diff, kind)]
          : parsePatches(diff);
      const lines = patches.flatMap((patch) => patch.lines);
      const previous = byPath.get(path) ?? {
        path,
        additions: 0,
        deletions: 0,
        writeCount: 0,
        toolNames: ["ApplyPatch"],
        patches: [],
      };
      previous.additions += lines.filter((line) => line.startsWith("+")).length;
      previous.deletions += lines.filter((line) => line.startsWith("-")).length;
      previous.writeCount += 1;
      previous.patches.push(...patches);
      byPath.set(path, previous);
    }
  }
  const items = [...byPath.values()];
  return v4ConversationFileChangesResultSchema.parse({
    files: items.length,
    additions: items.reduce((sum, item) => sum + item.additions, 0),
    deletions: items.reduce((sum, item) => sum + item.deletions, 0),
    ...(items.length > 0 ? { state } : {}),
    items,
  });
}
