import assert from "node:assert/strict";
import test from "node:test";
import type { AttachmentRef } from "@codez/shared/codez-protocol-v4";
import { BridgeSnapshots } from "../src/bridge-snapshots.js";
import { InteractionBroker } from "../src/interactions.js";
import { ThreadStateStore } from "../src/thread-state.js";
import type { CodexRpcPort } from "../src/contract.js";
import type { AttachmentStore } from "../src/attachments.js";
import { threadFixture } from "./projection-fixtures.test.js";

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
