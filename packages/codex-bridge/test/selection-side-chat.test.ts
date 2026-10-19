import assert from "node:assert/strict";
import test from "node:test";
import { projectSessionsIndex, projectThread } from "../src/projection.js";
import {
  SELECTION_SIDE_CHAT_BOUNDARY,
  SELECTION_SIDE_CHAT_THREAD_SOURCE,
} from "../src/selection-side-chat.js";
import type { CodexThread } from "../src/codex-types.js";
import {
  setup,
  cwd,
  workspaceId,
  sessionId,
  selection,
  textInput,
} from "./fixtures/commands-fixture.js";
import { threadFixture } from "./projection-fixtures.test.js";

function childFixture(): CodexThread {
  return {
    ...threadFixture(),
    id: "child-1",
    forkedFromId: sessionId,
    threadSource: SELECTION_SIDE_CHAT_THREAD_SOURCE,
    turns: structuredClone(threadFixture().turns),
  };
}

/** 按 threadId 分发的 read/resume/turns 处理器：parent 与 child 各自独立。 */
function scopeHandlers(h: Awaited<ReturnType<typeof setup>>, child: CodexThread) {
  const parent = h.authority.thread;
  h.rpc.handlers.set("thread/read", (p) => ({
    thread: p.threadId === child.id ? child : parent,
  }));
  h.rpc.handlers.set("thread/resume", (p) => ({
    thread: p.threadId === child.id ? child : parent,
  }));
  h.rpc.handlers.set("thread/turns/list", (p) => ({
    data: p.threadId === child.id ? child.turns : parent.turns,
    nextCursor: null,
  }));
  h.rpc.handlers.set("thread/queue/list", () => ({ data: [], nextCursor: null }));
}

test("createSelectionSideSession forks with persistent marker and hides inherited history", async (t) => {
  const h = await setup(t);
  const child = childFixture();
  scopeHandlers(h, child);
  h.rpc.handlers.set("thread/fork", () => ({ thread: child }));

  const ack = await h.execute(h.command("createSelectionSideSession", {}, "cmd-side-1"));
  assert.equal(ack.status, "accepted");
  assert.deepEqual(ack.result, { type: "createSelectionSideSession", sessionId: child.id });
  assert.deepEqual(h.rpc.params("thread/fork"), [
    { threadId: sessionId, threadSource: SELECTION_SIDE_CHAT_THREAD_SOURCE },
  ]);

  // 冷加载建立继承裁剪边界：fork 保留源 turn id，与父求交。
  const state = h.store.get(child.id);
  assert.equal(state?.sideChat?.parentThreadId, sessionId);
  assert.deepEqual([...(state?.sideChat?.inheritedTurnIds ?? [])], ["turn-1"]);

  // 投影跳过继承历史：child 自有内容为空时 snapshot 无行。
  const snapshot = projectThread(h.store.get(child.id)!.thread as unknown as CodexThread, {
    workspacePath: cwd,
    hiddenTurnIds: state!.sideChat!.inheritedTurnIds,
  });
  assert.equal(snapshot.rows.window.length, 0);
  assert.equal(snapshot.rows.firstRowId, null);

  // 任务列表隐藏 child（sessions-index 与原生 threadSource 判定）。
  const index = projectSessionsIndex([h.authority.thread, child], {
    workspacePath: cwd,
    workspaceId,
    logEpoch: "epoch-1",
  });
  assert.deepEqual(
    index.sessions.map((session) => session.sessionId),
    [sessionId],
  );
});

