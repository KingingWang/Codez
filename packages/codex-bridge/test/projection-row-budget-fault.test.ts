import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  PROTOCOL_V4_LIMITS as limits,
  V4_METHODS,
  commandAckSchema,
  conversationSnapshotSchema,
  routedTopicWireFrameSchema,
  type RoutedTopicWireFrame,
} from "@codez/shared/codez-protocol-v4";
import { BridgeRuntime } from "../src/bridge-runtime.js";
import { BridgeSubscriptions, type ConversationStateVersion } from "../src/subscriptions.js";
import {
  ROW_BUDGET_FAULT_CODE,
  RowBudgetExceededError,
  assertRowBudget,
  isRowBudgetExceeded,
} from "../src/projection-bounds.js";
import { projectThread } from "../src/projection.js";
import type { CodexNotification, CodexProcess, CodexServerRequest } from "../src/contract.js";
import type { CodexThread, CodexThreadItem } from "../src/codex-types.js";
import { threadFixture } from "./projection-fixtures.test.js";

/**
 * A(i) 回归：单条投影行超出组装预算不得终止 bridge。
 *
 * 原因：`assertRowBudget` 过去抛裸 Error，沿 projectRows → projectThread → BridgeSnapshots
 * → BridgeSubscriptions.changed 冒泡到 bridge-runtime 的 `conversation-projection` catch，
 * 被当成不可恢复故障 `options.fatal` → main.ts `stop(true)` → `process.exitCode = 1`。
 * 超限 item 已持久化在原生 rollout 里，于是该会话永久打不开，且每次尝试都杀死整个 bridge
 * 进程，连带同一窗口内其他会话一起掉线。
 * 依据：specs/codex-desktop-adapter.md:364-367（fatal 只保留给 invalid JSON、invalid UTF-8、
 * 畸形信封等「resync 不可证明安全」的协议违规）与 :392-393（超限 item 仍必须显式失败，
 * 不得静默截断，也不得用占位行改写历史）。
 */
const cwd = "/workspace";
const workspaceId = "identity-A";
const workspace = {
  workspacePath: cwd,
  workspaceKey: workspaceId,
  workspaceIdentity: workspaceId,
};
const rowBudget = Math.floor(
  (limits.logicalFrameAssemblyMaxBytes - limits.maxFrameBytes) / limits.snapshotTailWindowRows,
);
/** 可识别哨兵：诊断与错误正文都不得携带行内容（spec:394-396）。 */
const SENTINEL = "ZZ-ROW-BUDGET-SENTINEL-9f3a7c";
/** ASCII 正文，长度即字节数；加上行信封后必然越过 rowBudget。 */
const oversizedText = `${SENTINEL}${"x".repeat(rowBudget)}`;
const OVERSIZED_ITEM_ID = "oversized-1";
const WARN_PREFIX = "Codex desktop bridge warn: conversation row over budget;";
const PINNED_MESSAGE = /Codex projection row .* exceeds .* bytes/;
const MUTATIONS = ["thread/fork", "thread/revert", "turn/start"];

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
async function settle(rounds = 10): Promise<void> {
  for (let index = 0; index < rounds; index++) await tick();
}
/** 让 eventTail、queueMicrotask 扇出与 0ms 定时器都跑完。 */
async function drain(): Promise<void> {
  await settle();
  await new Promise((resolve) => setTimeout(resolve, 40));
  await settle();
}

function oversizedItem(): CodexThreadItem {
  return {
    type: "agentMessage",
    id: OVERSIZED_ITEM_ID,
    text: oversizedText,
    phase: "final_answer",
  };
}

/** 捕获并吞掉本用例产生的闭合诊断行，其余 stderr 原样透传，避免污染测试输出。 */
function captureWarnLines(t: TestContext): string[] {
  const lines: string[] = [];
  const original = process.stderr.write;
  const forward = original as unknown as (chunk: unknown, ...rest: unknown[]) => boolean;
  process.stderr.write = function (this: unknown, chunk: unknown, ...rest: unknown[]) {
    const text = Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
    if (text.startsWith(WARN_PREFIX)) {
      lines.push(text.replace(/\n$/, ""));
      return true;
    }
    return forward.call(this, chunk, ...rest);
  } as typeof process.stderr.write;
  t.after(() => {
    process.stderr.write = original;
  });
  return lines;
}

