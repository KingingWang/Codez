import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { test } from "node:test";
import {
  conversationRowSchema,
  conversationSnapshotSchema,
  sessionSummarySchema,
  sessionsIndexSnapshotSchema,
  type ConversationSnapshot,
  type PendingInteraction,
} from "@codez/shared/codez-protocol-v4";
import {
  parseCodexThreadIncremental,
  projectThread,
  projectSessionSummary,
  projectSessionsIndex,
} from "../src/projection.js";
import type { CodexThread, CodexTurn } from "../src/codex-types.js";
import { threadFixture } from "./projection-fixtures.test.js";

const options = { workspacePath: "/workspace", logEpoch: "connection-1", seq: 12, revision: 4 };

test("conversation is schema-valid, deterministic, pure and preserves caller watermarks", () => {
  const thread = threadFixture();
  const before = structuredClone(thread);
  const result = projectThread(thread, options);
  assert.deepEqual(conversationSnapshotSchema.parse(result), result);
  assert.deepEqual(projectThread(thread, options), result);
  assert.deepEqual(thread, before);
  assert.deepEqual([result.seq, result.revision, result.logEpoch], [12, 4, "connection-1"]);
  assert.deepEqual(
    result.rows.window.map((row) => row.rowId),
    [0, 1, 2, 3],
  );
  for (const row of result.rows.window) assert.deepEqual(conversationRowSchema.parse(row), row);
  assert.equal(result.rows.firstRowId, 0);
  assert.equal(result.rows.totalCount, 4);
  const user = result.rows.window[1];
  assert.equal(user?.entityId, "codex:turn:turn-1:item:user-1");
  assert.equal(user?.kind === "userInput" && user.sourceCommandId, "command-1");
  assert.equal(user?.kind === "userInput" && user.clientId, undefined);
  assert.equal(result.rows.window[0]?.createdAt, 101000);
  assert.equal(
    result.rows.window[0]?.kind === "turnHeader" && result.rows.window[0].activeMs,
    undefined,
  );
  assert.equal(
    result.rows.window[3]?.kind === "assistantText" && result.rows.window[3].model,
    undefined,
  );
  assert.equal(result.control.phase, "completedSuccess");
});

test("appending content/items preserves existing identities and ordinals", () => {
  const thread = threadFixture();
  const initial = projectThread(thread, options);
  thread.turns[0]!.items.push({ type: "agentMessage", id: "answer-2", text: "More" });
  const next = projectThread(thread, { ...options, seq: 13 });
  assert.deepEqual(next.rows.window.slice(0, 4), initial.rows.window);
  assert.equal(next.rows.window[4]?.rowId, 4);
});

test("statuses are mapped from authority, including unloaded active and system errors", () => {
  for (const [status, phase, state] of [
    ["inProgress", "running", "running"],
    ["completed", "completedSuccess", "completedSuccess"],
    ["interrupted", "completedInterrupted", "completedInterrupted"],
    ["failed", "error", "failed"],
  ] as const) {
    const thread = threadFixture();
    thread.turns[0]!.status = status;
    thread.status =
      status === "inProgress" ? { type: "active", activeFlags: [] } : { type: "idle" };
    if (status === "failed") thread.turns[0]!.error = { message: "Provider unavailable" };
    const snapshot = projectThread(thread, options);
    assert.equal(snapshot.control.phase, phase);
    assert.equal(
      snapshot.rows.window[0]?.kind === "turnHeader" && snapshot.rows.window[0].state,
      state,
    );
    assert.equal(snapshot.control.canStop, status === "inProgress");
  }
  const thread = threadFixture();
  thread.turns = [];
  thread.status = { type: "active", activeFlags: ["waitingOnApproval"] };
  assert.equal(projectSessionSummary(thread, "/workspace").phase, "running");
  assert.equal(projectThread(thread, options).control.canStop, false);
  thread.status = { type: "systemError" };
  assert.equal(projectThread(thread, options).control.phase, "error");
});