test("createSelectionSideSession with firstInput starts child turn with boundary instruction", async (t) => {
  const h = await setup(t);
  const child = childFixture();
  scopeHandlers(h, child);
  h.rpc.handlers.set("thread/fork", () => ({ thread: child }));
  const started: unknown[] = [];
  h.rpc.handlers.set("turn/start", (p) => {
    started.push(p);
    const turn = {
      id: "child-turn-1",
      itemsView: "full",
      status: "completed",
      items: [],
      startedAt: 200,
      completedAt: 201,
      error: null,
    };
    child.turns = [...child.turns, turn as CodexThread["turns"][number]];
    return { turn };
  });

  const ack = await h.execute(
    h.command(
      "createSelectionSideSession",
      { firstInput: { text: "解释这段代码", modelSelection: selection } },
      "cmd-side-2",
    ),
  );
  assert.equal(ack.status, "accepted");
  assert.equal(ack.result?.type, "createSelectionSideSession");
  assert.equal(ack.result?.sessionId, child.id);
  assert.equal(ack.result?.input?.delivery, "startNow");

  // firstInput 只落 child：turn/start 目标是 child，且文本以边界指令开头。
  assert.equal(started.length, 1);
  const params = started[0] as { threadId: string; input: { text: string }[]; model?: string };
  assert.equal(params.threadId, child.id);
  assert.ok(params.input[0]!.text.startsWith(`${SELECTION_SIDE_CHAT_BOUNDARY}\n\n`));
  assert.ok(params.input[0]!.text.endsWith("解释这段代码"));
  // modelSelection 经 selectionOverrides 下发到首个 turn。
  assert.equal(params.model, selection.modelId);

  // firstInput 已是首条自有输入：后续 sendText 不再重复拼接边界指令。
  const send = await h.execute(h.command("sendText", { text: "第二句" }, "cmd-side-3", child.id));
  assert.equal(send.status, "accepted");
  const second = (started[1] as { input: { text: string }[] }).input[0]!.text;
  assert.equal(second, "第二句");
});

test("sendText prepends boundary on first own input of an existing side chat", async (t) => {
  const h = await setup(t);
  const child = childFixture();
  scopeHandlers(h, child);
  h.rpc.handlers.set("thread/fork", () => ({ thread: child }));
  // 空副屏入口（无 firstInput）：首条输入来自之后的 sendText。
  const ack = await h.execute(h.command("createSelectionSideSession", {}, "cmd-side-4"));
  assert.equal(ack.status, "accepted");

  h.rpc.handlers.set("turn/start", () => {
    const turn = {
      id: `own-${child.turns.length}`,
      itemsView: "full",
      status: "completed",
      items: [],
      startedAt: 300,
      completedAt: 301,
      error: null,
    };
    child.turns = [...child.turns, turn as CodexThread["turns"][number]];
    return { turn };
  });
  const first = await h.execute(h.command("sendText", { text: "第一句" }, "cmd-side-5", child.id));
  assert.equal(first.status, "accepted");
  const firstText = (h.rpc.params("turn/start")[0] as { input: { text: string }[] }).input[0]!.text;
  assert.ok(firstText.startsWith(`${SELECTION_SIDE_CHAT_BOUNDARY}\n\n第一句`));

  const second = await h.execute(h.command("sendText", { text: "第二句" }, "cmd-side-6", child.id));
  assert.equal(second.status, "accepted");
  const secondText = (h.rpc.params("turn/start")[1] as { input: { text: string }[] }).input[0]!
    .text;
  assert.equal(secondText, "第二句");
});

test("createSelectionSideSession is allowed on a writer-conflict read-only parent", async (t) => {
  const h = await setup(t);
  const child = childFixture();
  scopeHandlers(h, child);
  h.rpc.handlers.set("thread/fork", () => ({ thread: child }));
  // writer-conflict 只读：fork 不取源写锁，与 forkAssistant 同一逃生通道。
  h.store.get(sessionId)!.readOnly = "writer-conflict";
  const ack = await h.execute(h.command("createSelectionSideSession", {}, "cmd-side-7"));
  assert.equal(ack.status, "accepted");
  assert.ok(ack.result?.type === "createSelectionSideSession");
  assert.equal(ack.result.sessionId, child.id);
});

test("parent turns/list failure fails open without trimming", async (t) => {
  const h = await setup(t);
  const child = childFixture();
  scopeHandlers(h, child);
  h.rpc.handlers.set("thread/fork", () => ({ thread: child }));
  h.rpc.handlers.set("thread/turns/list", (p) => {
    if (p.threadId === child.id) return { data: child.turns, nextCursor: null };
    throw new Error("parent gone");
  });
  const ack = await h.execute(h.command("createSelectionSideSession", {}, "cmd-side-8"));
  assert.equal(ack.status, "accepted");
  const state = h.store.get(child.id);
  assert.equal(state?.sideChat, undefined);
});

test("legacy fixture text input shape stays intact", () => {
  assert.deepEqual(textInput("x"), [{ type: "text", text: "x", text_elements: [] }]);
});
