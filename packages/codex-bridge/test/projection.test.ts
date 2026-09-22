import assert from "node:assert/strict";
import { test } from "node:test";
import {
  conversationRowSchema,
  conversationSnapshotSchema,
  sessionSummarySchema,
  sessionsIndexSnapshotSchema,
} from "@zcode/shared/zcode-protocol-v4";
import { projectThread, projectSessionSummary, projectSessionsIndex } from "../src/projection.js";
import { threadFixture } from "./projection-fixtures.test.js";

const options = { workspacePath: "/workspace", logEpoch: "connection-1", seq: 12, revision: 4 };

test("conversation is schema-valid, deterministic, pure and preserves caller watermarks", () => {
  const thread = threadFixture();
  const before = structuredClone(thread);
  const result = projectThread(thread, options);
  assert.deepEqual(conversationSnapshotSchema.parse(result), result);
  assert.deepEqual(projectThread(thread, options), result);
  assert.deepEqual(thread, before);
  assert.deepEqual([result.seq, result.revision, result.logEpoch], [12, 4, "connection-1"]);
  assert.deepEqual(
    result.rows.window.map((row) => row.rowId),
    [0, 1, 2, 3],
  );
  for (const row of result.rows.window) assert.deepEqual(conversationRowSchema.parse(row), row);
  assert.equal(result.rows.firstRowId, 0);
  assert.equal(result.rows.totalCount, 4);
  const user = result.rows.window[1];
  assert.equal(user?.entityId, "codex:turn:turn-1:item:user-1");
  assert.equal(user?.kind === "userInput" && user.sourceCommandId, "command-1");
  assert.equal(user?.kind === "userInput" && user.clientId, undefined);
  assert.equal(result.rows.window[0]?.createdAt, 101000);
  assert.equal(
    result.rows.window[0]?.kind === "turnHeader" && result.rows.window[0].activeMs,
    undefined,
  );
  assert.equal(
    result.rows.window[3]?.kind === "assistantText" && result.rows.window[3].model,
    undefined,
  );
  assert.equal(result.control.phase, "completedSuccess");
});

test("appending content/items preserves existing identities and ordinals", () => {
  const thread = threadFixture();
  const initial = projectThread(thread, options);
  thread.turns[0]!.items.push({ type: "agentMessage", id: "answer-2", text: "More" });
  const next = projectThread(thread, { ...options, seq: 13 });
  assert.deepEqual(next.rows.window.slice(0, 4), initial.rows.window);
  assert.equal(next.rows.window[4]?.rowId, 4);
});

test("statuses are mapped from authority, including unloaded active and system errors", () => {
  for (const [status, phase, state] of [
    ["inProgress", "running", "running"],
    ["completed", "completedSuccess", "completedSuccess"],
    ["interrupted", "completedInterrupted", "completedInterrupted"],
    ["failed", "error", "failed"],
  ] as const) {
    const thread = threadFixture();
    thread.turns[0]!.status = status;
    thread.status =
      status === "inProgress" ? { type: "active", activeFlags: [] } : { type: "idle" };
    if (status === "failed") thread.turns[0]!.error = { message: "Provider unavailable" };
    const snapshot = projectThread(thread, options);
    assert.equal(snapshot.control.phase, phase);
    assert.equal(
      snapshot.rows.window[0]?.kind === "turnHeader" && snapshot.rows.window[0].state,
      state,
    );
    assert.equal(snapshot.control.canStop, status === "inProgress");
  }
  const thread = threadFixture();
  thread.turns = [];
  thread.status = { type: "active", activeFlags: ["waitingOnApproval"] };
  assert.equal(projectSessionSummary(thread, "/workspace").phase, "running");
  assert.equal(projectThread(thread, options).control.canStop, false);
  thread.status = { type: "systemError" };
  assert.equal(projectThread(thread, options).control.phase, "error");
});

test("summary/index use milliseconds, bounded previews and independent workspace epoch", () => {
  const thread = threadFixture();
  thread.name = "Named";
  thread.forkedFromId = "parent";
  thread.turns[0]!.items.push({ type: "agentMessage", id: "long", text: "a".repeat(140) });
  const summary = projectSessionSummary(thread, "/workspace");
  assert.deepEqual(sessionSummarySchema.parse(summary), summary);
  assert.equal(summary.createdAt, 100000);
  assert.equal(summary.lastActivityAt, 120000);
  assert.equal(summary.lastAssistantPreview?.length, 120);
  assert.equal(summary.parentSessionId, "parent");
  assert.equal(summary.titleSource, undefined); // Codex name does not record title provenance.
  const index = projectSessionsIndex([thread], {
    workspacePath: "/workspace",
    workspaceIdentity: " remote-identity ",
    logEpoch: "host-index-epoch",
  });
  assert.deepEqual(sessionsIndexSnapshotSchema.parse(index), index);
  assert.equal(index.workspaceId, "remote-identity");
  assert.equal(index.sessions[0]?.workspaceId, "remote-identity");
  assert.equal(index.logEpoch, "host-index-epoch");
});

