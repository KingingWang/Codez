import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { BridgeSnapshots } from "../src/bridge-snapshots.js";
import type { CodexThread } from "../src/codex-types.js";
import type { BridgeStateDiagnostic } from "../src/diagnostics.js";
import { deferred, sessionId, setup, turn } from "./fixtures/commands-fixture.js";
import { threadFixture } from "./projection-fixtures.test.js";

const CHILD = "child-1";
const CHILD_B = "child-2";

async function fixture(t: TestContext, busy = false) {
  const h = await setup(t, busy);
  const children = new Map<string, CodexThread>();
  for (const id of [CHILD, CHILD_B]) {
    children.set(id, {
      ...threadFixture(),
      id,
      parentThreadId: sessionId,
      status: { type: "active", activeFlags: [] },
      turns: [turn(`${id}-turn`)],
    });
  }
  const diagnostics: BridgeStateDiagnostic[] = [];
  h.context.onSubagentStopFallback = (diagnostic) => diagnostics.push(diagnostic);
  h.rpc.handlers.set("thread/read", (p) => ({
    thread: p.threadId === sessionId ? h.authority.thread : children.get(String(p.threadId)),
  }));
  h.rpc.handlers.set("thread/turns/list", (p) => ({
    data:
      p.threadId === sessionId ? h.authority.thread.turns : children.get(String(p.threadId))?.turns,
    nextCursor: null,
  }));
  h.rpc.handlers.set("thread/list", () => ({ data: [...children.values()], nextCursor: null }));
  h.state.thread.turns = structuredClone(h.authority.thread.turns);
  h.store.noteSubagentChildren(sessionId, [CHILD, CHILD_B]);
  return { ...h, children, diagnostics };
}

test("#32 running child 投影 cancellable work；只读父不暴露 Stop", async (t) => {
  const h = await fixture(t);
  const turns = h.state.thread.turns as { items: unknown[] }[];
  turns[0]!.items.push({
    type: "collabAgentToolCall",
    id: "spawn-1",
    tool: "spawnAgent",
    status: "completed",
    senderThreadId: sessionId,
    receiverThreadIds: [CHILD],
    prompt: "Synthetic child task",
    model: null,
    reasoningEffort: null,
    agentsStates: {},
  });
  h.store.touch(sessionId);
  const snapshots = new BridgeSnapshots(
    { rpc: h.rpc, cwd: h.store.cwd },
    h.store,
    h.broker,
    h.context.workspaceId,
  );
  const first = await snapshots.conversation(sessionId);
  assert.deepEqual(first.backgroundWorks, [
    {
      workId: CHILD,
      kind: "subagent",
      title: "Synthetic child task",
      status: "running",
      startedAt: 101_000,
      cancellable: true,
      anchorRowId: null,
      childSessionId: CHILD,
    },
  ]);
  await snapshots.whenSubagentActivitySeedsSettled();
  h.state.readOnly = "writer-conflict";
  h.store.touch(sessionId);
  assert.equal((await snapshots.conversation(sessionId)).backgroundWorks[0]?.cancellable, false);
  await h.store.apply({
    method: "turn/completed",
    params: { threadId: CHILD, turn: { ...turn("child-1-turn"), status: "interrupted" } },
  });
  const ended = await snapshots.conversation(sessionId);
  assert.deepEqual(ended.backgroundWorks, []);
  assert.equal(ended.subagents?.running.length, 0);
  // 子线程事件只收敛活性，父 collab item 终态由 Codex driver 拥有。
  assert.equal(ended.rows.window.find((row) => row.kind === "subagent")?.status, "running");
});

test("#32 cancel 免锁查询精确 child turn；ACK 不提前合成终态；重复 commandId 幂等", async (t) => {
  const h = await fixture(t);
  const command = h.command("cancelBackgroundWork", { workId: CHILD }, "cancel-child");
  const ack = await h.execute(command);
  assert.equal(ack.status, "accepted", ack.message);
  assert.deepEqual(h.rpc.params("turn/interrupt"), [{ threadId: CHILD, turnId: `${CHILD}-turn` }]);
  assert.equal(h.rpc.params("thread/resume").length, 0);
  assert.equal(h.rpc.params("thread/queue/list").length, 0);
  assert.equal(h.rpc.params("thread/turns/list")[0]?.itemsView, "notLoaded");
  assert.equal(h.children.get(CHILD)?.turns[0]?.status, "inProgress");
  assert.deepEqual(await h.execute(command), ack);
  assert.equal(h.rpc.params("turn/interrupt").length, 1);
});

test("#32 已结束 child 幂等 accepted，不发 interrupt", async (t) => {
  const h = await fixture(t);
  const child = h.children.get(CHILD)!;
  child.status = { type: "notLoaded" };
  child.turns[0]!.status = "interrupted";
  const ack = await h.execute(h.command("cancelBackgroundWork", { workId: CHILD }));
  assert.equal(ack.status, "accepted", ack.message);
  assert.equal(h.rpc.params("turn/interrupt").length, 0);
  assert.equal(h.rpc.params("thread/resume").length, 0);
});

test("#32 未登记 workId fail closed，不对用户指定目标发 RPC", async (t) => {
  const h = await fixture(t);
  for (const workId of [sessionId, "unregistered-child", "foreign-work"]) {
    const ack = await h.execute(h.command("cancelBackgroundWork", { workId }, workId));
    assert.equal(ack.status, "failed");
  }
  assert.equal(h.rpc.calls.length, 0);
});

