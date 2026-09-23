import assert from "node:assert/strict";
import { test } from "node:test";
import { codezSessionStateSnapshotSchema } from "@codez/shared";
import { projectLegacySnapshot } from "../src/projection.js";
import { threadFixture } from "./projection-fixtures.test.js";

test("legacy compatibility view parses the real schema and preserves stable message identities", () => {
  const thread = threadFixture();
  const before = structuredClone(thread);
  const result = projectLegacySnapshot(thread, "/workspace");
  assert.deepEqual(codezSessionStateSnapshotSchema.parse(result), result);
  assert.deepEqual(thread, before);
  assert.deepEqual(
    result.messages.map((message) => message.info.messageId),
    [
      "codex:turn:turn-1:item:user-1",
      "codex:turn:turn-1:item:reason-1",
      "codex:turn:turn-1:item:answer-1",
    ],
  );
  assert.equal(result.messages[0]?.info.role, "user");
  assert.equal(
    result.messages[0]?.info.role === "user" && result.messages[0].info.metadata?.sourceCommandId,
    "command-1",
  );
  assert.equal(result.messages[1]?.parts[0]?.type, "reasoning");
  assert.equal(
    result.messages[2]?.info.role === "assistant" && result.messages[2].info.parentMessageId,
    "codex:turn:turn-1:item:user-1",
  );
  assert.equal(result.session.workspace.workspacePath, "/workspace");
  assert.equal(result.session.status, "completed");
  assert.equal(result.runtime.eventSeq, 0);
});

test("legacy history omits model binding when native model is unknown", () => {
  const thread = threadFixture();
  thread.model = null;
  const snapshot = projectLegacySnapshot(thread, "/workspace");
  assert.equal(snapshot.session.model, undefined);
  assert.equal(snapshot.settings.model.current, undefined);
  assert.equal(
    snapshot.messages.every((message) => message.info.model === undefined),
    true,
  );
});

test("legacy translates tool parts and interrupted/waiting states without claiming success", () => {
  const thread = threadFixture();
  thread.turns[0]!.items.push({
    type: "commandExecution",
    id: "tool",
    command: "pwd",
    cwd: "/workspace",
    status: "inProgress",
  });
  thread.turns[0]!.status = "inProgress";
  thread.status = { type: "active", activeFlags: ["waitingOnApproval"] };
  let snapshot = projectLegacySnapshot(thread, "/workspace");
  assert.equal(snapshot.session.status, "waiting");
  assert.equal(snapshot.runtime.activeTurnId, "turn-1");
  assert.equal(snapshot.projection.activeToolCalls[0]?.status, "running");
  thread.turns[0]!.status = "interrupted";
  thread.status = { type: "idle" };
  snapshot = projectLegacySnapshot(thread, "/workspace");
  assert.equal(snapshot.session.status, "paused");
  const part = snapshot.messages.at(-1)?.parts[0];
  assert.equal(part?.type === "tool" && part.state.status, "error");
});
