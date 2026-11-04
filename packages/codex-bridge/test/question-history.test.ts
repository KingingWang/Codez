import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { zstdCompressSync } from "node:zlib";
import {
  applyNativeQuestionHistory,
  observeNativeQuestion,
  readNativeQuestionHistory,
} from "../src/question-history.js";
import { projectThread } from "../src/projection.js";
import { threadFixture } from "./projection-fixtures.test.js";
import type { JsonObject } from "../src/json.js";

const questions = [
  { id: "target", header: "Target", question: "E2E_CSAQ34 historical target", options: [] },
  { id: "secret", header: "Secret", question: "Private answer", isSecret: true, options: [] },
];
const record = (turnId: string, payload: JsonObject) => ({
  type: "response_item",
  payload: { ...payload, internal_chat_message_metadata_passthrough: { turn_id: turnId } },
});
const call = (turnId: string) =>
  record(turnId, {
    type: "function_call",
    name: "request_user_input",
    id: "fc-reused-item",
    call_id: "reused-item",
    arguments: JSON.stringify({ questions }),
  });
const output = (turnId: string, answers: unknown) =>
  record(turnId, {
    type: "function_call_output",
    call_id: "reused-item",
    output: JSON.stringify({ answers }),
  });
function nativeThread(path: string): JsonObject {
  return {
    ...threadFixture(),
    path,
    turns: ["first", "second"].map((id) => ({
      id,
      status: "completed",
      error: null,
      itemsView: "full",
      items: [
        { type: "userMessage", id: `user-${id}`, content: [{ type: "text", text: id }] },
        { type: "agentMessage", id: `assistant-${id}`, text: "Native continued" },
      ],
    })),
  };
}
async function files(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), "codex-question-history-"));
  const home = join(root, "home");
  await mkdir(join(home, "sessions"), { recursive: true });
  t.after(() => rm(root, { recursive: true, force: true }));
  return { root, home, path: join(home, "sessions", "rollout.jsonl") };
}
const lines = (entries: unknown[]) =>
  entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n";

for (const compressed of [false, true]) {
  test(`CSAQ34: ${compressed ? "compressed" : "plain"} Native history preserves turn identity, real output, order and secret redaction`, async (t) => {
    const f = await files(t);
    const entries = [{ type: "session_meta", payload: { id: "thread-1" } }];
    const data = [
      ...entries,
      call("first"),
      output("first", {}),
      record("first", { type: "message", id: "assistant-first" }),
      call("second"),
      output("second", {
        target: { answers: ["Staging"] },
        secret: { answers: ["synthetic-secret"] },
      }),
      record("second", { type: "message", id: "assistant-second" }),
    ];
    const path = compressed ? f.path + ".zst" : f.path;
    await writeFile(path, compressed ? zstdCompressSync(Buffer.from(lines(data))) : lines(data));
    const thread = nativeThread(path);
    const facts = await readNativeQuestionHistory(thread, f.home);
    assert.equal(facts.length, 2);
    applyNativeQuestionHistory(thread, facts);
    applyNativeQuestionHistory(thread, facts);
    const snapshot = projectThread(thread, { workspacePath: "/workspace" });
    const ask = snapshot.rows.window.filter((row) => row.kind === "toolCall");
    assert.equal(ask.length, 2, "repeat reads must not duplicate a tool");
    assert.equal(ask[0]!.turnId, "first");
    assert.equal(ask[1]!.turnId, "second");
    assert.equal(ask[0]!.toolName, "AskUserQuestion");
    assert.equal(ask[0]!.status, "success");
    assert.deepEqual(JSON.parse(ask[0]!.output!.text), { answers: {} });
    assert.deepEqual(JSON.parse(ask[1]!.output!.text), {
      answers: { target: { answers: ["Staging"] }, secret: { answers: ["••••"] } },
    });
    assert.equal(JSON.stringify(snapshot).includes("synthetic-secret"), false);
    assert.equal(snapshot.rows.window.filter((row) => row.kind === "userInput").length, 2);
    assert.deepEqual(
      snapshot.pendingInteractions,
      [],
      "cold history cannot resurrect reverse-RPC requests",
    );
    for (const turn of ["first", "second"]) {
      const rows = snapshot.rows.window.filter((row) => row.turnId === turn);
      assert.ok(
        rows.findIndex((row) => row.kind === "toolCall") <
          rows.findIndex((row) => row.kind === "assistantText"),
      );
    }
  });
}

