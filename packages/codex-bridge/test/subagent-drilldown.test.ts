import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import {
  COMMANDS_REQUIRING_BASE_REVISION,
  ROW_TARGETING_COMMANDS,
  commandAckSchema,
  parseCommandEnvelope,
  type CommandEnvelope,
  type CommandType,
  type SubagentRow,
} from "@codez/shared/codez-protocol-v4";
import { BridgeSnapshots } from "../src/bridge-snapshots.js";
import { childThreadListBackoff, listChildThreads } from "../src/child-thread-list.js";
import { CommandRouter, type CommandContext } from "../src/commands.js";
import { CommandLedger } from "../src/command-ledger.js";
import { InteractionBroker } from "../src/interactions.js";
import { handleLegacySession } from "../src/legacy-sessions.js";
import { projectThread } from "../src/projection.js";
import { CodexRpcError } from "../src/rpc-errors.js";
import {
  SubagentActivitySeedScheduler,
  SubagentActivityTracker,
} from "../src/subagent-activity.js";
import { ThreadStateStore } from "../src/thread-state.js";
import type { CodexThread, CodexThreadItem } from "../src/codex-types.js";
import { threadFixture } from "./projection-fixtures.test.js";
import { MockRpc, cwd, deferred, workspaceId } from "./fixtures/commands-fixture.js";

// specs/codex-desktop-subagent-drilldown.md：子代理下钻的事实源只有父线程 collab item
// 与子线程自己的原生元数据；这些测试锁住「不猜状态、不伪造身份、不放权写入」三条边界。

const PARENT = "thread-1";
const CHILD = "thread-2";
const CHILD_B = "thread-3";

function collabSpawn(
  id: string,
  childThreadId: string,
  prompt: string | null,
  extra: Record<string, unknown> = {},
) {
  return {
    type: "collabAgentToolCall",
    id,
    tool: "spawnAgent",
    status: "completed",
    senderThreadId: PARENT,
    receiverThreadIds: [childThreadId],
    prompt,
    model: null,
    reasoningEffort: null,
    agentsStates: {},
    ...extra,
  };
}

function collabWait(id: string, agentsStates: Record<string, { status: string }>) {
  return {
    type: "collabAgentToolCall",
    id,
    tool: "wait",
    status: "completed",
    senderThreadId: PARENT,
    receiverThreadIds: Object.keys(agentsStates),
    prompt: null,
    model: null,
    reasoningEffort: null,
    agentsStates,
  };
}

function activity(id: string, kind: string, childThreadId: string, agentPath = "worker[1]") {
  return {
    type: "subAgentActivity",
    id,
    kind,
    agentThreadId: childThreadId,
    agentPath,
    model: null,
    reasoningEffort: null,
  };
}

function parentThread(items: unknown[]): CodexThread {
  const thread = threadFixture();
  thread.turns[0]!.items.push(...(items as CodexThreadItem[]));
  return thread;
}

function childThread(overrides: Partial<CodexThread> = {}): CodexThread {
  return {
    ...threadFixture(),
    id: CHILD,
    preview: "",
    name: null,
    parentThreadId: PARENT,
    agentNickname: "Parfit",
    agentRole: "explore",
    createdAt: 100,
    updatedAt: 150,
    status: { type: "active", activeFlags: [] },
    turns: [],
    ...overrides,
  } as CodexThread;
}

function subagentRows(thread: CodexThread): SubagentRow[] {
  return projectThread(thread, { workspacePath: cwd }).rows.window.filter(
    (row): row is SubagentRow => row.kind === "subagent",
  );
}

test("spawn_agent 卡片行之后紧跟 subagent 行，childSessionId 即子线程 id", () => {
  const thread = parentThread([
    collabSpawn("collab-1", CHILD, "第一行任务\n第二行细节"),
    activity("act-1", "started", CHILD),
  ]);
  const rows = projectThread(thread, { workspacePath: cwd }).rows.window;
  const toolIndex = rows.findIndex(
    (row) => row.kind === "toolCall" && row.toolName === "spawn_agent",
  );
  const row = rows[toolIndex + 1];
  assert.ok(toolIndex >= 0, "spawn_agent 必须仍投影成 agent 家族工具卡");
  assert.equal(row?.kind, "subagent");
  if (row?.kind !== "subagent") return;
  assert.equal(row.parentToolCallId, "collab-1");
  assert.equal(row.childSessionId, CHILD);
  assert.equal(row.subagentType, "subagent");
  assert.equal(row.status, "running");
  assert.equal(row.summaryText, "第一行任务");
  assert.equal(row.startedAt, 101_000);
  assert.equal(row.entityId, `codex:subagent:${CHILD}`);
  assert.equal(row.turnId, rows[toolIndex]!.turnId);
  // 分隔线 marker 是 additive：下钻不吃掉既有生命周期展示。
  assert.ok(
    rows.some(
      (entry) =>
        entry.kind === "timelineMarker" &&
        entry.marker.type === "codexEvent" &&
        entry.marker.event === "subagentStarted",
    ),
  );
});