test("summary/index use milliseconds, bounded previews and independent workspace epoch", () => {
  const thread = threadFixture();
  thread.name = "Named";
  thread.forkedFromId = "parent";
  thread.turns[0]!.items.push({ type: "agentMessage", id: "long", text: "a".repeat(140) });
  const summary = projectSessionSummary(thread, "/workspace");
  assert.deepEqual(sessionSummarySchema.parse(summary), summary);
  assert.equal(summary.createdAt, 100000);
  assert.equal(summary.lastActivityAt, 120000);
  assert.equal(summary.lastAssistantPreview?.length, 120);
  assert.equal(summary.parentSessionId, "parent");
  assert.equal(summary.titleSource, undefined); // Codex name does not record title provenance.
  const index = projectSessionsIndex([thread], {
    workspacePath: "/workspace",
    workspaceIdentity: " remote-identity ",
    logEpoch: "host-index-epoch",
  });
  assert.deepEqual(sessionsIndexSnapshotSchema.parse(index), index);
  assert.equal(index.workspaceId, "remote-identity");
  assert.equal(index.sessions[0]?.workspaceId, "remote-identity");
  assert.equal(index.logEpoch, "host-index-epoch");
});

test("injected environment preview is not projected as a session title", () => {
  const thread = threadFixture();
  thread.name = null;
  thread.preview = "<environment_context> <cwd>/workspace</cwd> <shell>bash</shell>";
  assert.equal(projectSessionSummary(thread, "/workspace").title, "");
  assert.equal(projectThread(thread, options).meta.title, "");
  // 原生会话的 AGENTS.md 注入块同样不是用户标题（无 `## My request for Codex:` 分隔符）。
  thread.preview =
    "# AGENTS.md instructions for /workspace\n\n<INSTRUCTIONS>\n规则\n</INSTRUCTIONS>";
  assert.equal(projectSessionSummary(thread, "/workspace").title, "");
  assert.equal(projectThread(thread, options).meta.title, "");
  thread.name = "用户明确设置的标题";
  assert.equal(projectSessionSummary(thread, "/workspace").title, "用户明确设置的标题");
});

test("native origin is only an initial Host membership hint, not a thread project rewrite", () => {
  const thread = { ...threadFixture(), threadSource: "codez_project:project-ab" };
  assert.equal(projectSessionSummary(thread, "/workspace").originProjectId, "project-ab");
  assert.equal(
    projectSessionSummary({ ...thread, threadSource: "codez_unclassified" }, "/workspace")
      .originProjectId,
    null,
  );
  assert.equal(
    projectSessionSummary({ ...thread, threadSource: "codex_desktop_project" }, "/workspace")
      .originProjectId,
    undefined,
  );
});

test("malformed/partial histories and duplicate IDs fail before projecting misleading rows", () => {
  const thread = threadFixture();
  thread.turns[0]!.itemsView = "summary";
  assert.throws(() => projectThread(thread, options), /full/i);
  assert.doesNotThrow(() => projectSessionSummary(thread, "/workspace"));
  thread.turns[0]!.itemsView = "full";
  thread.turns[0]!.items.push(thread.turns[0]!.items[0]!);
  assert.throws(() => projectThread(thread, options), /duplicate/i);
  assert.throws(() => projectThread({ ...thread, createdAt: -1 }, options));
  assert.throws(
    () => projectThread(threadFixture(), { workspacePath: "/workspace", seq: 1 }),
    /epoch/i,
  );
});

