import assert from "node:assert/strict";
import type { TestContext } from "node:test";
import {
  conversationSnapshotSchema,
  type ConversationSnapshot,
} from "@zcode/shared/zcode-protocol-v4";
import { codexUserInputSchema, type CodexTurn } from "../../src/codex-types.js";
import { projectThread } from "../../src/projection.js";
import { setup, cwd, sessionId, textInput, turn, attachment } from "./commands-fixture.js";

type HistoryCommand = "editUserQuery" | "retryTurn";
type Harness = Awaited<ReturnType<typeof setup>>;

function snapshot(h: Harness): ConversationSnapshot {
  const state = h.store.get(sessionId)!;
  return conversationSnapshotSchema.parse(
    projectThread(state.thread, {
      workspacePath: cwd,
      logEpoch: state.epoch,
      seq: state.seq,
      revision: state.revision,
      queue: state.queue,
    }),
  );
}

/** Three real turns, not three rows. The target is historical, with a surviving prefix
 * and a later turn that must disappear. Retry must use the target turn's native input,
 * including media, rather than the first thread input or the displayed textual fallback.
 */
function historicalTurns(h: Harness) {
  const first = h.authority.thread.turns[0]!;
  first.items.push({
    type: "fileChange",
    id: "earlier-patch",
    status: "completed",
    changes: [{ path: "retained.ts", kind: { type: "add" }, diff: "+retained file bytes" }],
  });
  const originalInput = codexUserInputSchema.array().parse([
    { type: "text", text: "Original second input\n  preserve whitespace", text_elements: [] },
    { type: "localImage", path: "/fixture/history-image.png" },
    { type: "mention", name: "context", path: "/fixture/context.md" },
  ]);
  const middle: CodexTurn = {
    ...turn("middle-turn"),
    status: "completed",
    completedAt: 125,
    items: [
      {
        type: "userMessage",
        id: "middle-user",
        clientId: "historical-command",
        content: originalInput,
      },
      { type: "reasoning", id: "middle-reasoning", summary: ["Earlier reasoning"], content: [] },
      { type: "agentMessage", id: "middle-answer", text: "Earlier answer" },
    ],
  };
  const later: CodexTurn = {
    ...turn("later-turn"),
    status: "completed",
    completedAt: 130,
    items: [
      { type: "userMessage", id: "later-user", content: [{ type: "text", text: "Later input" }] },
      { type: "agentMessage", id: "later-answer", text: "Later answer" },
    ],
  };
  h.authority.thread.turns = [first, middle, later];
  h.store.markStarted(structuredClone(h.authority.thread));
  return originalInput;
}

/** Tests the product boundary without modifying production handlers:
 * target(rowId,entityId) → native beforeTurnId → reload prefix → new epoch → turn/start.
 * Only history/read/queue-read/start RPCs are allowed; no file/terminal/rewind mutation.
 */
export async function verifyHistoryChange(t: TestContext, type: HistoryCommand) {
  const h = await setup(t);
  const originalInput = historicalTurns(h);
  const before = snapshot(h);
  const entityId = type === "editUserQuery" ? "middle-user" : "middle-answer";
  const targetRow = before.rows.window.find((row) => row.entityId === entityId)!;
  assert.ok(targetRow);
  assert.equal(targetRow.turnId, "middle-turn");
  assert.equal(targetRow.kind, type === "editUserQuery" ? "userInput" : "assistantText");
  assert.ok(targetRow.rowId > 4, "row ordinal is not a turn index");
  const target = { rowId: targetRow.rowId, entityId };
  const retainedRows = before.rows.window.filter((row) => row.turnId === "turn-1");
  const editedInput = [
    ...textInput("Replacement input"),
    { type: "localImage", path: "/fixture/staged-image.png" },
  ];
  h.context.attachments = async (refs, id) => {
    assert.deepEqual(refs, [attachment]);
    assert.equal(id, sessionId);
    assert.deepEqual(h.rpc.calls, [], "staging must finish before reverting existing history");
    return [editedInput[1]];
  };
  const payload =
    type === "editUserQuery"
      ? {
          target,
          newText: "Replacement input",
          workspaceMode: "preserve",
          attachments: [attachment],
        }
      : { target };
  const command = h.command(type, payload, `history-${type}`);
  h.rpc.handlers.set("thread/revert", (params) => {
    assert.deepEqual(params, { threadId: sessionId, beforeTurnId: "middle-turn" });
    const index = h.authority.thread.turns.findIndex((value) => value.id === params.beforeTurnId);
    assert.equal(index, 1);
    h.authority.thread.turns = h.authority.thread.turns.slice(0, index);
    // Actual native revert response is metadata-only; retained turns require pagination.
    return {
      thread: { ...h.authority.thread, turns: [] },
      turnsBackwardsCursor: "prefix-cursor",
      itemsBackwardsCursor: null,
    };
  });
  for (const method of ["thread/read", "thread/resume"]) {
    h.rpc.handlers.set(method, () => ({ thread: { ...h.authority.thread, turns: [] } }));
  }
  let beforeRestart: ConversationSnapshot | undefined;
  h.rpc.handlers.set("turn/start", (params) => {
    beforeRestart = snapshot(h);
    const started: CodexTurn = {
      ...turn("rerun-turn"),
      items: [
        {
          type: "userMessage",
          id: "rerun-user",
          clientId: String(params.clientUserMessageId),
          content: codexUserInputSchema.array().parse(params.input),
        },
      ],
    };
    h.authority.thread.turns.push(started);
    return { turn: started };
  });

  const ack = await h.execute(command);
  assert.equal(ack.status, "accepted", ack.message);
  assert.deepEqual(
    h.rpc.methods(),
    [
      "thread/revert",
      "thread/read",
      "thread/resume",
      "thread/turns/list",
      "thread/queue/list",
      "turn/start",
    ],
    "no file mutation RPC and no start before the authoritative history reload",
  );
  assert.deepEqual(h.rpc.params("turn/start"), [
    {
      threadId: sessionId,
      input: type === "editUserQuery" ? editedInput : originalInput,
      clientUserMessageId: command.commandId,
    },
  ]);
  assert.ok(beforeRestart);
  assert.notEqual(
    beforeRestart.logEpoch,
    before.logEpoch,
    "rotate the epoch before starting a replacement turn",
  );
  assert.deepEqual(
    beforeRestart.rows.window,
    retainedRows,
    "retain the prefix, not cached reverted turns",
  );
  const after = snapshot(h);
  assert.equal(after.logEpoch, beforeRestart.logEpoch);
  assert.deepEqual(
    after.rows.window.filter((row) => row.turnId === "turn-1"),
    retainedRows,
  );
  assert.equal(
    after.rows.window.some((row) => row.turnId === "middle-turn" || row.turnId === "later-turn"),
    false,
  );
  const newUser = after.rows.window.find((row) => row.entityId === "rerun-user");
  assert.equal(newUser?.kind === "userInput" && newUser.sourceCommandId, command.commandId);
  assert.equal(after.control.phase, "running");

  // Same command replays its result despite an old epoch; a NEW stale command must not revert again.
  const calls = structuredClone(h.rpc.calls);
  assert.deepEqual(await h.execute(command), ack);
  const stale = await h.execute({
    ...h.command(type, payload, `late-${type}`),
    baseLogEpoch: before.logEpoch,
  });
  assert.equal(stale.status, "stale");
  assert.deepEqual(h.rpc.calls, calls, "neither duplicate nor stale commands mutate history twice");
}
