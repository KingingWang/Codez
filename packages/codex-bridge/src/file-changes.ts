import {
  v4ConversationFileChangesResultSchema,
  type V4ConversationFileChangesResult,
} from "@codez/shared/codez-protocol-v4";
import { array, object, string } from "./json.js";

type Patch = V4ConversationFileChangesResult["items"][number]["patches"][number];
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
export function projectTurnFileChanges(turn: unknown): V4ConversationFileChangesResult {
  const byPath = new Map<string, V4ConversationFileChangesResult["items"][number]>();
  for (const item of array(object(turn).items).map(object)) {
    if (item.type !== "fileChange" || item.status !== "completed") continue;
    for (const change of array(item.changes).map(object)) {
      const path = string(change.path);
      const patches = parsePatches(typeof change.diff === "string" ? change.diff : "");
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
    items,
  });
}