test("follow-up turns may reuse native item IDs without colliding presentation identities", () => {
  const thread = threadFixture();
  const first = thread.turns[0]!;
  const second = {
    ...first,
    id: "turn-2",
    startedAt: 121,
    completedAt: 122,
    items: [
      {
        type: "userMessage" as const,
        id: "user-1",
        clientId: "command-2",
        content: [{ type: "text" as const, text: "Follow-up", text_elements: [] }],
      },
      { type: "agentMessage" as const, id: "answer-1", text: "Follow-up response" },
    ],
  };
  thread.turns.push(second);
  const snapshot = projectThread(thread, options);
  const identities = snapshot.rows.window.map((row) => row.entityId);
  assert.deepEqual(identities, [
    "codex:turn:turn-1",
    "codex:turn:turn-1:item:user-1",
    "codex:turn:turn-1:item:reason-1",
    "codex:turn:turn-1:item:answer-1",
    "codex:turn:turn-2",
    "codex:turn:turn-2:item:user-1",
    "codex:turn:turn-2:item:answer-1",
  ]);
  assert.equal(new Set(identities).size, identities.length);
  assert.equal(snapshot.rows.window[1]?.turnId, "turn-1");
  assert.equal(snapshot.rows.window[5]?.turnId, "turn-2");
});

test("turn header entity IDs encode delimiter-shaped native turn IDs", () => {
  const thread = threadFixture();
  thread.turns = [
    {
      ...thread.turns[0]!,
      id: "t:item:i",
      items: [
        {
          type: "userMessage" as const,
          id: "header-user",
          content: [{ type: "text" as const, text: "Special turn", text_elements: [] }],
        },
      ],
    },
    {
      ...thread.turns[0]!,
      id: "t",
      items: [
        { type: "agentMessage" as const, id: "i", text: "Collides with an unencoded header" },
      ],
    },
  ];
  const identities = projectThread(thread, options).rows.window.map((row) => row.entityId);
  assert.deepEqual(identities, [
    "codex:turn:t%3Aitem%3Ai",
    "codex:turn:t%3Aitem%3Ai:item:header-user",
    "codex:turn:t",
    "codex:turn:t:item:i",
  ]);
  assert.equal(new Set(identities).size, identities.length);
});

test("duplicate thread records validate first and index only the newest first-encounter entry", () => {
  const older = threadFixture();
  const newer = {
    ...threadFixture(),
    preview: "Newer rollout",
    updatedAt: 130,
    turns: [],
  };
  const other = { ...threadFixture(), id: "thread-2", updatedAt: 125 };
  const index = projectSessionsIndex([older, other, newer], {
    workspacePath: "/workspace",
    logEpoch: "host-index-epoch",
  });
  assert.deepEqual(
    index.sessions.map((session) => [session.sessionId, session.title, session.lastActivityAt]),
    [
      ["thread-1", "Newer rollout", 130000],
      ["thread-2", "Hello", 125000],
    ],
  );

  const stale = { ...newer, updatedAt: 90 };
  const tieFirst = projectSessionsIndex(
    [newer, stale, { ...newer, updatedAt: 130, preview: "Late tie" }],
    { workspacePath: "/workspace", logEpoch: "host-index-epoch" },
  );
  assert.equal(tieFirst.sessions.length, 1);
  assert.equal(tieFirst.sessions[0]?.title, "Newer rollout");

  const invalid = { ...older, updatedAt: "recent" };
  assert.throws(
    () =>
      projectSessionsIndex([newer, invalid], {
        workspacePath: "/workspace",
        logEpoch: "host-index-epoch",
      }),
    /updatedAt/,
  );
});

test("cold history has no fake model, capabilities, plan completion or authoritative work time", () => {
  const thread = threadFixture();
  thread.model = null;
  thread.turns[0]!.items.push({ type: "plan", id: "plan-1", text: "## Proposed plan\n- Build" });
  const snapshot = projectThread(thread, { workspacePath: "/workspace" });
  assert.equal(snapshot.config.model, "");
  assert.equal(snapshot.config.modelSelection, undefined);
  assert.equal(snapshot.plan, null);
  assert.equal(snapshot.availability.setFollowupMode.allowed, false);
  assert.equal(snapshot.rows.window.at(-1)?.kind, "assistantText");
  assert.equal(
    snapshot.rows.window.every((row) => row.createdAtSeq === 0),
    true,
  );
});

/**
 * N 轮已 settled 的历史 + 1 个活动轮（内含正在流式的 agentMessage）。
 * 每轮 3 个 item → 4 行（turnHeader + user + reasoning + agentMessage），活动轮 3 行。
 */