test("生命周期优先级：activity 终态权威，agentsStates 补充，notFound 不覆盖已有事实", () => {
  const completed = subagentRows(
    parentThread([
      collabSpawn("c-1", CHILD, "task"),
      activity("a-1", "started", CHILD),
      collabWait("c-2", { [CHILD]: { status: "running" } }),
      activity("a-2", "completed", CHILD),
    ]),
  );
  assert.equal(completed[0]?.status, "success");

  const errored = subagentRows(
    parentThread([
      collabSpawn("c-1", CHILD, "task"),
      collabWait("c-2", { [CHILD]: { status: "errored" } }),
      collabWait("c-3", { [CHILD]: { status: "notFound" } }),
    ]),
  );
  assert.equal(errored[0]?.status, "failed");

  const interrupted = subagentRows(
    parentThread([collabSpawn("c-1", CHILD, "task"), activity("a-1", "interrupted", CHILD)]),
  );
  assert.equal(interrupted[0]?.status, "cancelled");

  const shutdown = subagentRows(
    parentThread([
      collabSpawn("c-1", CHILD, "task"),
      collabWait("c-2", { [CHILD]: { status: "shutdown" } }),
    ]),
  );
  assert.equal(shutdown[0]?.status, "cancelled");
});

test("并发子代理交错事件不串号，且每个 child 只有一行", () => {
  const rows = subagentRows(
    parentThread([
      collabSpawn("c-1", CHILD, "task A"),
      collabSpawn("c-2", CHILD_B, "task B"),
      activity("a-1", "started", CHILD, "worker[1]"),
      activity("a-2", "started", CHILD_B, "worker[2]"),
      activity("a-3", "completed", CHILD_B, "worker[2]"),
    ]),
  );
  assert.equal(rows.length, 2);
  const byChild = new Map(rows.map((row) => [row.childSessionId, row]));
  assert.equal(byChild.get(CHILD)?.status, "running");
  assert.equal(byChild.get(CHILD)?.parentToolCallId, "c-1");
  assert.equal(byChild.get(CHILD)?.summaryText, "task A");
  assert.equal(byChild.get(CHILD_B)?.status, "success");
  assert.equal(byChild.get(CHILD_B)?.parentToolCallId, "c-2");
});

test("只有 activity 的历史仍产出 subagent 行，但不伪造 parentToolCallId", () => {
  const rows = subagentRows(parentThread([activity("a-1", "started", CHILD, "worker[9]")]));
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.parentToolCallId, undefined);
  assert.equal(rows[0]?.childSessionId, CHILD);
  assert.equal(rows[0]?.summaryText, "worker[9]");
});

interface SetupOptions {
  childResume?: "attach" | "refuse";
  children?: CodexThread[];
  parentItems?: unknown[];
}

