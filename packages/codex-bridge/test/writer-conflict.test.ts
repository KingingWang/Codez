import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import {
  COMMANDS_REQUIRING_BASE_REVISION,
  ROW_TARGETING_COMMANDS,
  commandAckSchema,
  conversationSnapshotSchema,
  parseCommandEnvelope,
  type CommandEnvelope,
  type CommandType,
} from "@codez/shared/codez-protocol-v4";
import { BridgeSnapshots } from "../src/bridge-snapshots.js";
import { CommandRouter, type CommandContext } from "../src/commands.js";
import { CommandLedger } from "../src/command-ledger.js";
import { InteractionBroker } from "../src/interactions.js";
import { CodexRpcError } from "../src/rpc-errors.js";
import { ThreadStateStore } from "../src/thread-state.js";
import { threadFixture } from "./projection-fixtures.test.js";
import { MockRpc, cwd, sessionId, workspaceId } from "./fixtures/commands-fixture.js";

const conflictError = () =>
  new CodexRpcError(-32600, `thread ${sessionId} already has an active writer`);

/**
 * writer-conflict 场景装置：thread/resume 对源线程持锁报错，其余读方法免锁。
 * release() 模拟另一 writer 退出（锁释放），此后 resume 成功。
 */
async function conflictedSetup(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), "codez-writer-conflict-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const rpc = new MockRpc();
  const authority = { thread: threadFixture(), queue: [] as unknown[] };
  const threads = new Map<string, ReturnType<typeof threadFixture>>([
    [sessionId, authority.thread],
  ]);
  let conflicted = true;
  rpc.handlers.set("thread/read", (p) => ({ thread: threads.get(String(p.threadId)) }));
  rpc.handlers.set("thread/resume", (p) => {
    if (conflicted && p.threadId === sessionId) throw conflictError();
    return { thread: threads.get(String(p.threadId)) };
  });
  rpc.handlers.set("thread/turns/list", (p) => ({
    data: threads.get(String(p.threadId))?.turns ?? [],
    nextCursor: null,
  }));
  rpc.handlers.set("thread/queue/list", () => ({ data: authority.queue, nextCursor: null }));
  rpc.handlers.set("thread/fork", () => {
    const forked = { ...threadFixture(), id: "forked", turns: [] };
    threads.set("forked", forked);
    return { thread: forked };
  });
  const store = new ThreadStateStore(rpc, cwd);
  const ledger = new CommandLedger(root);
  const broker = new InteractionBroker(rpc, (id) => store.touch(id));
  const context: CommandContext = { rpc, store, interactions: broker, ledger, workspaceId };
  const router = new CommandRouter(context);
  const snapshots = new BridgeSnapshots({ rpc, cwd }, store, broker, workspaceId);
  const command = (
    type: CommandType,
    payload: unknown = {},
    id: string = type,
    target: string | null = sessionId,
  ): CommandEnvelope => {
    const current = target ? store.get(target) : undefined;
    const value = {
      type,
      payload,
      commandId: id,
      clientId: "desktop-1",
      sessionId: target,
      issuedAt: 1000,
      ...(COMMANDS_REQUIRING_BASE_REVISION.has(type)
        ? { baseRevision: current?.revision ?? 0 }
        : {}),
      ...(ROW_TARGETING_COMMANDS.has(type) ? { baseLogEpoch: current?.epoch ?? "missing" } : {}),
    };
    assert.equal(parseCommandEnvelope(value).ok, true, "fixtures must validate before dispatch");
    return value;
  };
  const execute = async (value: CommandEnvelope) => {
    const ack = await router.execute(value);
    assert.deepEqual(commandAckSchema.parse(ack), ack);
    return ack;
  };
  return {
    rpc,
    store,
    router,
    snapshots,
    command,
    execute,
    authority,
    release: () => {
      conflicted = false;
    },
  };
}

