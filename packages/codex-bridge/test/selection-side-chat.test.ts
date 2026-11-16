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
import { MAX_FRAME_BYTES } from "../src/rpc-framing.js";
import { CodexTransportError } from "../src/rpc-errors.js";

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
  h.rpc.handlers.set("thread/queue/list", () => ({
    data: [],
    nextCursor: null,
  }));
}

test("createSelectionSideSession forks with persistent marker and hides inherited history", async (t) => {
  const h = await setup(t);
  const child = childFixture();
  scopeHandlers(h, child);
  h.rpc.handlers.set("thread/fork", () => ({ thread: child }));

  const ack = await h.execute(h.command("createSelectionSideSession", {}, "cmd-side-1"));
  assert.equal(ack.status, "accepted");
  assert.deepEqual(ack.result, {
    type: "createSelectionSideSession",
    sessionId: child.id,
  });
  assert.deepEqual(h.rpc.params("thread/fork"), [
    {
      threadId: sessionId,
      threadSource: SELECTION_SIDE_CHAT_THREAD_SOURCE,
      excludeTurns: true,
    },
  ]);

  // child 分页历史与父缓存求交：fork 保留源 turn id。
  const state = h.store.get(child.id);
  assert.equal(state?.sideChat?.parentThreadId, sessionId);
  assert.deepEqual([...(state?.sideChat?.inheritedTurnIds ?? [])], ["turn-1"]);
  assert.deepEqual(
    h.rpc.calls.map((call) => call.method),
    ["thread/fork", "thread/turns/list"],
    "hot creation must page child history and reuse parent turns without read/resume/queue RPCs",
  );

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

test("large side chat history is paginated without retrying the fork or losing inherited turns", async (t) => {
  const h = await setup(t);
  const child = childFixture();
  const template = child.turns[0]!;
  const text = "x".repeat(2 * 1024 * 1024);
  child.turns = Array.from({ length: 18 }, (_, index) => ({
    ...template,
    id: `inherited-${index}`,
    items: [
      {
        type: "agentMessage" as const,
        id: `message-${index}`,
        text,
        phase: "final_answer" as const,
      },
    ],
  }));
  h.store.get(sessionId)!.thread.turns = child.turns;
  scopeHandlers(h, child);
  let forks = 0;
  h.rpc.handlers.set("thread/fork", (p) => {
    forks += 1;
    // 原生已经创建 child 后才序列化响应；超限不能靠重发 fork 补救。
    if (p.excludeTurns !== true)
      throw new CodexTransportError("LIMIT", "Codex response frame exceeds size limit");
    return { thread: { ...child, turns: [] } };
  });
  h.rpc.handlers.set("thread/turns/list", (p) => {
    assert.equal(p.threadId, child.id, "the hot path must not reread parent history");
    assert.equal(p.itemsView, "full");
    const offset = p.cursor ? Number(p.cursor) : 0;
    const data = child.turns.slice(offset, offset + Number(p.limit));
    if (Buffer.byteLength(JSON.stringify({ data })) > MAX_FRAME_BYTES)
      throw new CodexTransportError("LIMIT", "Codex response frame exceeds size limit");
    const next = offset + data.length;
    return {
      data,
      nextCursor: next < child.turns.length ? String(next) : null,
    };
  });

  const ack = await h.execute(h.command("createSelectionSideSession", {}, "cmd-side-large"));
  assert.equal(ack.status, "accepted");
  assert.equal(forks, 1);
  const state = h.store.get(child.id)!;
  assert.deepEqual(state.thread.turns, child.turns);
  assert.deepEqual(
    [...state.sideChat!.inheritedTurnIds],
    child.turns.map((turn) => turn.id),
  );
  assert.deepEqual(
    h.rpc.params("thread/turns/list").map((p) => p.limit),
    [100, 50, 25, 12, 12],
  );
  assert.equal(
    projectThread(state.thread as unknown as CodexThread, {
      workspacePath: cwd,
      hiddenTurnIds: state.sideChat!.inheritedTurnIds,
    }).rows.window.length,
    0,
  );
  assert.equal((await h.store.ensure(child.id)).thread, state.thread);

  const send = await h.execute(
    h.command("sendText", { text: "Only answer this question" }, "cmd-side-large-send", child.id),
  );
  assert.equal(send.status, "accepted");
  const input = h.rpc.params("turn/start")[0]!.input as { text: string }[];
  assert.equal(input[0]!.text, `${SELECTION_SIDE_CHAT_BOUNDARY}\n\nOnly answer this question`);
});

test("side chat history read failure and command replay do not repeat the native fork", async (t) => {
  const h = await setup(t);
  const child = childFixture();
  h.rpc.handlers.set("thread/fork", () => ({
    thread: { ...child, turns: [] },
  }));
  h.rpc.handlers.set("thread/turns/list", () => {
    throw new Error("history unavailable");
  });
  const command = h.command("createSelectionSideSession", {}, "cmd-side-read-failed");
  const ack = await h.execute(command);
  assert.equal(ack.status, "failed");
  assert.equal(ack.message, "history unavailable");
  assert.deepEqual(await h.execute(command), ack);
  assert.equal(h.rpc.params("thread/fork").length, 1);
  assert.equal(h.store.getLoaded(child.id), undefined);
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
  const params = started[0] as {
    threadId: string;
    input: { text: string }[];
    model?: string;
  };
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
  // 模拟重启或父线程已删除后的冷恢复：当父不在 store 中且 thread/turns/list 失败时，fail-open 不裁剪。
  h.store.remove(sessionId);
  const state = await h.store.reloadAfterHistoryChange(child.id);
  assert.equal(state?.sideChat, undefined);
});

test("createSelectionSideSession inherits parent active model, provider, effort and mode when fork response omits runtime overrides", async (t) => {
  const h = await setup(t);
  const parent = h.store.get(sessionId)!;
  parent.thread.model = "glm-5.3";
  parent.thread.modelProvider = "ollama1";
  parent.thread.reasoningEffort = "high";
  parent.thread.collaborationMode = {
    mode: "plan",
    settings: {
      model: "glm-5.3",
      reasoning_effort: "high",
      developer_instructions: null,
    },
  };
  h.store.rememberMode(sessionId, "yolo");

  const child = {
    ...childFixture(),
    model: null,
    modelProvider: "openai",
    reasoningEffort: null,
  };
  scopeHandlers(h, child);
  h.rpc.handlers.set("thread/fork", () => ({ thread: child }));

  const ack = await h.execute(h.command("createSelectionSideSession", {}, "cmd-side-inherit"));
  assert.equal(ack.status, "accepted");
  const childState = h.store.get(child.id)!;
  assert.equal(childState.thread.model, "glm-5.3");
  assert.equal(childState.thread.modelProvider, "ollama1");
  assert.equal(childState.thread.reasoningEffort, "high");
  assert.deepEqual(childState.thread.collaborationMode, parent.thread.collaborationMode);

  const snapshot = projectThread(childState.thread as unknown as CodexThread, {
    workspacePath: cwd,
    hiddenTurnIds: childState.sideChat?.inheritedTurnIds,
  });
  assert.equal(snapshot.config.provider, "ollama1");
  assert.equal(snapshot.config.model, "glm-5.3");
  assert.equal(snapshot.config.thought, "high");
});

test("legacy fixture text input shape stays intact", () => {
  assert.deepEqual(textInput("x"), [{ type: "text", text: "x", text_elements: [] }]);
});
