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
import { CommandRouter, type CommandContext } from "../src/commands.js";
import { CommandLedger } from "../src/command-ledger.js";
import { InteractionBroker } from "../src/interactions.js";
import { handleLegacySession } from "../src/legacy-sessions.js";
import { projectThread } from "../src/projection.js";
import { CodexRpcError } from "../src/rpc-errors.js";
import { ThreadStateStore } from "../src/thread-state.js";
import type { CodexThread, CodexThreadItem } from "../src/codex-types.js";
import { threadFixture } from "./projection-fixtures.test.js";
import { MockRpc, cwd, workspaceId } from "./fixtures/commands-fixture.js";

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