test("writer-conflict resume degrades to a read-only projection built from lock-free reads", async (t) => {
  const h = await conflictedSetup(t);
  const state = await h.store.ensure(sessionId);
  assert.equal(state.readOnly, "writer-conflict");
  // 历史来自免锁的 thread/turns/list 分页，而不是被锁挡住后整体失败。
  const turns = state.thread.turns as { id: string }[];
  assert.deepEqual(
    turns.map((turn) => turn.id),
    ["turn-1"],
  );
  // 原生 queue/list 不属于已验证的免锁读集合，降级加载不读队列。
  assert.deepEqual(state.queue, []);
  assert.deepEqual(h.rpc.methods(), ["thread/read", "thread/resume", "thread/turns/list"]);
});

test("resume failures without the exact writer-conflict signature still reject the load", async () => {
  for (const error of [
    new CodexRpcError(-32600, "some other invalid request"),
    new CodexRpcError(-32000, `thread ${sessionId} already has an active writer`),
    new Error(`thread ${sessionId} already has an active writer`),
  ]) {
    const rpc = new MockRpc();
    rpc.handlers.set("thread/read", () => ({ thread: threadFixture() }));
    rpc.handlers.set("thread/resume", () => {
      throw error;
    });
    const store = new ThreadStateStore(rpc, cwd);
    await assert.rejects(store.ensure(sessionId));
    assert.equal(store.get(sessionId), undefined);
  }
});

test("read-only snapshot keeps fork, blocks write availability and suppresses edit/retry rows", async (t) => {
  const h = await conflictedSetup(t);
  const snapshot = await h.snapshots.conversation(sessionId);
  assert.deepEqual(snapshot.writerConflict, { readOnly: true });
  // fork 是只读会话的逃生通道，idle 门禁语义不变。
  assert.deepEqual(snapshot.availability.fork, { allowed: true });
  for (const key of ["compact", "switchModelConfig", "queueEdit", "sendQueuedNow"] as const)
    assert.deepEqual(snapshot.availability[key], {
      allowed: false,
      reasonCode: "guard.codex.writerConflict",
    });
  const rows = snapshot.rows.window;
  assert.ok(rows.length > 0, "history must render in read-only mode");
  const user = rows.find((row) => row.kind === "userInput");
  const assistant = rows.find((row) => row.kind === "assistantText");
  assert.equal(user?.actions, undefined, "edit/retry must be suppressed");
  assert.deepEqual(assistant?.actions, { canFork: true });
});

test("deny-by-default: every existing-session command except forkAssistant is rejected", async (t) => {
  const h = await conflictedSetup(t);
  // 订阅等价物：客户端据此拿到 CAS 水位与行身份。
  await h.store.ensure(sessionId);
  assert.equal(h.store.get(sessionId)?.readOnly, "writer-conflict");
  const callsAfterLoad = h.rpc.calls.length;
  const cases: [CommandType, unknown][] = [
    ["sendText", { text: "Hello" }],
    ["stop", {}],
    ["compact", {}],
    ["renameSession", { title: "x" }],
    ["deleteSession", {}],
    ["sendQueuedNow", { queueItemId: "q1" }],
    ["editQueueItem", { queueItemId: "q1", newText: "x" }],
    ["deleteQueueItem", { queueItemId: "q1" }],
    ["reorderQueueItem", { queueItemId: "q1", beforeQueueItemId: null }],
    ["switchModelConfig", { provider: "openai", model: "fixture-model", thought: "medium" }],
    ["switchCollaborationMode", { mode: "plan" }],
    ["resolveInteraction", { interactionId: "i1", answer: { optionId: "o" } }],
    // dispatch switch 本就不认识的类型也必须被 guard 拦住（枚举会漏掉未来的写命令）。
    ["pauseGoal", {}],
    [
      "editUserQuery",
      {
        target: { rowId: 2, entityId: "codex:turn:turn-1:item:user-1" },
        newText: "x",
      },
    ],
    ["retryTurn", { target: { rowId: 3, entityId: "codex:turn:turn-1:item:answer-1" } }],
  ];
  for (const [type, payload] of cases) {
    const ack = await h.execute(h.command(type, payload));
    assert.equal(ack.status, "rejected", type);
    assert.equal(ack.reasonCode, "guard.codex.writerConflict", type);
  }
  assert.equal(h.rpc.calls.length, callsAfterLoad, "no write command may reach native RPC");
  // fork 豁免：只读源线程（fork 读 rollout、不取源写锁），新线程正常加载。
  const fork = await h.execute(
    h.command(
      "forkAssistant",
      { target: { rowId: 3, entityId: "codex:turn:turn-1:item:answer-1" } },
      "fork",
    ),
  );
  assert.equal(fork.status, "accepted");
  assert.deepEqual(fork.result, { type: "forkAssistant", sessionId: "forked" });
  assert.deepEqual(h.rpc.params("thread/fork"), [{ threadId: sessionId, lastTurnId: "turn-1" }]);
  assert.equal(h.store.get("forked")?.readOnly, undefined);
});