test("#32 登记仍需原生身份校验；异父、错 ID、多个 active turn fail closed", async (t) => {
  for (const invalid of ["parent", "id", "turns"] as const) {
    const h = await fixture(t);
    const child = h.children.get(CHILD)!;
    if (invalid === "parent") child.parentThreadId = "foreign-parent";
    if (invalid === "id") child.id = CHILD_B;
    if (invalid === "turns") child.turns.push(turn("unexpected-active-turn"));
    const ack = await h.execute(h.command("cancelBackgroundWork", { workId: CHILD }));
    assert.equal(ack.status, "failed", invalid);
    assert.equal(h.rpc.params("turn/interrupt").length, 0, invalid);
  }
});

test("#32 查询期间关系失效不再 interrupt；child 换 turn 不猜测新 turn 重试", async (t) => {
  const h = await fixture(t);
  const gate = deferred<{ data: unknown[]; nextCursor: null }>();
  const reading = deferred();
  h.rpc.handlers.set("thread/turns/list", () => {
    reading.resolve();
    return gate.promise;
  });
  const cancel = h.execute(h.command("cancelBackgroundWork", { workId: CHILD }, "invalidated"));
  await reading.promise;
  h.store.noteSubagentChildren(sessionId, []);
  gate.resolve({ data: [turn("old-turn")], nextCursor: null });
  assert.equal((await cancel).status, "failed");
  assert.equal(h.rpc.params("turn/interrupt").length, 0);
  h.store.noteSubagentChildren(sessionId, [CHILD]);
  h.rpc.handlers.set("thread/turns/list", () => ({ data: [turn("old-turn")], nextCursor: null }));
  h.rpc.handlers.set("turn/interrupt", () => {
    throw new Error("Turn changed");
  });
  assert.equal(
    (await h.execute(h.command("cancelBackgroundWork", { workId: CHILD }, "changed"))).status,
    "failed",
  );
  assert.deepEqual(h.rpc.params("turn/interrupt"), [{ threadId: CHILD, turnId: "old-turn" }]);
});

test("#32 root stop 先 interrupt root 再逐个 child，root idle 也停止 child", async (t) => {
  for (const busy of [true, false]) {
    const h = await fixture(t, busy);
    const ack = await h.execute(h.command("stop"));
    assert.equal(ack.status, "accepted", ack.message);
    assert.deepEqual(h.rpc.params("turn/interrupt"), [
      ...(busy ? [{ threadId: sessionId, turnId: "live-turn" }] : []),
      { threadId: CHILD, turnId: `${CHILD}-turn` },
      { threadId: CHILD_B, turnId: `${CHILD_B}-turn` },
    ]);
  }
});

test("#32 root stale 或 root interrupt 失败时不级联", async (t) => {
  const h = await fixture(t, true);
  assert.equal(
    (
      await h.execute(
        h.command("stop", { expectedForegroundExecutionId: "stale-turn" }, "stale-stop"),
      )
    ).status,
    "failed",
  );
  assert.equal(h.rpc.calls.length, 0);
  h.rpc.handlers.set("turn/interrupt", () => {
    throw new Error("Root interrupt failed");
  });
  assert.equal((await h.execute(h.command("stop", {}, "root-failed"))).status, "failed");
  assert.deepEqual(h.rpc.params("turn/interrupt"), [{ threadId: sessionId, turnId: "live-turn" }]);
  assert.equal(h.rpc.params("thread/read").length, 0);
});

test("#32 单 child 读取/interrupt 失败及诊断回调失败不翻转 root ACK", async (t) => {
  for (const failure of ["read", "interrupt", "diagnostic"] as const) {
    const h = await fixture(t, true);
    if (failure === "read") {
      h.rpc.handlers.set("thread/read", (p) => {
        if (p.threadId === CHILD) throw new Error("Read failed");
        return { thread: h.children.get(String(p.threadId)) };
      });
    } else {
      h.rpc.handlers.set("turn/interrupt", (p) => {
        if (p.threadId === CHILD) throw new Error("Interrupt failed");
        return {};
      });
    }
    if (failure === "diagnostic")
      h.context.onSubagentStopFallback = () => {
        throw new Error("Diagnostic writer failed");
      };
    const ack = await h.execute(h.command("stop"));
    assert.equal(ack.status, "accepted", ack.message);
    assert.ok(h.rpc.params("turn/interrupt").some((p) => p.threadId === CHILD_B));
    if (failure !== "diagnostic")
      assert.deepEqual(h.diagnostics, [
        { kind: "subagentStopFallback", sessionId, childSessionId: CHILD },
      ]);
  }
});

test("#32 child envelope 的 stop/cancel/send/retry/edit 继续 guard.subagentReadOnly", async (t) => {
  const h = await fixture(t);
  h.store.put(h.children.get(CHILD)!);
  h.store.get(CHILD)!.readOnly = "subagent-child";
  for (const [type, payload] of [
    ["stop", {}],
    ["cancelBackgroundWork", { workId: CHILD_B }],
    ["sendText", { text: "Forbidden" }],
    ["retryTurn", { target: { rowId: 1, entityId: "synthetic-item" } }],
    [
      "editUserQuery",
      {
        target: { rowId: 1, entityId: "synthetic-item" },
        newText: "Forbidden",
        workspaceMode: "preserve",
      },
    ],
  ] as const) {
    const ack = await h.execute(h.command(type, payload, type, CHILD));
    assert.equal(ack.status, "rejected", type);
    assert.equal(ack.reasonCode, "guard.subagentReadOnly", type);
  }
  assert.equal(h.rpc.params("turn/interrupt").length, 0);
});
