import assert from "node:assert/strict";
import { test } from "node:test";
import { conversationSnapshotSchema } from "@zcode/shared/zcode-protocol-v4";
import { codexThreadSchema, codexUserInputSchema } from "../src/codex-types.js";
import { projectCodexQueue, projectThread } from "../src/projection.js";
import { threadFixture } from "./projection-fixtures.test.js";

test("fixture validates the consumed local Codex protocol", () => {
  assert.equal(codexThreadSchema.parse(threadFixture()).turns[0]?.items.length, 3);
});

test("native turn/start provisional localImage accepts null detail before data-URL conversion", () => {
  const image = { type: "localImage", detail: null, path: "/owned/image.data" };
  assert.deepEqual(codexUserInputSchema.parse(image), image);
  const thread = threadFixture();
  thread.turns[0]!.items = [{ type: "userMessage", id: "first-image", content: [image] }];
  assert.equal(
    projectThread(thread, { workspacePath: "/workspace" }).rows.window[1]?.kind,
    "userInput",
  );
  assert.equal(codexUserInputSchema.safeParse({ ...image, detail: 1 }).success, false);
});

// Native smoke evidence: persisted local-image input becomes image + data URL + detail:null.
// This only validates/presents native facts; attachment restoration stays with the bridge owner.
test("native image history and queue accept nullable detail without losing user identity", () => {
  const image = { type: "image", detail: null, url: "data:image/png;base64,aGVsbG8=" };
  assert.deepEqual(codexUserInputSchema.parse(image), image);
  const thread = threadFixture();
  const user = {
    type: "userMessage",
    id: "user-image",
    clientId: "image-command",
    content: [image],
  };
  const native = { ...thread, turns: [{ ...thread.turns[0], items: [user] }] };
  const snapshot = projectThread(native, { workspacePath: "/workspace" });
  assert.deepEqual(conversationSnapshotSchema.parse(snapshot), snapshot);
  const row = snapshot.rows.window[1];
  assert.equal(row?.kind, "userInput");
  if (row?.kind !== "userInput") assert.fail("native image must remain a userInput row");
  assert.equal(row.entityId, `codex:turn:turn-1:item:${user.id}`);
  assert.equal(row.sourceCommandId, user.clientId);
  assert.equal(row.text, "[image]");
  assert.equal(row.attachments, undefined, "schema must not invent restored attachment refs");
  assert.deepEqual(native.turns[0]!.items[0], user);
  const queue = {
    data: [{ id: "queued-image", input: [image], clientUserMessageId: "image-command" }],
    nextCursor: null,
  };
  assert.deepEqual(projectCodexQueue(queue), queue);
});

test("image detail remains optional or string, and malformed known user messages still fail", () => {
  for (const detail of [undefined, "auto", "high", "low"]) {
    const image = {
      type: "image",
      url: "data:image/png;base64,aGVsbG8=",
      ...(detail === undefined ? {} : { detail }),
    };
    assert.deepEqual(codexUserInputSchema.parse(image), image);
  }
  for (const content of [
    [{ type: "image", url: "data:image/png;base64,aGVsbG8=", detail: 42 }],
    [{ type: "image", detail: null }],
    [{ type: "image", url: 42, detail: null }],
  ]) {
    const thread = threadFixture();
    const native = {
      ...thread,
      turns: [{ ...thread.turns[0], items: [{ type: "userMessage", id: "bad-image", content }] }],
    };
    assert.throws(() => projectThread(native, { workspacePath: "/workspace" }));
  }
});

test("target golden fixture parses the actual V4 schema, not invented defaults", () => {
  const unavailable = { allowed: false, reasonCode: "guard.codex.capabilityUnknown" };
  const parsed = conversationSnapshotSchema.parse({
    protocolVersion: 1,
    sessionId: "thread-1",
    logEpoch: "attachment-1",
    seq: 0,
    revision: 0,
    control: {
      phase: "completedSuccess",
      sessionEnded: true,
      canStop: false,
      stopState: "idle",
      stopTargetKind: "unknown",
      activeWorks: [],
      lastError: null,
      apiRetry: null,
    },
    availability: {
      fork: unavailable,
      compact: unavailable,
      switchModelConfig: unavailable,
      setFollowupMode: unavailable,
      queueEdit: unavailable,
      sendQueuedNow: unavailable,
      pauseGoal: unavailable,
      resumeGoal: unavailable,
    },
    inputRouting: { mode: "startNow" },
    meta: { title: "Hello", titleSource: "default" },
    config: {
      provider: "openai",
      model: "fixture-model",
      thought: "medium",
      thoughtLevels: [],
      followupMode: "guide",
      mode: "",
    },
    usage: {
      contextWindow: null,
      cumulative: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
    },
    queue: { items: [], autoDrain: false },
    pendingInteractions: [],
    pendingCommands: [],
    backgroundWorks: [],
    goal: null,
    plan: null,
    rows: { window: [], totalCount: 0, firstRowId: null },
  });
  assert.equal(parsed.protocolVersion, 1);
  assert.equal(parsed.modelTransition, null);
});