test("cold forkAssistant loads the unloaded conflicted thread through the ensure fallback", async (t) => {
  const h = await conflictedSetup(t);
  // cold：store 里没有任何条目（未 markStarted）；唯一的加载路径是 ensure 降级加载。
  assert.equal(h.store.get(sessionId), undefined);
  // 客户端只能拿着订阅快照的 epoch/revision 发起 fork；这里先 ensure（订阅等价物）再下发，
  // 证明 load 的 writer-conflict 降级在命令链路上完整可用，而不是只有 markStarted 的会话能 fork。
  await h.store.ensure(sessionId);
  assert.equal(h.store.get(sessionId)?.readOnly, "writer-conflict");
  const ack = await h.execute(
    h.command("forkAssistant", {
      target: { rowId: 3, entityId: "codex:turn:turn-1:item:answer-1" },
    }),
  );
  assert.equal(ack.status, "accepted");
  assert.deepEqual(ack.result, { type: "forkAssistant", sessionId: "forked" });
});

test("invalidate retries resume on reload and recovers to writable once the lock is released", async (t) => {
  const h = await conflictedSetup(t);
  const first = await h.store.ensure(sessionId);
  assert.equal(first.readOnly, "writer-conflict");
  const resumes = () => h.rpc.params("thread/resume").length;
  const before = resumes();
  // 锁仍占用：invalidate 丢弃只读条目，重载重试 resume，仍是只读。
  h.store.invalidate(sessionId);
  assert.equal(h.store.get(sessionId), undefined);
  const second = await h.store.ensure(sessionId);
  assert.equal(second.readOnly, "writer-conflict");
  assert.ok(resumes() > before, "reload must retry resume");
  // 锁释放后 invalidate → 重载 → resume 成功 → 投影恢复可写。
  h.release();
  h.store.invalidate(sessionId);
  const third = await h.store.ensure(sessionId);
  assert.equal(third.readOnly, undefined);
  const snapshot = await h.snapshots.conversation(sessionId);
  assert.equal(snapshot.writerConflict, undefined);
  assert.deepEqual(snapshot.availability.compact, { allowed: true });
});

test("invalidate is a no-op for healthy writable projections", async (t) => {
  const h = await conflictedSetup(t);
  h.release();
  const state = await h.store.ensure(sessionId);
  const loads = h.rpc.params("thread/read").length;
  h.store.invalidate(sessionId);
  assert.equal(h.store.get(sessionId), state);
  await h.store.ensure(sessionId);
  assert.equal(h.rpc.params("thread/read").length, loads, "healthy threads must not reload");
});

test("snapshot schema keeps writerConflict additive: old snapshots without the field still parse", async (t) => {
  const h = await conflictedSetup(t);
  const snapshot = await h.snapshots.conversation(sessionId);
  const roundTripped = conversationSnapshotSchema.parse(JSON.parse(JSON.stringify(snapshot)));
  assert.deepEqual(roundTripped.writerConflict, { readOnly: true });
  // 旧快照/旧发送端不携带该字段：解析成功且不发明只读标记。
  const legacy = JSON.parse(JSON.stringify(snapshot)) as Record<string, unknown>;
  delete legacy.writerConflict;
  const parsed = conversationSnapshotSchema.parse(legacy);
  assert.equal(parsed.writerConflict, undefined);
});