interface RuntimeHandle {
  frames: RoutedTopicWireFrame[];
  fatal: Error[];
  fatalOrigins: (string | undefined)[];
  runtime: BridgeRuntime;
  close(): Promise<void>;
}

/** 真实 BridgeRuntime + 假原生传输：thread-1 承载超限 item，thread-2 用于跨会话隔离。 */
async function nativeFixture(t: TestContext) {
  const roots: string[] = [];
  const calls: { method: string; params: unknown }[] = [];
  const notifications = new Set<(event: CodexNotification) => void>();
  const threads: Record<string, CodexThread> = {
    "thread-1": threadFixture(),
    "thread-2": { ...threadFixture(), id: "thread-2" },
  };
  const thread = (params: unknown): CodexThread => {
    const id = String((params as { threadId?: unknown }).threadId);
    const found = threads[id];
    assert.ok(found, `fixture has no thread ${id}`);
    return found;
  };
  const handlers: Record<string, (params: unknown) => unknown> = {
    "config/read": () => ({ config: { model: "fixture-model", model_provider: "openai" } }),
    "model/list": () => ({ data: [], nextCursor: null }),
    "skills/list": () => ({ data: [{ cwd, skills: [], errors: [] }] }),
    "thread/list": () => ({ data: Object.values(threads), nextCursor: null }),
    "thread/read": (params) => ({ thread: thread(params) }),
    "thread/resume": (params) => ({ thread: thread(params) }),
    "thread/turns/list": (params) => ({ data: thread(params).turns, nextCursor: null }),
    "thread/items/list": () => ({ data: [], nextCursor: null }),
    "thread/queue/list": () => ({ data: [], nextCursor: null }),
    "thread/unsubscribe": () => ({ status: "unsubscribed" }),
    // 变更型原生调用一旦到达，就说明「先投影、后变更」的失败闭合被破坏。
    "thread/fork": () => {
      throw new Error("thread/fork must not be reached");
    },
    "thread/revert": () => {
      throw new Error("thread/revert must not be reached");
    },
    "turn/start": () => {
      throw new Error("turn/start must not be reached");
    },
  };
  const rpc: CodexProcess = {
    async request<T>(method: string, params?: unknown): Promise<T> {
      calls.push({ method, params });
      const handler = handlers[method];
      assert.ok(handler, `Unexpected native RPC: ${method}`);
      return (await handler(params)) as T;
    },
    onNotification(fn) {
      notifications.add(fn);
      return () => notifications.delete(fn);
    },
    onRequest(_fn: (request: CodexServerRequest) => void) {
      return () => {};
    },
    onClose() {
      return () => {};
    },
    async initialize() {},
    async respond() {},
    async respondError() {},
    async close() {},
  };
  const emit = (method: string, params: unknown): void => {
    for (const listener of notifications) listener({ method, params });
  };
  const createRuntime = async (): Promise<RuntimeHandle> => {
    const root = await mkdtemp(join(tmpdir(), "codez-row-budget-"));
    roots.push(root);
    const frames: RoutedTopicWireFrame[] = [];
    const fatal: Error[] = [];
    const fatalOrigins: (string | undefined)[] = [];
    const runtime = new BridgeRuntime({
      rpc,
      cwd,
      workspaceId,
      stateRoot: root,
      async notify(method, params) {
        assert.equal(method, "v4/conversation/frame");
        frames.push(routedTopicWireFrameSchema.parse(params));
      },
      logRuntimeNotice() {},
      fatal(error, origin) {
        fatal.push(error);
        fatalOrigins.push(origin);
      },
    });
    let closed = false;
    return {
      frames,
      fatal,
      fatalOrigins,
      runtime,
      async close() {
        if (closed) return;
        closed = true;
        await runtime.close();
      },
    };
  };
  t.after(async () => {
    await settle();
    for (const root of roots) await rm(root, { recursive: true, force: true });
  });
  return { calls, threads, emit, createRuntime };
}

