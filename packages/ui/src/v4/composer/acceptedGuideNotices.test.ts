import assert from "node:assert/strict";
import test from "node:test";
import type { ConversationSnapshot } from "@codez/shared/codez-protocol-v4";
import { recordAcceptedGuideNotice, visibleAcceptedGuideNotices } from "./acceptedGuideNotices.js";

const snapshot = (
  inputs: { rowId: number; text: string; sourceCommandId?: string; guided?: boolean }[] = [],
) =>
  ({
    rows: {
      window: inputs.map((row) => ({ ...row, turnId: "turn-a", kind: "userInput" as const })),
    },
  }) as unknown as Pick<ConversationSnapshot, "rows">;

test("accepted Codex guidance is cleared only by its native command ID, even without guided flag", () => {
  const before = snapshot([{ rowId: 1, text: "first input" }]);
  const first = recordAcceptedGuideNotice([], {
    id: 1,
    workspaceKey: "remote-a",
    sessionId: "session-a",
    turnId: "turn-a",
    text: "guide",
    sourceCommandId: "command-1",
    snapshot: before,
  });
  const second = recordAcceptedGuideNotice(first, {
    id: 2,
    workspaceKey: "remote-a",
    sessionId: "session-a",
    turnId: "turn-a",
    text: "guide",
    sourceCommandId: "command-2",
    snapshot: before,
  });
  assert.deepEqual(
    visibleAcceptedGuideNotices(second, "remote-a", "session-a", "turn-a", before).map((n) => n.id),
    [1, 2],
  );
  assert.deepEqual(
    visibleAcceptedGuideNotices(
      second,
      "remote-a",
      "session-a",
      "turn-a",
      snapshot([
        { rowId: 1, text: "first input" },
        { rowId: 2, text: "guide", sourceCommandId: "other-command", guided: true },
      ]),
    ).map((n) => n.id),
    [1, 2],
  );
  assert.deepEqual(
    visibleAcceptedGuideNotices(
      second,
      "remote-a",
      "session-a",
      "turn-a",
      snapshot([
        { rowId: 1, text: "first input" },
        { rowId: 2, text: "guide", sourceCommandId: "command-1" },
      ]),
    ).map((n) => n.id),
    [2],
  );
  assert.deepEqual(
    visibleAcceptedGuideNotices(
      second,
      "remote-a",
      "session-a",
      "turn-a",
      snapshot([
        { rowId: 1, text: "first input" },
        { rowId: 2, text: "guide", sourceCommandId: "command-1" },
        { rowId: 3, text: "guide", sourceCommandId: "command-2" },
      ]),
    ),
    [],
  );
  assert.deepEqual(
    visibleAcceptedGuideNotices(second, "remote-b", "session-a", "turn-a", before),
    [],
  );
  assert.deepEqual(
    visibleAcceptedGuideNotices(second, "remote-a", "session-b", "turn-a", before),
    [],
  );
  assert.deepEqual(
    visibleAcceptedGuideNotices(second, "remote-a", "session-a", "turn-b", before),
    [],
  );
  assert.deepEqual(
    visibleAcceptedGuideNotices(second, "remote-a", "session-a", "turn-a", null),
    [],
  );
  const nextWorkspace = recordAcceptedGuideNotice(second, {
    id: 3,
    workspaceKey: "remote-b",
    sessionId: "session-a",
    turnId: "turn-a",
    text: "new workspace guide",
    sourceCommandId: "command-3",
    snapshot: before,
  });
  assert.deepEqual(
    nextWorkspace.map((notice) => notice.id),
    [3],
  );
});