function longThreadFixture(settledTurns: number): CodexThread {
  const base = threadFixture();
  const turns: CodexTurn[] = [];
  for (let index = 0; index < settledTurns; index += 1) {
    turns.push({
      id: `turn-${index}`,
      itemsView: "full",
      status: "completed",
      error: null,
      startedAt: 101 + index,
      completedAt: 102 + index,
      durationMs: 1000,
      items: [
        {
          type: "userMessage",
          id: `user-${index}`,
          clientId: `command-${index}`,
          content: [{ type: "text", text: `question ${index}`, text_elements: [] }],
        },
        { type: "reasoning", id: `reason-${index}`, summary: ["Consider"], content: ["Details"] },
        {
          type: "agentMessage",
          id: `answer-${index}`,
          text: `answer ${index}`,
          phase: "final_answer",
        },
      ],
    });
  }
  turns.push({
    id: "turn-active",
    itemsView: "full",
    status: "inProgress",
    error: null,
    startedAt: 200 + settledTurns,
    completedAt: null,
    durationMs: null,
    items: [
      {
        type: "userMessage",
        id: "user-active",
        content: [{ type: "text", text: "继续", text_elements: [] }],
      },
      { type: "agentMessage", id: "stream", text: "", phase: "commentary", status: "inProgress" },
    ],
  });
  return { ...base, turns, status: { type: "active", activeFlags: [] } };
}

function streamItemOf(thread: CodexThread): { text: string } {
  return thread.turns.at(-1)!.items[1] as unknown as { text: string };
}

/** 每条 delta 的均摊投影耗时（取多批最小值，降低机器负载抖动）。 */
function deltaCostPerEvent(settledTurns: number, batches = 3, deltas = 20): number {
  const thread = longThreadFixture(settledTurns);
  const stream = streamItemOf(thread);
  let best = Number.POSITIVE_INFINITY;
  for (let batch = 0; batch < batches; batch += 1) {
    const started = performance.now();
    for (let index = 0; index < deltas; index += 1) {
      stream.text += "字";
      thread.updatedAt += 1;
      const watermark = batch * deltas + index + 1;
      projectThread(thread, { ...options, seq: watermark, revision: watermark });
    }
    best = Math.min(best, performance.now() - started);
  }
  return best / deltas;
}

test("1200 轮流式 delta 只重投影活动轮，settled 行与 rowId 全序保持不变", () => {
  const thread = longThreadFixture(1200);
  const stream = streamItemOf(thread);
  const first = projectThread(thread, options);
  assert.equal(first.rows.totalCount, 1200 * 4 + 3);
  assert.deepEqual(
    first.rows.window.map((row) => row.rowId),
    first.rows.window.map((_, index) => index),
  );
  let previous = first;
  for (let index = 0; index < 20; index += 1) {
    stream.text += "字";
    thread.updatedAt += 1;
    const next = projectThread(thread, { ...options, seq: index + 2, revision: index + 2 });
    assert.equal(next.rows.totalCount, previous.rows.totalCount);
    assert.equal(next.seq, index + 2);
    assert.equal(next.revision, index + 2);
    // 只有活动轮 3 行允许换成新对象：settled 前缀必须整段复用（引用相同即证明没有重跑行投影）。
    const changed = next.rows.window.filter((row, at) => row !== previous.rows.window[at]);
    assert.equal(changed.length, 3, `第 ${index} 条 delta 重投影了 ${changed.length} 行`);
    assert.deepEqual(
      changed.map((row) => row.turnId),
      ["turn-active", "turn-active", "turn-active"],
    );
    assert.deepEqual(
      next.rows.window.map((row) => row.rowId),
      next.rows.window.map((_, at) => at),
    );
    previous = next;
  }
  const last = previous.rows.window.at(-1);
  assert.equal(last?.kind === "assistantText" && last.text, "字".repeat(20));
});