async function subscribeConversation(
  handle: RuntimeHandle,
  sessionId: string,
  connectionId: string,
  clientMode: "desktop-continuous" | "web-remote-replayable" = "desktop-continuous",
) {
  const response = await handle.runtime.request(V4_METHODS.conversationSubscribe, {
    topic: `conversation/${sessionId}`,
    clientMode,
    connectionId,
    workspace,
  });
  await response.afterResponse?.();
  await settle();
  return response;
}

function conversationFrames(handle: RuntimeHandle, sessionId: string): RoutedTopicWireFrame[] {
  return handle.frames.filter((frame) => frame.topic === `conversation/${sessionId}`);
}

/**
 * 把超限 assistant 行写进 thread-1 的原生权威历史。
 *
 * `ThreadStateStore.load()` 用 `thread/turns/list` 返回的原生 turn 对象组装状态
 * （thread-state.ts:219-237，首次加载 `live` 为空，turn 引用原样进入 `merged`），
 * 因此这里的 `items` 数组与已加载投影状态共享引用：不发事件也能让下一次投影看到该行，
 * 从而把「状态版本前进」与「历史里出现超限行」两件事在测试里分开控制。
 */
function persistOversizedRow(fixture: { threads: Record<string, CodexThread> }): void {
  fixture.threads["thread-1"]!.turns[0]!.items.push(oversizedItem());
}

test("assertRowBudget throws a typed, content-free fault and keeps the pinned message", () => {
  const row = {
    rowId: 7,
    entityId: "codex:turn:turn-1:item:answer-1",
    turnId: "turn-1",
    kind: "assistantText",
    text: oversizedText,
  };
  assert.ok(
    Buffer.byteLength(JSON.stringify(row), "utf8") > rowBudget,
    "fixture row must actually exceed the budget, otherwise every case below is vacuous",
  );
  let caught: unknown;
  try {
    assertRowBudget(row as never);
  } catch (error) {
    caught = error;
  }
  assert.ok(isRowBudgetExceeded(caught));
  assert.equal(caught.code, ROW_BUDGET_FAULT_CODE);
  assert.equal(caught.kind, "assistantText");
  assert.equal(caught.budget, rowBudget);
  assert.ok(caught.bytes > rowBudget);
  // 文案必须与改动前逐字节一致：test/projection-bounds.test.ts:177-178 钉住同一正则。
  assert.match(caught.message, PINNED_MESSAGE);
  assert.equal(
    caught.message,
    `Codex projection row codex:turn:turn-1:item:answer-1 (assistantText) exceeds ${rowBudget} bytes: ${caught.bytes}; native content was not truncated`,
  );
  assert.ok(!caught.message.includes(SENTINEL), "row content must never enter the fault");
  assert.equal(isRowBudgetExceeded(new Error(caught.message)), false);
});

