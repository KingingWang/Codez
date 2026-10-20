import {
  v4ConversationFileChangesResultSchema,
  type V4ConversationFileChangesResult,
} from "@codez/shared/codez-protocol-v4";
import { array, object } from "./json.js";
import { normalizeNativeFileChange } from "./native-file-change-display.js";

/** Facts describe what Codex applied during this turn, not the current Git working tree. */
export function projectTurnFileChanges(
  turn: unknown,
  state: "active" | "reverted" = "active",
): V4ConversationFileChangesResult {
  const byPath = new Map<string, V4ConversationFileChangesResult["items"][number]>();
  for (const item of array(object(turn).items).map(object)) {
    if (item.type !== "fileChange" || item.status !== "completed") continue;
    for (const change of array(item.changes).map(object)) {
      const normalized = normalizeNativeFileChange(change);
      if (!normalized) continue;
      const previous = byPath.get(normalized.path) ?? {
        path: normalized.path,
        additions: 0,
        deletions: 0,
        writeCount: 0,
        toolNames: ["ApplyPatch"],
        patches: [],
      };
      previous.additions += normalized.additions;
      previous.deletions += normalized.deletions;
      previous.writeCount += 1;
      previous.patches.push(...normalized.patches);
      byPath.set(normalized.path, previous);
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