test("增量解析复用 settled 前缀，只重解析活动轮", () => {
  const thread = longThreadFixture(60);
  const before = parseCodexThreadIncremental(thread);
  streamItemOf(thread).text += "字";
  const after = parseCodexThreadIncremental(thread);
  assert.equal(after.turns.length, before.turns.length);
  // settled 前缀复用同一批解析结果（引用相同），活动轮必须重解析以带上新的流式文本
  assert.equal(after.turns[0], before.turns[0]);
  assert.equal(after.turns[59], before.turns[59]);
  assert.notEqual(after.turns[60], before.turns[60]);
  assert.deepEqual(after.turns.slice(0, 60), before.turns.slice(0, 60));
  assert.equal(
    (after.turns[60]!.items[1] as unknown as { text: string }).text,
    (before.turns[60]!.items[1] as unknown as { text: string }).text + "字",
  );
});

test("settled 轮追加 item 时只从该轮起重投影，更早的行与 rowId 前缀保持不变", () => {
  const thread = longThreadFixture(40);
  const first = projectThread(thread, options);
  thread.turns[10]!.items.push({
    type: "agentMessage",
    id: "late",
    text: "补充",
    status: "completed",
  });
  const next = projectThread(thread, { ...options, seq: 13 });
  assert.equal(next.rows.totalCount, first.rows.totalCount + 1);
  // 前 10 轮（40 行）整段复用
  assert.deepEqual(next.rows.window.slice(0, 40), first.rows.window.slice(0, 40));
  assert.equal(next.rows.window[44]?.entityId, "codex:turn:turn-10:item:late");
  assert.deepEqual(
    next.rows.window.map((row) => row.rowId),
    next.rows.window.map((_, index) => index),
  );
});

test("前缀缓存命中后仍按全历史检测重复 turnId", () => {
  const thread = longThreadFixture(20);
  projectThread(thread, options);
  thread.turns.push({ ...thread.turns[5]!, items: [] });
  assert.throws(() => projectThread(thread, { ...options, seq: 14 }), /Duplicate Codex turn ID/);
});

test("历史轮挂载审批交互时只重投影该轮，交互撤销后前缀缓存重新长回来", () => {
  const thread = longThreadFixture(30);
  thread.turns[20]!.items.push({
    type: "commandExecution",
    id: "pending-tool",
    command: "pwd",
    cwd: "/workspace",
    status: "inProgress",
  });
  const first = projectThread(thread, options);
  const interaction: PendingInteraction = {
    interactionId: "approval-1",
    kind: "permission",
    anchorRowId: null,
    createdAt: 102000,
    turnId: "turn-20",
    payload: {
      kind: "permission",
      toolCallId: "pending-tool",
      toolName: "Bash",
      summary: "Run pwd",
      detail: { command: "pwd" },
      options: [{ optionId: "allow", label: "Allow", kind: "allowOnce" }],
    },
  };
  const pending = projectThread(thread, { ...options, seq: 14, interactions: [interaction] });
  const row = pending.rows.window.find(
    (candidate) => candidate.entityId === "codex:turn:turn-20:item:pending-tool",
  );
  assert.equal(row?.kind === "toolCall" && row.status, "pendingApproval");
  assert.equal(row?.kind === "toolCall" && row.approvalInteractionId, "approval-1");
  // 交互只影响该轮：更早的 20 轮（80 行）与 rowId 全序都不变
  assert.deepEqual(pending.rows.window.slice(0, 80), first.rows.window.slice(0, 80));
  assert.deepEqual(
    pending.rows.window.map((candidate) => candidate.rowId),
    pending.rows.window.map((_, index) => index),
  );
  const restored = projectThread(thread, { ...options, seq: 15 });
  assert.deepEqual(restored.rows.window, first.rows.window);
});