test("CSAQ34: history refuses foreign session_meta, external paths and symlink escapes", async (t) => {
  const f = await files(t);
  await writeFile(
    f.path,
    lines([{ type: "session_meta", payload: { id: "foreign" } }, call("first")]),
  );
  await assert.rejects(
    readNativeQuestionHistory(nativeThread(f.path), f.home),
    /different thread identity/,
  );
  const outside = join(f.root, "external.jsonl");
  await writeFile(
    outside,
    lines([{ type: "session_meta", payload: { id: "thread-1" } }, call("first")]),
  );
  assert.deepEqual(await readNativeQuestionHistory(nativeThread(outside), f.home), []);
  const link = join(f.home, "sessions", "link.jsonl");
  await symlink(outside, link);
  assert.deepEqual(await readNativeQuestionHistory(nativeThread(link), f.home), []);
});

test("CSAQ34: oversized unrelated rows, missing turn metadata and partial output do not fabricate answers", async (t) => {
  const f = await files(t);
  await writeFile(
    f.path,
    lines([
      { type: "session_meta", payload: { id: "thread-1" } },
      record("first", { type: "message", content: "x".repeat(1_100_000) }),
      {
        type: "response_item",
        payload: { ...call("first").payload, internal_chat_message_metadata_passthrough: null },
      },
      call("second"),
    ]) + JSON.stringify(output("second", {})),
  );
  const thread = nativeThread(f.path);
  const facts = await readNativeQuestionHistory(thread, f.home);
  assert.equal(facts.length, 1);
  assert.equal(facts[0]!.turnId, "second");
  assert.equal(facts[0]!.item.status, "inProgress");
  applyNativeQuestionHistory(thread, facts);
  const cancelled = projectThread(thread, { workspacePath: "/workspace" }).rows.window.find(
    (row) => row.kind === "toolCall",
  )!;
  assert.equal(cancelled.kind === "toolCall" && cancelled.status, "cancelled");
  observeNativeQuestion(
    thread,
    { turnId: "second", itemId: "reused-item", questions },
    { answers: {} },
  );
  applyNativeQuestionHistory(thread, facts);
  const ask = projectThread(thread, { workspacePath: "/workspace" }).rows.window.find(
    (row) => row.kind === "toolCall",
  )!;
  assert.equal(
    ask.kind === "toolCall" && ask.status,
    "success",
    "a stale cold read cannot regress a live reply",
  );
});

test("CSAQ34: oversized question results and corrupt compressed history fail explicitly", async (t) => {
  const f = await files(t);
  await writeFile(
    f.path,
    lines([
      { type: "session_meta", payload: { id: "thread-1" } },
      call("first"),
      output("first", { target: { answers: ["x".repeat(1_100_000)] } }),
    ]),
  );
  await assert.rejects(
    readNativeQuestionHistory(nativeThread(f.path), f.home),
    /bounded read budget/,
  );
  const compressed = f.path + ".zst";
  await writeFile(compressed, "not a zstd stream");
  await assert.rejects(readNativeQuestionHistory(nativeThread(compressed), f.home));
});

test("CSAQ34: secret prototype-like IDs cannot turn an empty native map into fabricated answers", () => {
  const thread = nativeThread("/unused");
  observeNativeQuestion(
    thread,
    {
      turnId: "first",
      itemId: "special",
      questions: [
        { id: "constructor", isSecret: true, question: "Private", header: "Private", options: [] },
      ],
    },
    { answers: {} },
  );
  const ask = projectThread(thread, { workspacePath: "/workspace" }).rows.window.find(
    (row) => row.kind === "toolCall",
  )!;
  assert.deepEqual(JSON.parse(ask.kind === "toolCall" ? ask.output!.text : ""), { answers: {} });
});