test("(i) a persisted oversized assistant row never terminates the bridge and stays explicit", async (t) => {
  const warnLines = captureWarnLines(t);
  const fixture = await nativeFixture(t);
  const handle = await fixture.createRuntime();
  t.after(() => handle.close());

  await subscribeConversation(handle, "thread-1", "desktop-1");
  const healthyFrames = conversationFrames(handle, "thread-1").length;
  assert.ok(healthyFrames > 0, "healthy history must publish first");
  assert.deepEqual(handle.fatal, []);

  // 原生把超限 assistant 回复持久化进 rollout，随后发来完成通知。
  persistOversizedRow(fixture);
  const turn = fixture.threads["thread-1"]!.turns[0]!;
  fixture.emit("turn/completed", { threadId: "thread-1", turn });
  await drain();

  // 关键断言：不 fatal，即 main.ts 不会 stop(true) / process.exitCode = 1。
  assert.deepEqual(handle.fatal, [], "row budget is recoverable and must not be fatal");
  assert.deepEqual(handle.fatalOrigins, []);
  // 显式失败仍然可观测：至少一条闭合诊断；该 topic 停止发帧（不截断、不用占位行伪造历史）。
  // 一次 turn/completed 会推进多个 state 版本（store.apply 的 touch + interactions.expireTurn
  // 的 touch，见 bridge-runtime.ts:159-164），每个版本合法地重新武装一次，所以这里只断言下界；
  // 「同一版本 N 次 changed 只投影一次」由下面的 publisher 级 reads 计数用例精确钉住。
  assert.ok(warnLines.length >= 1, "the fault must stay explicit");
  const afterTurnCompleted = warnLines.length;
  // 静默期：没有新事件就不再重投影、也不再重复投递（subscriptions.ts 里没有任何定时器自旋）。
  await drain();
  await drain();
  assert.equal(warnLines.length, afterTurnCompleted, "a faulted version must stay quiescent");
  // thread/name/updated 只 touch 一次（thread-state.ts:494）⇒ 恰好一次版本前进 ⇒ 恰好 +1 条诊断。
  fixture.emit("thread/name/updated", { threadId: "thread-1", threadName: "renamed" });
  await drain();
  assert.equal(
    warnLines.length,
    afterTurnCompleted + 1,
    "exactly one bounded diagnostic per state version advance",
  );
  assert.deepEqual(handle.fatal, []);
  assert.equal(conversationFrames(handle, "thread-1").length, healthyFrames);

  // 订阅者拿到 typed fault：显式读取入口仍然拒绝，携带同一故障码与钉住的文案。
  let rejection: unknown;
  try {
    await subscribeConversation(handle, "thread-1", "desktop-2");
  } catch (error) {
    rejection = error;
  }
  assert.ok(isRowBudgetExceeded(rejection), "explicit read must reject with the typed fault");
  assert.equal((rejection as RowBudgetExceededError).code, ROW_BUDGET_FAULT_CODE);
  assert.match((rejection as RowBudgetExceededError).message, PINNED_MESSAGE);
  assert.deepEqual(handle.fatal, []);
});

test("(v) the bounded diagnostic carries kind and byte count only, never row content", async (t) => {
  const warnLines = captureWarnLines(t);
  const fixture = await nativeFixture(t);
  const handle = await fixture.createRuntime();
  t.after(() => handle.close());
  await subscribeConversation(handle, "thread-1", "desktop-1");
  persistOversizedRow(fixture);
  // item/completed 只推进一个 state 版本，因此恰好产生一条诊断，可以逐字段核对形状。
  const turn = fixture.threads["thread-1"]!.turns[0]!;
  fixture.emit("item/completed", { threadId: "thread-1", turnId: turn.id, item: oversizedItem() });
  await drain();

  assert.equal(warnLines.length, 1, "expected exactly one bounded diagnostic");
  const shape = new RegExp(
    `^${WARN_PREFIX.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} origin=conversation-projection; ` +
      `code=fault\\.projection\\.rowBudget; kind=assistantText; bytes=\\d{1,15}; budget=${rowBudget}$`,
  );
  for (const line of warnLines) {
    assert.match(line, shape, `diagnostic must stay inside the closed field set: ${line}`);
    assert.ok(!line.includes(SENTINEL), "row content must never reach stderr");
    assert.ok(!line.includes(OVERSIZED_ITEM_ID), "native item id must not reach stderr");
    assert.ok(!line.includes(cwd), "paths must not reach stderr");
    assert.ok(line.length < 256, "diagnostic must stay bounded");
  }
  assert.deepEqual(handle.fatal, []);
});