async function setup(t: TestContext, options: SetupOptions = {}) {
  const root = await mkdtemp(join(tmpdir(), "codez-subagent-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const rpc = new MockRpc();
  const parent = parentThread(
    options.parentItems ?? [collabSpawn("c-1", CHILD, "task A"), activity("a-1", "started", CHILD)],
  );
  const threads = new Map<string, CodexThread>([
    [PARENT, parent],
    [CHILD, childThread()],
    ...new Map((options.children ?? []).map((child) => [child.id, child])),
  ]);
  rpc.handlers.set("thread/read", (p) => ({ thread: threads.get(String(p.threadId)) }));
  rpc.handlers.set("thread/resume", (p) => {
    const id = String(p.threadId);
    if (id !== PARENT && options.childResume === "refuse")
      throw new CodexRpcError(
        -32602,
        "cannot resume an unloaded multi-agent v2 sub-agent through its parent; resume the parent first, or use thread/read to inspect it",
      );
    return { thread: threads.get(id) };
  });
  rpc.handlers.set("thread/turns/list", (p) => ({
    data: threads.get(String(p.threadId))?.turns ?? [],
    nextCursor: null,
  }));
  rpc.handlers.set("thread/queue/list", () => ({ data: [], nextCursor: null }));
  rpc.handlers.set("thread/list", (p) => ({
    data: (options.children ?? [childThread()]).filter(
      (child) => child.parentThreadId === String(p.parentThreadId ?? ""),
    ),
    nextCursor: null,
  }));
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
    target: string | null = PARENT,
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
    snapshots,
    command,
    execute,
    threads,
    updateParent: (items: unknown[]) => {
      const next = parentThread(items);
      threads.set(PARENT, next);
      store.put(next);
    },
  };
}

test("snapshot.subagents 派生自 subagent 行，revision 只在语义变化时递增", async (t) => {
  const h = await setup(t);
  const first = await h.snapshots.conversation(PARENT);
  assert.deepEqual(first.subagents?.childSessionIds, [CHILD]);
  assert.equal(first.subagents?.running.length, 1);
  assert.equal(first.subagents?.running[0]?.status, "running");
  assert.equal(first.subagents?.running[0]?.toolCallId, "c-1");
  assert.equal(first.subagents?.endedTotal, 0);
  assert.equal(first.subagents?.revision, 1);
  const again = await h.snapshots.conversation(PARENT);
  assert.equal(again.subagents?.revision, 1, "语义未变不得递增（renderer CAS）");
  h.updateParent([
    collabSpawn("c-1", CHILD, "task A"),
    activity("a-1", "started", CHILD),
    activity("a-2", "completed", CHILD),
  ]);
  const third = await h.snapshots.conversation(PARENT);
  assert.equal(third.subagents?.revision, 2);
  assert.equal(third.subagents?.running.length, 0);
  assert.equal(third.subagents?.endedTotal, 1);
});

test("没有子代理时 subagents 为空目录且 revision 为 0", async (t) => {
  const h = await setup(t, { parentItems: [] });
  const snapshot = await h.snapshots.conversation(PARENT);
  assert.deepEqual(snapshot.subagents?.childSessionIds, []);
  assert.equal(snapshot.subagents?.revision, 0);
});

test("bridge 已持有子线程且原生非 active 时不再报运行中", async (t) => {
  const h = await setup(t, { children: [childThread({ status: { type: "idle" } })] });
  h.threads.set(CHILD, childThread({ status: { type: "idle" } }));
  await h.store.ensure(CHILD);
  const snapshot = await h.snapshots.conversation(PARENT);
  assert.equal(snapshot.subagents?.running.length, 0);
  assert.equal(snapshot.subagents?.endedTotal, 1);
});

test("未加载子线程的 turn/completed 事件即收敛 running，不等父侧终态事实", async (t) => {
  // 修复原因：v1 只在 wait/send_input 碰巧观测到终态时才写 agentsStates，v2 只在
  // Completed 时写 subAgentActivity；多数真实会话里子代理结束后父线程没有任何终态
  // 事实，状态面板会一直计时。子线程创建时原生已为连接挂好 listener，turn 事件可直接
  // 作为活性事实。父会话必须先构建一次快照（登记父子关系），事件才能触发父侧重投影。
  const h = await setup(t);
  const parentTouches: string[] = [];
  h.store.onChange((id) => parentTouches.push(id));
  const first = await h.snapshots.conversation(PARENT);
  assert.equal(first.subagents?.running.length, 1);
  // 一次性种子自身也会 touch 父会话；先等它落定再清零，断言才只测量事件路径。
  await h.snapshots.whenSubagentActivitySeedsSettled();
  parentTouches.length = 0;
  await h.store.apply({
    method: "turn/completed",
    params: {
      threadId: CHILD,
      turn: { id: "child-turn-1", status: "completed", items: [], itemsView: "summary" },
    },
  });
  assert.ok(parentTouches.includes(PARENT), "子线程终态事件必须触发父会话重投影");
  const next = await h.snapshots.conversation(PARENT);
  assert.equal(next.subagents?.running.length, 0);
  assert.equal(next.subagents?.endedTotal, 1);
});

test("子线程被重新驱动（turn/started）时 running 随之恢复", async (t) => {
  const h = await setup(t);
  await h.snapshots.conversation(PARENT);
  await h.store.apply({
    method: "turn/completed",
    params: {
      threadId: CHILD,
      turn: { id: "child-turn-1", status: "completed", items: [], itemsView: "summary" },
    },
  });
  const ended = await h.snapshots.conversation(PARENT);
  assert.equal(ended.subagents?.running.length, 0);
  // 与原生 resume 同一语义：子代理再次开跑即重新计时。
  await h.store.apply({
    method: "turn/started",
    params: {
      threadId: CHILD,
      turn: { id: "child-turn-2", status: "inProgress", items: [], itemsView: "full" },
    },
  });
  const resumed = await h.snapshots.conversation(PARENT);
  assert.equal(resumed.subagents?.running.length, 1);
  assert.equal(resumed.subagents?.endedTotal, 0);
});

test("已加载子线程的 thread/status/changed 也会立刻收敛父侧 running", async (t) => {
  const h = await setup(t);
  await h.store.ensure(CHILD);
  const first = await h.snapshots.conversation(PARENT);
  assert.equal(first.subagents?.running.length, 1);
  await h.store.apply({
    method: "thread/status/changed",
    params: { threadId: CHILD, status: { type: "idle" } },
  });
  const next = await h.snapshots.conversation(PARENT);
  assert.equal(next.subagents?.running.length, 0);
});

test("无观测的旧会话子线程用一次性 thread/list 种子判定活性", async (t) => {
  // 结束态：idle 且最后一个 turn 已 completed → 不再报运行中。
  const endedChild = childThread({
    status: { type: "idle" },
    turns: [
      {
        id: "child-turn-1",
        status: "completed",
        itemsView: "summary",
        items: [],
        startedAt: 110,
        completedAt: 140,
        error: null,
      },
    ],
  } as Partial<CodexThread>);
  const h = await setup(t, { children: [endedChild] });
  const first = await h.snapshots.conversation(PARENT);
  assert.equal(first.subagents?.running.length, 1, "种子返回前保持父侧事实");
  await h.snapshots.whenSubagentActivitySeedsSettled();
  const next = await h.snapshots.conversation(PARENT);
  assert.equal(next.subagents?.running.length, 0);
  assert.equal(next.subagents?.endedTotal, 1);
});

test("种子不判死还在排队的子代理（idle 且没有任何 turn）", async (t) => {
  const pending = childThread({ status: { type: "idle" }, turns: [] } as Partial<CodexThread>);
  const h = await setup(t, { children: [pending] });
  await h.snapshots.conversation(PARENT);
  await h.snapshots.whenSubagentActivitySeedsSettled();
  const next = await h.snapshots.conversation(PARENT);
  assert.equal(next.subagents?.running.length, 1, "pending 子代理仍在等待首次驱动");
});

test("子线程被删除（thread/deleted）立即收敛 running，不清掉观测让父侧事实复活", async (t) => {
  // 修复原因：已删除的子线程不可能仍在运行；若删除时清掉活性观测，未加载子线程会
  // 退回「无观测保持父侧事实」，running 永远滞留，状态面板继续计时。
  const h = await setup(t);
  const first = await h.snapshots.conversation(PARENT);
  assert.equal(first.subagents?.running.length, 1);
  await h.snapshots.whenSubagentActivitySeedsSettled();
  await h.store.apply({ method: "thread/deleted", params: { threadId: CHILD } });
  const next = await h.snapshots.conversation(PARENT);
  assert.equal(next.subagents?.running.length, 0);
  assert.equal(next.subagents?.endedTotal, 1);
});

test("子代理线程即使 attach 成功也保持只读，且不读队列", async (t) => {
  const h = await setup(t, { childResume: "attach" });
  const state = await h.store.ensure(CHILD);
  assert.equal(state.readOnly, "subagent-child");
  assert.equal(state.attached, true);
  assert.deepEqual(state.queue, []);
  assert.ok(!h.rpc.methods().includes("thread/queue/list"));
});

test("父线程未加载导致原生拒绝 resume 时，下钻降级为只读快照而不是失败", async (t) => {
  const h = await setup(t, { childResume: "refuse" });
  const state = await h.store.ensure(CHILD);
  assert.equal(state.readOnly, "subagent-child");
  assert.equal(state.attached, false);
  const snapshot = await h.snapshots.conversation(CHILD);
  assert.equal(snapshot.writerConflict, undefined, "子代理只读不得复用写锁冲突文案");
  assert.deepEqual(snapshot.availability.switchModelConfig, {
    allowed: false,
    reasonCode: "guard.subagentReadOnly",
  });
});

test("原生未加载（notLoaded）的已结束子线程跳过 resume，只做免锁只读投影", async (t) => {
  // 原因：resume 未加载线程会让原生把子线程 rollout 从磁盘重新加载并改写文件，
  // thread.updatedAt 被顶到打开时刻，session/subagents 的 endedAt 与排序随之失真
  // （实测 codex-cli 0.160.1：read/turns/list 不改盘，首次 resume 改盘，二次 resume 不改盘）。
  const ended = childThread({ status: { type: "notLoaded" } } as Partial<CodexThread>);
  const h = await setup(t, { children: [ended] });
  const state = await h.store.ensure(CHILD);
  assert.equal(state.readOnly, "subagent-child");
  assert.equal(state.attached, false);
  assert.ok(!h.rpc.methods().includes("thread/resume"), "notLoaded 子线程不得触发 resume");
  assert.ok(h.rpc.methods().includes("thread/turns/list"), "历史仍走免锁只读读取");
  assert.ok(!h.rpc.methods().includes("thread/queue/list"), "只读加载不读队列");
  const snapshot = await h.snapshots.conversation(CHILD);
  assert.equal(snapshot.writerConflict, undefined, "子代理只读不得复用写锁冲突文案");
  assert.deepEqual(snapshot.availability.sendQueuedNow, {
    allowed: false,
    reasonCode: "guard.subagentReadOnly",
  });
  // 未 attach 的条目必须可被 invalidate 重载：父线程之后驱动它时才能重新判定并订阅。
  h.store.invalidate(CHILD);
  assert.equal(h.store.get(CHILD), undefined);
});

test("原生已加载（idle）的子线程仍走 resume 订阅，且保持只读", async (t) => {
  const loaded = childThread({ status: { type: "idle" } } as Partial<CodexThread>);
  const h = await setup(t, { children: [loaded] });
  const state = await h.store.ensure(CHILD);
  assert.equal(state.readOnly, "subagent-child");
  assert.equal(state.attached, true);
  assert.ok(h.rpc.methods().includes("thread/resume"), "已加载线程的 resume 只是订阅，不改盘");
  // 已 attach 的条目保持缓存，否则每次 resync 都要重放整段子线程历史。
  h.store.invalidate(CHILD);
  assert.notEqual(h.store.get(CHILD), undefined);
});

test("子线程 cwd 与 Host 不同时按父归属放行；父不属于本工作区则拒绝", async (t) => {
  const worktreeChild = childThread({ cwd: "/workspace/worktree" } as Partial<CodexThread>);
  const owned = await setup(t, { children: [worktreeChild] });
  owned.threads.set(CHILD, worktreeChild);
  const state = await owned.store.ensure(CHILD);
  assert.equal(state.readOnly, "subagent-child");

  const foreign = await setup(t, { children: [worktreeChild] });
  foreign.threads.set(CHILD, worktreeChild);
  foreign.threads.set(PARENT, { ...parentThread([]), cwd: "/elsewhere" } as CodexThread);
  await assert.rejects(foreign.store.ensure(CHILD), /different workspace/);
});

test("非子线程的普通 resume 失败仍整体拒绝（不放宽既有边界）", async (t) => {
  const rpc = new MockRpc();
  rpc.handlers.set("thread/read", () => ({ thread: threadFixture() }));
  rpc.handlers.set("thread/resume", () => {
    throw new CodexRpcError(-32602, "some other invalid request");
  });
  const store = new ThreadStateStore(rpc, cwd);
  await assert.rejects(store.ensure(PARENT));
  assert.equal(store.get(PARENT), undefined);
});

test("子代理会话上的写命令被拒，reasonCode 与原生 flavor 同词", async (t) => {
  const h = await setup(t, { childResume: "attach" });
  await h.store.ensure(CHILD);
  const ack = await h.execute(h.command("sendText", { text: "hi" }, "cmd-child-1", CHILD));
  assert.equal(ack.status, "rejected");
  assert.equal(ack.reasonCode, "guard.subagentReadOnly");
});

test("session/subagents 用原生线程状态分类，ended 缺失终态事实时标 lost", async (t) => {
  const ended = childThread({
    id: CHILD_B,
    status: { type: "idle" },
    updatedAt: 200,
    agentNickname: "Huygens",
    agentRole: "critic",
  });
  const h = await setup(t, { children: [childThread(), ended] });
  const result = (await handleLegacySession(
    "session/subagents",
    { sessionId: PARENT, endedLimit: 20 },
    h.rpc,
    h.store,
    workspaceId,
  )) as {
    childSessionIds: string[];
    running: { childSessionId: string; subagentType: string; title: string }[];
    ended: { total: number; items: { childSessionId: string; status: string; title: string }[] };
  };
  assert.deepEqual(result.childSessionIds.sort(), [CHILD, CHILD_B].sort());
  assert.equal(result.running.length, 1);
  assert.equal(result.running[0]?.childSessionId, CHILD);
  // 原生 metadata 才是子代理真实身份，父侧只有 agentPath。
  assert.equal(result.running[0]?.subagentType, "explore");
  assert.equal(result.running[0]?.title, "Parfit");
  assert.equal(result.ended.total, 1);
  assert.equal(result.ended.items[0]?.childSessionId, CHILD_B);
  assert.equal(result.ended.items[0]?.status, "lost");
  assert.equal(result.ended.items[0]?.title, "Huygens");
  const listParams = h.rpc.params("thread/list")[0] as Record<string, unknown>;
  assert.equal(listParams.parentThreadId, PARENT);
  assert.deepEqual(listParams.sourceKinds, [
    "subAgent",
    "subAgentReview",
    "subAgentCompact",
    "subAgentThreadSpawn",
    "subAgentOther",
  ]);
  assert.equal(listParams.cwd, undefined, "带 cwd 会把 worktree 子代理排除掉");
});

test("session/subagents 按 offset 分页并给出精确 total 与不透明 cursor", async (t) => {
  const children = [CHILD_B, "thread-4", "thread-5"].map((id, index) =>
    childThread({ id, status: { type: "idle" }, updatedAt: 200 + index }),
  );
  const h = await setup(t, { children });
  const first = (await handleLegacySession(
    "session/subagents",
    { sessionId: PARENT, endedLimit: 2 },
    h.rpc,
    h.store,
    workspaceId,
  )) as { ended: { total: number; nextCursor?: string; items: unknown[] } };
  assert.equal(first.ended.total, 3);
  assert.equal(first.ended.items.length, 2);
  assert.ok(first.ended.nextCursor);
  const second = (await handleLegacySession(
    "session/subagents",
    { sessionId: PARENT, endedLimit: 2, endedCursor: first.ended.nextCursor },
    h.rpc,
    h.store,
    workspaceId,
  )) as { ended: { total: number; nextCursor?: string; items: unknown[] } };
  assert.equal(second.ended.items.length, 1);
  assert.equal(second.ended.nextCursor, undefined);
  await assert.rejects(
    handleLegacySession(
      "session/subagents",
      { sessionId: PARENT, endedCursor: "bogus" },
      h.rpc,
      h.store,
      workspaceId,
    ),
    /Invalid endedCursor/,
  );
});

test("session/subagents 拒绝跨工作区的父会话", async (t) => {
  const h = await setup(t);
  h.threads.set(PARENT, { ...parentThread([]), cwd: "/elsewhere" } as CodexThread);
  await assert.rejects(
    handleLegacySession("session/subagents", { sessionId: PARENT }, h.rpc, h.store, workspaceId),
    /Workspace mismatch/,
  );
});

/** 目录结果的最小可读视图：缓存测试只关心分类与分页事实。 */
interface CatalogView {
  revision: number;
  childSessionIds: string[];
  running: { childSessionId: string; title: string }[];
  ended: {
    total: number;
    nextCursor?: string;
    items: { childSessionId: string; status: string; title: string }[];
  };
}

test("session/subagents 在同一父水位下复用已聚合目录，revision 变化后重新分类", async (t) => {
  const h = await setup(t, {
    children: [childThread({ id: CHILD_B, status: { type: "idle" }, updatedAt: 200 })],
    parentItems: [collabSpawn("c-1", CHILD_B, "task B")],
  });
  // 缓存只在父线程已加载（有 epoch/revision 水位）时生效；这也是生产里的常态路径。
  await h.store.ensure(PARENT);
  const catalog = () =>
    handleLegacySession(
      "session/subagents",
      { sessionId: PARENT },
      h.rpc,
      h.store,
      workspaceId,
    ) as Promise<CatalogView>;
  const first = await catalog();
  assert.equal(first.ended.total, 1);
  assert.equal(first.ended.items[0]?.status, "lost", "父线程没有终态事实时不猜成败");
  // 命中证据：原地给父线程补终态事实但不 touch（revision 不变）→ 目录仍复用缓存。
  // 生产里任何原生事件都经 ThreadStateStore.touch → revision+1，所以水位就是失效权威。
  const state = h.store.get(PARENT)!;
  // ThreadProjectionState.thread 是未校验的原生载荷（JsonObject），测试按形状取用。
  const parentTurns = state.thread.turns as { items: unknown[] }[];
  parentTurns[0]!.items.push(activity("a-2", "completed", CHILD_B));
  const cached = await catalog();
  assert.equal(cached.ended.items[0]?.status, "lost", "同一 (epoch, revision) 必须命中缓存");
  h.store.touch(PARENT);
  const fresh = await catalog();
  assert.ok(fresh.revision > cached.revision, "touch 必须推进父水位");
  assert.equal(fresh.ended.items[0]?.status, "success", "水位变化后必须重解析父历史");
});

test("session/subagents 分页复用已排序目录，子线程状态变化立即重分类", async (t) => {
  const children = [CHILD_B, "thread-4"].map((id, index) =>
    childThread({ id, status: { type: "idle" }, updatedAt: 200 + index }),
  );
  const h = await setup(t, { children, parentItems: [collabSpawn("c-1", CHILD_B, "task B")] });
  await h.store.ensure(PARENT);
  const catalog = (params: Record<string, unknown> = {}) =>
    handleLegacySession(
      "session/subagents",
      { sessionId: PARENT, ...params },
      h.rpc,
      h.store,
      workspaceId,
    ) as Promise<CatalogView>;
  const first = await catalog({ endedLimit: 1 });
  assert.equal(first.ended.total, 2);
  assert.deepEqual(
    first.ended.items.map((item) => item.childSessionId),
    ["thread-4"],
    "endedAt 最新的排在前面",
  );
  assert.ok(first.ended.nextCursor);
  // 分页切片复用同一份已排序列表：第二页不重跑父历史解析与排序。
  const second = await catalog({ endedLimit: 1, endedCursor: first.ended.nextCursor });
  assert.deepEqual(
    second.ended.items.map((item) => item.childSessionId),
    [CHILD_B],
  );
  assert.equal(second.ended.nextCursor, undefined);
  // 子线程原生状态变了（父水位没变）：签名不同 → 立刻重分类，缓存不得掩盖子线程事实。
  children[1]!.status = { type: "active", activeFlags: [] };
  const third = await catalog({ endedLimit: 1 });
  assert.deepEqual(third.childSessionIds.slice().sort(), [CHILD_B, "thread-4"].sort());
  assert.deepEqual(
    third.running.map((item) => item.childSessionId),
    ["thread-4"],
  );
  assert.equal(third.ended.total, 1);
});

test("同一父线程的并发 listChildThreads 合并在途请求，settled 后不保留过期列表", async () => {
  const rpc = new MockRpc();
  const gate = deferred<{ data: unknown[]; nextCursor: null }>();
  rpc.handlers.set("thread/list", () => gate.promise);
  const first = listChildThreads(rpc, PARENT);
  const second = listChildThreads(rpc, PARENT);
  assert.equal(rpc.params("thread/list").length, 1, "在途请求必须合并成一轮分页扫描");
  gate.resolve({ data: [childThread()], nextCursor: null });
  assert.deepEqual(
    (await first).map((child) => child.id),
    [CHILD],
  );
  assert.deepEqual(
    (await second).map((child) => child.id),
    [CHILD],
  );
  rpc.handlers.set("thread/list", () => ({ data: [], nextCursor: null }));
  assert.deepEqual(await listChildThreads(rpc, PARENT), []);
  assert.equal(rpc.params("thread/list").length, 2, "settled 后必须清除在途记账");
});

test("thread/list 失败后有界退避：冷却中不重发，冷却过期恢复，成功即清零", async () => {
  const rpc = new MockRpc();
  let healthy = false;
  rpc.handlers.set("thread/list", () => {
    if (!healthy) throw new CodexRpcError(-32603, "native list unavailable");
    return { data: [], nextCursor: null };
  });
  const list = (now: number) => listChildThreads(rpc, PARENT, { now });
  const listCalls = () => rpc.params("thread/list").length;
  await assert.rejects(list(1_000), /native list unavailable/);
  assert.equal(listCalls(), 1);
  // 冷却窗口（首次 500ms）内不再敲原生，直接复述上次失败：调用方仍看到错误。
  await assert.rejects(list(1_499), /native list unavailable/);
  assert.equal(listCalls(), 1, "冷却中不得重发 thread/list");
  // 冷却过期恢复重试；连续失败按 500ms 指数退避。
  await assert.rejects(list(1_500), /native list unavailable/);
  assert.equal(listCalls(), 2);
  assert.equal(childThreadListBackoff(rpc, PARENT, 1_500)?.retryAfterMs, 1_000);
  await assert.rejects(list(2_499), /native list unavailable/);
  assert.equal(listCalls(), 2, "第二次失败退避到 1000ms");
  await assert.rejects(list(2_500), /native list unavailable/);
  assert.equal(listCalls(), 3);
  // 一次成功立即清零失败计数：退避不会掩盖恢复。
  healthy = true;
  assert.deepEqual(await list(60_000), []);
  assert.equal(childThreadListBackoff(rpc, PARENT, 60_000), undefined);
  healthy = false;
  await assert.rejects(list(60_001), /native list unavailable/);
  assert.equal(childThreadListBackoff(rpc, PARENT, 60_001)?.retryAfterMs, 500, "成功后退回基线");
});

test("thread/list 退避有上限（30s），连续失败不会无限增长", async () => {
  const rpc = new MockRpc();
  rpc.handlers.set("thread/list", () => {
    throw new CodexRpcError(-32603, "native list unavailable");
  });
  let now = 0;
  let retryAt = 0;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    await assert.rejects(listChildThreads(rpc, PARENT, { now }), /native list unavailable/);
    const backoff = childThreadListBackoff(rpc, PARENT, now);
    assert.ok(backoff, "每次失败都必须记账退避");
    retryAt = backoff.retryAt;
    now = retryAt;
  }
  assert.equal(childThreadListBackoff(rpc, PARENT, retryAt - 1)?.retryAfterMs, 30_000);
  assert.equal(childThreadListBackoff(rpc, PARENT, retryAt - 1)?.failures, 8);
});