test("malformed/partial histories and duplicate IDs fail before projecting misleading rows", () => {
  const thread = threadFixture();
  thread.turns[0]!.itemsView = "summary";
  assert.throws(() => projectThread(thread, options), /full/i);
  assert.doesNotThrow(() => projectSessionSummary(thread, "/workspace"));
  thread.turns[0]!.itemsView = "full";
  thread.turns[0]!.items.push(thread.turns[0]!.items[0]!);
  assert.throws(() => projectThread(thread, options), /duplicate/i);
  assert.throws(() => projectThread({ ...thread, createdAt: -1 }, options));
  assert.throws(
    () => projectThread(threadFixture(), { workspacePath: "/workspace", seq: 1 }),
    /epoch/i,
  );
});

test("follow-up turns may reuse native item IDs without colliding presentation identities", () => {
  const thread = threadFixture();
  const first = thread.turns[0]!;
  const second = {
    ...first,
    id: "turn-2",
    startedAt: 121,
    completedAt: 122,
    items: [
      {
        type: "userMessage" as const,
        id: "user-1",
        clientId: "command-2",
        content: [{ type: "text" as const, text: "Follow-up", text_elements: [] }],
      },
      { type: "agentMessage" as const, id: "answer-1", text: "Follow-up response" },
    ],
  };
  thread.turns.push(second);
  const snapshot = projectThread(thread, options);
  const identities = snapshot.rows.window.map((row) => row.entityId);
  assert.deepEqual(identities, [
    "codex:turn:turn-1",
    "codex:turn:turn-1:item:user-1",
    "codex:turn:turn-1:item:reason-1",
    "codex:turn:turn-1:item:answer-1",
    "codex:turn:turn-2",
    "codex:turn:turn-2:item:user-1",
    "codex:turn:turn-2:item:answer-1",
  ]);
  assert.equal(new Set(identities).size, identities.length);
  assert.equal(snapshot.rows.window[1]?.turnId, "turn-1");
  assert.equal(snapshot.rows.window[5]?.turnId, "turn-2");
});

test("turn header entity IDs encode delimiter-shaped native turn IDs", () => {
  const thread = threadFixture();
  thread.turns = [
    {
      ...thread.turns[0]!,
      id: "t:item:i",
      items: [
        {
          type: "userMessage" as const,
          id: "header-user",
          content: [{ type: "text" as const, text: "Special turn", text_elements: [] }],
        },
      ],
    },
    {
      ...thread.turns[0]!,
      id: "t",
      items: [
        { type: "agentMessage" as const, id: "i", text: "Collides with an unencoded header" },
      ],
    },
  ];
  const identities = projectThread(thread, options).rows.window.map((row) => row.entityId);
  assert.deepEqual(identities, [
    "codex:turn:t%3Aitem%3Ai",
    "codex:turn:t%3Aitem%3Ai:item:header-user",
    "codex:turn:t",
    "codex:turn:t:item:i",
  ]);
  assert.equal(new Set(identities).size, identities.length);
});

test("duplicate thread records validate first and index only the newest first-encounter entry", () => {
  const older = threadFixture();
  const newer = {
    ...threadFixture(),
    preview: "Newer rollout",
    updatedAt: 130,
    turns: [],
  };
  const other = { ...threadFixture(), id: "thread-2", updatedAt: 125 };
  const index = projectSessionsIndex([older, other, newer], {
    workspacePath: "/workspace",
    logEpoch: "host-index-epoch",
  });
  assert.deepEqual(
    index.sessions.map((session) => [session.sessionId, session.title, session.lastActivityAt]),
    [
      ["thread-1", "Newer rollout", 130000],
      ["thread-2", "Hello", 125000],
    ],
  );

  const stale = { ...newer, updatedAt: 90 };
  const tieFirst = projectSessionsIndex(
    [newer, stale, { ...newer, updatedAt: 130, preview: "Late tie" }],
    { workspacePath: "/workspace", logEpoch: "host-index-epoch" },
  );
  assert.equal(tieFirst.sessions.length, 1);
  assert.equal(tieFirst.sessions[0]?.title, "Newer rollout");

  const invalid = { ...older, updatedAt: "recent" };
  assert.throws(
    () =>
      projectSessionsIndex([newer, invalid], {
        workspacePath: "/workspace",
        logEpoch: "host-index-epoch",
      }),
    /updatedAt/,
  );
});

test("cold history has no fake model, capabilities, plan completion or authoritative work time", () => {
  const thread = threadFixture();
  thread.model = null;
  thread.turns[0]!.items.push({ type: "plan", id: "plan-1", text: "## Proposed plan\n- Build" });
  const snapshot = projectThread(thread, { workspacePath: "/workspace" });
  assert.equal(snapshot.config.model, "");
  assert.equal(snapshot.config.modelSelection, undefined);
  assert.equal(snapshot.plan, null);
  assert.equal(snapshot.availability.setFollowupMode.allowed, false);
  assert.equal(snapshot.rows.window.at(-1)?.kind, "assistantText");
  assert.equal(
    snapshot.rows.window.every((row) => row.createdAtSeq === 0),
    true,
  );
});