test("(iii) a faulted conversation does not take other sessions in the same bridge down", async (t) => {
  const warnLines = captureWarnLines(t);
  const fixture = await nativeFixture(t);
  const handle = await fixture.createRuntime();
  t.after(() => handle.close());
  await subscribeConversation(handle, "thread-1", "desktop-1");
  await subscribeConversation(handle, "thread-2", "desktop-3");
  const healthyBefore = conversationFrames(handle, "thread-2").length;
  assert.ok(healthyBefore > 0);

  persistOversizedRow(fixture);
  const faultedTurn = fixture.threads["thread-1"]!.turns[0]!;
  fixture.emit("item/completed", {
    threadId: "thread-1",
    turnId: faultedTurn.id,
    item: oversizedItem(),
  });
  await drain();
  assert.deepEqual(handle.fatal, []);
  assert.equal(warnLines.length, 1);

  // 同一进程内的健康会话继续投影并发布新帧。
  fixture.emit("thread/name/updated", { threadId: "thread-2", threadName: "Still alive" });
  await drain();
  assert.deepEqual(handle.fatal, []);
  assert.ok(
    conversationFrames(handle, "thread-2").length > healthyBefore,
    "healthy session must keep publishing after another session faults",
  );
});

test("(iv) a restarted bridge rejects the read with the typed fault instead of exiting", async (t) => {
  captureWarnLines(t);
  const fixture = await nativeFixture(t);
  // 超限 item 已经落在原生权威历史里：重启后的 bridge 读到的是同一份持久化事实。
  fixture.threads["thread-1"]!.turns[0]!.items.push(oversizedItem());

  const first = await fixture.createRuntime();
  let firstRejection: unknown;
  try {
    await subscribeConversation(first, "thread-1", "desktop-1");
  } catch (error) {
    firstRejection = error;
  }
  assert.ok(isRowBudgetExceeded(firstRejection));
  assert.deepEqual(first.fatal, [], "cold read of an oversized row must not be fatal");
  await first.close();

  const second = await fixture.createRuntime();
  t.after(() => second.close());
  let rejection: unknown;
  try {
    await subscribeConversation(second, "thread-1", "desktop-9");
  } catch (error) {
    rejection = error;
  }
  assert.ok(isRowBudgetExceeded(rejection), "restart must reject with the same typed fault");
  assert.equal((rejection as RowBudgetExceededError).code, ROW_BUDGET_FAULT_CODE);
  assert.match((rejection as RowBudgetExceededError).message, PINNED_MESSAGE);
  assert.deepEqual(second.fatal, []);
  assert.deepEqual(second.fatalOrigins, []);
  // 同一进程仍然可用：健康会话照常订阅成功并发帧。
  await subscribeConversation(second, "thread-2", "desktop-8");
  assert.ok(conversationFrames(second, "thread-2").length > 0);
  assert.deepEqual(second.fatal, []);
});

test("(vii) the same route heals once the oversized row is gone and the version advances", async (t) => {
  const warnLines = captureWarnLines(t);
  const fixture = await nativeFixture(t);
  const handle = await fixture.createRuntime();
  t.after(() => handle.close());
  await subscribeConversation(handle, "thread-1", "desktop-1");
  persistOversizedRow(fixture);
  const faultedTurn = fixture.threads["thread-1"]!.turns[0]!;
  fixture.emit("item/completed", {
    threadId: "thread-1",
    turnId: faultedTurn.id,
    item: oversizedItem(),
  });
  await drain();
  assert.deepEqual(handle.fatal, []);
  assert.equal(warnLines.length, 1);
  const faultedFrames = conversationFrames(handle, "thread-1").length;

  // 原生裁剪掉超限 item（例如 CLI 侧重写历史）后，同一订阅路由无需重订阅即可恢复。
  const turn = fixture.threads["thread-1"]!.turns[0]!;
  turn.items = turn.items.filter((item) => item.id !== OVERSIZED_ITEM_ID);
  fixture.emit("thread/name/updated", { threadId: "thread-1", threadName: "Recovered" });
  await drain();

  assert.deepEqual(handle.fatal, []);
  assert.ok(
    conversationFrames(handle, "thread-1").length > faultedFrames,
    "a healed state version must re-arm the route and publish again",
  );
  assert.ok(!JSON.stringify(conversationFrames(handle, "thread-1").at(-1)).includes(SENTINEL));
  assert.equal(warnLines.length, 1, "healing must not emit another fault diagnostic");
});