test("子代理终态在后续轮收敛时，锚点轮的行前缀缓存随之刷新", () => {
  const thread = longThreadFixture(12);
  thread.turns[3]!.items.push({
    type: "collabAgentToolCall",
    id: "spawn-1",
    tool: "spawnAgent",
    status: "completed",
    senderThreadId: thread.id,
    receiverThreadIds: ["child-1"],
    prompt: "跑一下",
    agentsStates: {},
  });
  const subagentRowOf = (snapshot: ConversationSnapshot) =>
    snapshot.rows.window.find((row) => row.kind === "subagent");
  const running = subagentRowOf(projectThread(thread, options));
  assert.equal(running?.kind === "subagent" && running.status, "running");
  assert.equal(running?.turnId, "turn-3");
  // 终态出现在更晚的轮次：锚点轮（turn-3）已 settled，也必须刷新为 success
  thread.turns[9]!.items.push({
    type: "subAgentActivity",
    id: "activity-1",
    kind: "completed",
    agentThreadId: "child-1",
    agentPath: "worker",
  });
  const settled = subagentRowOf(projectThread(thread, { ...options, seq: 14 }));
  assert.equal(settled?.kind === "subagent" && settled.status, "success");
  assert.equal(settled?.turnId, "turn-3");
});

test("最新计划来自早期 settled 轮时，长历史流式 delta 仍稳定返回该计划", () => {
  const thread = longThreadFixture(60);
  thread.turns[3]!.items.push({
    type: "planUpdate",
    id: "plan-update",
    plan: [
      { step: "第一步", status: "completed" },
      { step: "第二步", status: "in_progress" },
    ],
  });
  const first = projectThread(thread, options);
  assert.deepEqual(
    first.plan?.items.map((item) => [item.id, item.status]),
    [
      ["turn-3:plan:1", "completed"],
      ["turn-3:plan:2", "inProgress"],
    ],
  );
  // turn-3 的 completedAt = 102 + 3：计划时间戳取自轮次事实，不随 thread.updatedAt 漂移
  assert.equal(first.plan?.updatedAt, 105 * 1000);
  const stream = streamItemOf(thread);
  for (let index = 0; index < 10; index += 1) {
    stream.text += "字";
    thread.updatedAt += 1;
    const next = projectThread(thread, { ...options, seq: index + 2 });
    // 计划来自已 settled 的 turn-3（completedAt 固定），备忘录不得把它冻结成过期值也不得丢掉
    assert.deepEqual(next.plan, first.plan);
  }
  // 活动轮出现更新的计划：立即覆盖早期计划
  thread.turns.at(-1)!.items.push({
    type: "planUpdate",
    id: "plan-update",
    plan: [{ step: "新计划", status: "pending" }],
  });
  const updated = projectThread(thread, { ...options, seq: 99 });
  assert.deepEqual(
    updated.plan?.items.map((item) => item.content),
    ["新计划"],
  );
});

test("计划轮没有时间戳时 updatedAt 跟随 thread.updatedAt，不被备忘录冻结", () => {
  const thread = longThreadFixture(6);
  const planTurn = thread.turns[2]!;
  planTurn.startedAt = null;
  planTurn.completedAt = null;
  planTurn.items.push({
    type: "planUpdate",
    id: "plan-update",
    plan: [{ step: "第一步", status: "pending" }],
  });
  const first = projectThread(thread, options);
  assert.equal(first.plan?.updatedAt, thread.updatedAt * 1000);
  thread.updatedAt += 7;
  const next = projectThread(thread, { ...options, seq: 14 });
  assert.equal(next.plan?.updatedAt, thread.updatedAt * 1000);
  assert.deepEqual(
    next.plan?.items.map((item) => item.content),
    ["第一步"],
  );
});

test("流式 delta 成本随历史长度近似常数（1500 轮 vs 30 轮）", () => {
  const small = deltaCostPerEvent(30);
  const large = deltaCostPerEvent(1500);
  // 前缀缓存命中时，每条 delta 与历史相关的成本只剩 O(轮数) 的引用校验；
  // 若退化成全史重投影，1500 轮的均摊耗时会比 30 轮高一个数量级。
  assert.ok(
    large < small * 12 + 0.5,
    `30 轮 ${small.toFixed(3)}ms/delta，1500 轮 ${large.toFixed(3)}ms/delta：投影退化成全史重算`,
  );
});
