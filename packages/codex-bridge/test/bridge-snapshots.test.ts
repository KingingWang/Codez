import assert from "node:assert/strict";
import test from "node:test";
import type { AttachmentRef } from "@codez/shared/codez-protocol-v4";
import { BridgeSnapshots } from "../src/bridge-snapshots.js";
import { InteractionBroker } from "../src/interactions.js";
import { ThreadStateStore } from "../src/thread-state.js";
import type { CodexRpcPort } from "../src/contract.js";
import type { AttachmentStore } from "../src/attachments.js";
import { threadFixture } from "./projection-fixtures.test.js";
import { formatNativeFileReference } from "../src/native-file-reference.js";

const cwd = "/workspace";
function port(): CodexRpcPort {
  return {
    async request() {
      throw new Error("unexpected native RPC");
    },
    async respond() {},
    async respondError() {},
  };
}
const image = (ref: string) => ({
  type: "localImage" as const,
  path: `/native/${ref}.png`,
});

test("native token usage remains sparse and unavailable fields never become zero", async () => {
  const thread = threadFixture();
  thread.tokenUsage = {
    total: { inputTokens: 10, cachedInputTokens: 2 },
    last: { totalTokens: 8 },
    modelContextWindow: 100,
  } as never;
  const rpc = port();
  const store = new ThreadStateStore(rpc, cwd);
  store.markStarted(thread);
  const snapshots = new BridgeSnapshots(
    { rpc, cwd },
    store,
    new InteractionBroker(rpc, () => {}),
    cwd,
  );
  const snapshot = await snapshots.conversation(thread.id);

  assert.deepEqual(snapshot.usage.codexObserved, {
    inputTokens: 10,
    cacheReadTokens: 2,
    contextWindow: { usedTokens: 8, maxTokens: 100 },
  });
  // Dense compatibility fields may exist for old consumers, but downstream sparse readers
  // must use codexObserved; missing output/cache-write are unavailable, not measured zero.
  assert.equal("outputTokens" in snapshot.usage.codexObserved!, false);
  assert.equal("cacheWriteTokens" in snapshot.usage.codexObserved!, false);
});

test("completed native file add advertises real counts and a guarded rewind row action", async () => {
  const thread = threadFixture();
  thread.turns[0]!.items.push({
    type: "fileChange",
    id: "new-file",
    status: "completed",
    changes: [{ path: "/workspace/new.txt", kind: { type: "add" }, diff: "first\nsecond\n" }],
  } as never);
  const rpc = port();
  const store = new ThreadStateStore(rpc, cwd);
  store.markStarted(thread);
  const snapshots = new BridgeSnapshots(
    { rpc, cwd },
    store,
    new InteractionBroker(rpc, () => {}),
    cwd,
  );
  const snapshot = await snapshots.conversation(thread.id);
  const row = snapshot.rows.window.find((entry) => entry.kind === "turnHeader");
  assert.equal(row?.fileChanges?.additions, 2);
  assert.equal(row?.fileChanges?.deletions, 0);
  assert.equal(row?.actions?.canRewindFiles, true);
});

test("attachment restoration follows turn-scoped row identity when native item IDs are reused", async () => {
  const thread = threadFixture();
  const first = {
    ...thread.turns[0]!,
    id: "turn-1",
    status: "completed" as const,
    completedAt: 119,
    items: [{ type: "userMessage" as const, id: "reused-user", content: [image("first")] }],
  };
  const second = {
    ...first,
    id: "turn-2",
    startedAt: 121,
    completedAt: 122,
    items: [{ type: "userMessage" as const, id: "reused-user", content: [image("second")] }],
  };
  thread.turns = [first, second];
  const rpc = port();
  const store = new ThreadStateStore(rpc, cwd);
  store.markStarted(thread);
  const restored: AttachmentRef[] = [];
  const attachments = {
    async findNativeAttachment(path: string, sessionId: string) {
      assert.equal(sessionId, thread.id);
      const ref = path.endsWith("/first.png") ? "first-ref" : "second-ref";
      const value = { ref, fileName: `${ref}.png`, mime: "image/png", bytes: 1 };
      restored.push(value);
      return value;
    },
  } as unknown as AttachmentStore;
  const snapshots = new BridgeSnapshots(
    { rpc, cwd },
    store,
    new InteractionBroker(rpc, () => {}),
    cwd,
    attachments,
  );
  const snapshot = await snapshots.conversation(thread.id);
  const users = snapshot.rows.window.filter((row) => row.kind === "userInput");
  assert.deepEqual(
    users.map((row) => row.entityId),
    ["codex:turn:turn-1:item:reused-user", "codex:turn:turn-2:item:reused-user"],
  );
  assert.deepEqual(
    users.map((row) => row.attachments?.map((attachment) => attachment.ref)),
    [["first-ref"], ["second-ref"]],
  );
  assert.deepEqual(
    restored.map((attachment) => attachment.ref),
    ["first-ref", "second-ref"],
  );
  assert.equal(
    snapshots.authorizeAttachment({
      sessionId: thread.id,
      method: "v4/conversation/attachment/read",
      ref: "second-ref",
      target: { rowId: users[1]!.rowId, entityId: users[1]!.entityId! },
      attachmentIndex: 0,
    }),
    true,
  );
});

test("binary refs remain chips in native history and queue without exposing private markers", async () => {
  const thread = threadFixture();
  const ref: AttachmentRef = {
    ref: "codez-attachment://00000000-0000-4000-8000-000000000001",
    fileName: "archive.zip",
    mime: "application/zip",
    bytes: 4,
  };
  const path = "/private/objects/00000000-0000-4000-8000-000000000001.data";
  const marker = formatNativeFileReference({ attachment: ref, path });
  thread.turns[0]!.items[0] = {
    type: "userMessage",
    id: "user-1",
    content: [{ type: "text", text: `Inspect this\n${marker}`, text_elements: [] }],
  };
  const rpc = port();
  const store = new ThreadStateStore(rpc, cwd);
  const state = store.markStarted(thread);
  state.queue = [
    {
      id: "queue-1",
      clientUserMessageId: "command-1",
      input: [{ type: "text", text: marker, text_elements: [] }],
    },
  ];
  const attachments = {
    async findNativeAttachment(candidate: string, sessionId: string) {
      assert.equal(candidate, path);
      assert.equal(sessionId, thread.id);
      return ref;
    },
  } as unknown as AttachmentStore;
  const snapshots = new BridgeSnapshots(
    { rpc, cwd },
    store,
    new InteractionBroker(rpc, () => {}),
    cwd,
    attachments,
  );
  const snapshot = await snapshots.conversation(thread.id);
  const user = snapshot.rows.window.find((row) => row.kind === "userInput");
  assert.equal(user?.text, "Inspect this");
  assert.deepEqual(user?.attachments, [ref]);
  assert.deepEqual(snapshot.queue.items[0]?.attachments, [ref]);
  assert.equal(snapshot.queue.items[0]?.text, "");
});