test("(vi) forkAssistant and interrupted continue fail closed before any native mutation", async (t) => {
  const fixture = await nativeFixture(t);
  const handle = await fixture.createRuntime();
  t.after(() => handle.close());
  // 命令路径复用同一 ThreadStateStore。先在健康历史上订阅，拿到 CAS 水位：
  // forkAssistant 属 COMMANDS_REQUIRING_BASE_REVISION + ROW_TARGETING_COMMANDS
  // （packages/shared/src/codez-protocol-v4/command.ts:329-352），缺 baseRevision/baseLogEpoch
  // 会在 parseCommandEnvelope 阶段就被拒（commands.ts:68-70），根本走不到 projectThread，
  // 那就测不到「投影先于变更」这条失败闭合。
  await subscribeConversation(handle, "thread-1", "desktop-1");
  const initial = conversationFrames(handle, "thread-1").at(-1);
  const initialPayload = initial?.kind === "complete" ? initial.frame.payload : undefined;
  assert.ok(initialPayload?.kind === "snapshot");
  const snapshot = conversationSnapshotSchema.parse(initialPayload.snapshot);
  // 超限行原地写进共享的 items 数组、不发任何事件：revision/epoch 保持不变，
  // CAS 校验通过后 dispatch 才会在 projectThread 上显式失败。
  persistOversizedRow(fixture);
  assert.equal(fixture.calls.filter((call) => MUTATIONS.includes(call.method)).length, 0);

  const target = { rowId: 3, entityId: "codex:turn:turn-1:item:answer-1" };
  const cases: [string, unknown, Record<string, unknown>][] = [
    [
      "forkAssistant",
      { target },
      { baseRevision: snapshot.revision, baseLogEpoch: snapshot.logEpoch },
    ],
    // sendText 不在 CAS 集合里；interruptedContinueTarget 让它走 executeInterruptedTurnContinue，
    // 该函数同样在任何原生变更之前先 projectThread（commands-continue.ts:103）。
    ["sendText", { text: "continue", interruptedContinueTarget: target }, {}],
  ];
  for (const [index, [type, payload, cas]] of cases.entries()) {
    const response = await handle.runtime.request(V4_METHODS.command, {
      type,
      commandId: `${type}-${index}`,
      clientId: "desktop-1",
      sessionId: "thread-1",
      issuedAt: 1,
      ...cas,
      payload,
    });
    const ack = commandAckSchema.parse(response.result);
    assert.equal(ack.status, "failed", `${type} must fail closed at projection time`);
    assert.equal(ack.reasonCode, "codex.commandFailed", type);
    assert.match(ack.message ?? "", PINNED_MESSAGE, type);
    assert.ok(!(ack.message ?? "").includes(SENTINEL), type);
  }
  assert.equal(
    fixture.calls.filter((call) => MUTATIONS.includes(call.method)).length,
    0,
    "an oversized projection must block the mutation before any native write RPC",
  );
  assert.deepEqual(handle.fatal, []);
});

/** publisher 级夹具：暴露 reads 计数与失败开关，用 reads===1 的口径钉住粘性故障。 */
function publisherFixture(recoverable: boolean) {
  const frames: RoutedTopicWireFrame[] = [];
  const topic = "conversation/thread-1";
  const fault = new RowBudgetExceededError({
    entityId: "codex:turn:turn-1:item:oversized-1",
    kind: "assistantText",
    bytes: rowBudget + 1,
    budget: rowBudget,
  });
  const failure: Error = recoverable ? fault : new Error("resolver offline");
  const state = { seq: 1, epoch: "epoch-1", reads: 0, failing: false };
  const bridge = new BridgeSubscriptions({
    workspaceId: "workspace-1",
    recoverableProjectionFault: isRowBudgetExceeded,
    async snapshot(key: string) {
      state.reads++;
      assert.equal(key, topic);
      if (state.failing) throw failure;
      return {
        snapshot: projectThread(threadFixture(), {
          workspacePath: cwd,
          logEpoch: state.epoch,
          seq: state.seq,
          revision: state.seq,
        }),
        seq: state.seq,
        logEpoch: state.epoch,
      };
    },
    async notify(method, value) {
      assert.equal(method, "v4/conversation/frame");
      frames.push(routedTopicWireFrameSchema.parse(value));
    },
  });
  const version = (): ConversationStateVersion => ({
    epoch: state.epoch,
    revision: state.seq,
    seq: state.seq,
  });
  const subscribe = async () => {
    const response = await bridge.subscribe({
      topic,
      connectionId: "connection-1",
      clientMode: "desktop-continuous",
    });
    await response.afterResponse();
  };
  return { bridge, state, frames, topic, fault, version, subscribe };
}

