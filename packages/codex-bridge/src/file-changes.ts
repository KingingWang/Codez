import {
  v4ConversationFileChangesResultSchema,
  type V4ConversationFileChangesResult,
} from "@codez/shared/codez-protocol-v4";
import { array, object } from "./json.js";
import { normalizeNativeFileChange } from "./native-file-change-display.js";

const settledTurnFileChangesCache = new WeakMap<
  object,
  {
    itemsRef: unknown;
    itemsLength: number;
    active: V4ConversationFileChangesResult;
    reverted: V4ConversationFileChangesResult;
  }
>();

/** Facts describe what Codex applied during this turn, not the current Git working tree. */
export function projectTurnFileChanges(
  turn: unknown,
  state: "active" | "reverted" = "active",
): V4ConversationFileChangesResult {
  const turnObj = object(turn);
  const rawItems = array(turnObj.items);
  const canCache = turnObj.status !== "inProgress" && typeof turn === "object" && turn !== null;
  if (canCache) {
    const cached = settledTurnFileChangesCache.get(turnObj);
    if (cached && cached.itemsRef === turnObj.items && cached.itemsLength === rawItems.length) {
      return state === "reverted" ? cached.reverted : cached.active;
    }
  }
  const byPath = new Map<string, V4ConversationFileChangesResult["items"][number]>();
  for (const item of rawItems.map(object)) {
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
  const active = v4ConversationFileChangesResultSchema.parse({
    files: items.length,
    additions: items.reduce((sum, item) => sum + item.additions, 0),
    deletions: items.reduce((sum, item) => sum + item.deletions, 0),
    ...(items.length > 0 ? { state: "active" as const } : {}),
    items,
  });
  const reverted: V4ConversationFileChangesResult =
    items.length > 0 ? { ...active, state: "reverted" } : active;
  if (canCache) {
    settledTurnFileChangesCache.set(turnObj, {
      itemsRef: turnObj.items,
      itemsLength: rawItems.length,
      active,
      reverted,
    });
  }
  return state === "reverted" ? reverted : active;
}