test("冷却窗口内种子调度跳过重试，冷却过期后恢复（失败种子不写活性观测）", async () => {
  const rpc = new MockRpc();
  rpc.handlers.set("thread/list", () => {
    throw new CodexRpcError(-32603, "native list unavailable");
  });
  const tracker = new SubagentActivityTracker();
  const touched: string[] = [];
  const scheduler = new SubagentActivitySeedScheduler({
    rpc,
    nativeThreadStatus: () => undefined,
    tracker,
    touchParent: (parentId) => touched.push(parentId),
  });
  const listCalls = () => rpc.params("thread/list").length;
  // 用真实时间记一次失败：500ms 冷却窗口覆盖紧随其后的 schedule（父快照每次构建都会调度）。
  await assert.rejects(
    listChildThreads(rpc, PARENT, { now: Date.now() }),
    /native list unavailable/,
  );
  const primed = listCalls();
  scheduler.schedule(PARENT, [{ childSessionId: CHILD }]);
  await scheduler.whenSettled();
  assert.equal(listCalls(), primed, "冷却窗口内不得重发种子查询");
  assert.equal(tracker.observedActive(CHILD), undefined, "失败种子不得写活性观测");
  assert.deepEqual(touched, [], "失败种子不得触发父会话重投影");
  // 换一个父线程把失败时间戳记在过去（等价于冷却已过期）：schedule 必须恢复重试。
  const expiredParent = "thread-parent-expired";
  await assert.rejects(
    listChildThreads(rpc, expiredParent, { now: Date.now() - 60_000 }),
    /native list unavailable/,
  );
  const beforeRetry = listCalls();
  scheduler.schedule(expiredParent, [{ childSessionId: CHILD_B }]);
  await scheduler.whenSettled();
  assert.equal(listCalls(), beforeRetry + 1, "冷却过期后必须恢复重试");
});