test("(ii) a recoverable projection fault is sticky per state version and re-arms once", async () => {
  const h = publisherFixture(true);
  await h.subscribe();
  const baselineReads = h.state.reads;
  const baselineFrames = h.frames.length;
  assert.equal(baselineReads, 1);
  assert.ok(baselineFrames > 0);

  // 同一 state 版本：确定性故障只投影一次、只投递一次，之后 changed() 静默短路。
  h.state.seq = 2;
  h.state.failing = true;
  const v2 = h.version();
  await assert.rejects(h.bridge.changed(h.topic, v2), (error: unknown) => error === h.fault);
  const readsAfterFault = h.state.reads;
  assert.equal(readsAfterFault, baselineReads + 1);
  for (let index = 0; index < 8; index++) await h.bridge.changed(h.topic, v2);
  assert.equal(h.state.reads, readsAfterFault, "the same state version must not re-project");
  assert.equal(h.frames.length, baselineFrames, "a faulted version publishes nothing");

  // 版本前进：恰好重新武装一次；仍旧失败也只再投影/投递一次。
  h.state.seq = 3;
  const v3 = h.version();
  await assert.rejects(h.bridge.changed(h.topic, v3), (error: unknown) => error === h.fault);
  assert.equal(h.state.reads, readsAfterFault + 1, "a version advance re-arms exactly once");
  for (let index = 0; index < 4; index++) await h.bridge.changed(h.topic, v3);
  assert.equal(h.state.reads, readsAfterFault + 1);

  // 自愈：超限行消失后同一路由恢复发帧，无需重订阅。
  h.state.seq = 4;
  h.state.failing = false;
  await h.bridge.changed(h.topic, h.version());
  assert.equal(h.state.reads, readsAfterFault + 2);
  assert.ok(h.frames.length > baselineFrames, "the route recovers once the state version heals");

  // 无版本可比（例如 rewind 发布路径）时宁可重投影，也不能把会话永久粘死。
  h.state.seq = 5;
  h.state.failing = true;
  await assert.rejects(h.bridge.changed(h.topic), (error: unknown) => error === h.fault);
  h.state.seq = 6;
  await assert.rejects(h.bridge.changed(h.topic), (error: unknown) => error === h.fault);
  assert.equal(h.state.reads, readsAfterFault + 4);
  h.bridge.close();
});

test("(ii) a non-recoverable resolver failure keeps the existing per-event retry semantics", async () => {
  const h = publisherFixture(false);
  await h.subscribe();
  const baselineReads = h.state.reads;
  h.state.seq = 2;
  h.state.failing = true;
  const version = h.version();
  // 普通故障不粘住：同一版本连续 changed 仍然每次重投影并原样冒泡，保持
  // bridge-runtime.test.ts:1010 钉住的 sessions-index reads 语义与 native-event fatal 判定。
  await assert.rejects(h.bridge.changed(h.topic, version), /resolver offline/);
  await assert.rejects(h.bridge.changed(h.topic, version), /resolver offline/);
  await assert.rejects(h.bridge.changed(h.topic, version), /resolver offline/);
  assert.equal(h.state.reads, baselineReads + 3);
  h.bridge.close();
});
