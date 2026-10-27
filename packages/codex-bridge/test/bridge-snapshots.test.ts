import assert from "node:assert/strict";
import test, { mock } from "node:test";
import type { AttachmentRef } from "@codez/shared/codez-protocol-v4";
import { BridgeSnapshots } from "../src/bridge-snapshots.js";
import { InteractionBroker } from "../src/interactions.js";
import { ThreadStateStore } from "../src/thread-state.js";
import { queryBridgeRowPayload } from "../src/thread-queries.js";
import type { CodexRpcPort } from "../src/contract.js";
import type { AttachmentStore } from "../src/attachments.js";
import { threadFixture } from "./projection-fixtures.test.js";
import { formatNativeFileReference } from "../src/native-file-reference.js";

const cwd = "/workspace";
function port(): CodexRpcPort {
  return {
    async request() {
      throw new Error("unexpected native RPC");
    },
    async respond() {},
    async respondError() {},
  };
}
const image = (ref: string) => ({
  type: "localImage" as const,
  path: `/native/${ref}.png`,
});

test("native token usage remains sparse and unavailable fields never become zero", async () => {
  const thread = threadFixture();
  thread.tokenUsage = {
    total: { inputTokens: 10, cachedInputTokens: 2 },
    last: { totalTokens: 8 },
    modelContextWindow: 100,
  } as never;
  const rpc = port();
  const store = new ThreadStateStore(rpc, cwd);
  store.markStarted(thread);
  const snapshots = new BridgeSnapshots(
    { rpc, cwd },
    store,
    new InteractionBroker(rpc, () => {}),
    cwd,
  );
  const snapshot = await snapshots.conversation(thread.id);

  assert.deepEqual(snapshot.usage.codexObserved, {
    inputTokens: 10,
    cacheReadTokens: 2,
    contextWindow: { usedTokens: 8, maxTokens: 100 },
  });
  // Dense compatibility fields may exist for old consumers, but downstream sparse readers
  // must use codexObserved; missing output/cache-write are unavailable, not measured zero.
  assert.equal("outputTokens" in snapshot.usage.codexObserved!, false);
  assert.equal("cacheWriteTokens" in snapshot.usage.codexObserved!, false);
  const header = snapshot.rows.window.find((entry) => entry.kind === "turnHeader");
  assert.deepEqual(header?.turnUsage, {
    totalTokens: 8,
  });
});

test("unchanged history queries share one derived projection and a touch invalidates it", async () => {
  const thread = threadFixture();
  thread.turns = Array.from({ length: 65 }, (_, index) => ({
    ...thread.turns[0]!,
    id: `turn-${index}`,
  }));
  const rpc = port();
  const store = new ThreadStateStore(rpc, cwd);
  store.markStarted(thread);
  const snapshots = new BridgeSnapshots(
    { rpc, cwd },
    store,
    new InteractionBroker(rpc, () => {}),
    cwd,
  );
  const first = await snapshots.conversation(thread.id);
  const second = await snapshots.conversation(thread.id);
  assert.strictEqual(second, first);
  const topic = await snapshots.topic(`conversation/${thread.id}`);
  assert.ok((topic.snapshot as typeof first).rows.window.length < first.rows.window.length);
  assert.strictEqual(await snapshots.conversation(thread.id), first);
  store.touch(thread.id);
  const next = await snapshots.conversation(thread.id);
  assert.notStrictEqual(next, first);
  assert.deepEqual(
    next.rows.window.map((row) => row.rowId),
    first.rows.window.map((row) => row.rowId),
  );
});

test("multi-step turn accumulates tokenUsage across requests and ignores duplicate notifications", async () => {
  const thread = threadFixture();
  const turnId = thread.turns[0]!.id;
  const rpc = port();
  const store = new ThreadStateStore(rpc, cwd);
  store.markStarted(thread);

  // 第一步模型请求（假设之前历史累计已有 input: 1000, output: 100, total: 1100）
  await store.apply({
    method: "thread/tokenUsage/updated",
    params: {
      threadId: thread.id,
      turnId,
      tokenUsage: {
        total: {
          inputTokens: 11_000,
          cachedInputTokens: 8_000,
          cacheWriteInputTokens: 2_000,
          outputTokens: 300,
          reasoningOutputTokens: 50,
          totalTokens: 11_300,
        },
        last: {
          inputTokens: 10_000,
          cachedInputTokens: 8_000,
          cacheWriteInputTokens: 2_000,
          outputTokens: 200,
          reasoningOutputTokens: 50,
          totalTokens: 10_200,
        },
        modelContextWindow: 200_000,
      },
    },
  });
  // 重复推送完全相同的 tokenUsage 通知（幂等验证）
  await store.apply({
    method: "thread/tokenUsage/updated",
    params: {
      threadId: thread.id,
      turnId,
      tokenUsage: {
        total: {
          inputTokens: 11_000,
          cachedInputTokens: 8_000,
          cacheWriteInputTokens: 2_000,
          outputTokens: 300,
          reasoningOutputTokens: 50,
          totalTokens: 11_300,
        },
        last: {
          inputTokens: 10_000,
          cachedInputTokens: 8_000,
          cacheWriteInputTokens: 2_000,
          outputTokens: 200,
          reasoningOutputTokens: 50,
          totalTokens: 10_200,
        },
        modelContextWindow: 200_000,
      },
    },
  });
  // 同一轮 turn 内的第二步模型请求（例如 tool call 返回后继续生成）
  await store.apply({
    method: "thread/tokenUsage/updated",
    params: {
      threadId: thread.id,
      turnId,
      tokenUsage: {
        total: {
          inputTokens: 23_000,
          cachedInputTokens: 19_500,
          cacheWriteInputTokens: 2_500,
          outputTokens: 450,
          reasoningOutputTokens: 80,
          totalTokens: 23_450,
        },
        last: {
          inputTokens: 12_000,
          cachedInputTokens: 11_500,
          cacheWriteInputTokens: 500,
          outputTokens: 150,
          reasoningOutputTokens: 30,
          totalTokens: 12_150,
        },
        modelContextWindow: 200_000,
      },
    },
  });

  const snapshots = new BridgeSnapshots(
    { rpc, cwd },
    store,
    new InteractionBroker(rpc, () => {}),
    cwd,
  );
  const snapshot = await snapshots.conversation(thread.id);
  const header = snapshot.rows.window.find((entry) => entry.kind === "turnHeader");
  assert.deepEqual(header?.turnUsage, {
    inputTokens: 22_000,
    outputTokens: 350,
    totalTokens: 22_350,
    cacheReadTokens: 19_500,
    cacheWriteTokens: 2_500,
    reasoningTokens: 80,
  });
  assert.equal(header?.outputTokens, 350);
  // contextWindow.usedTokens 仍保持最后一次请求的上下文水位（12,150），而会话累计是 23,000 / 450
  assert.deepEqual(snapshot.usage.codexObserved, {
    inputTokens: 23_000,
    outputTokens: 450,
    cacheReadTokens: 19_500,
    cacheWriteTokens: 2_500,
    contextWindow: { usedTokens: 12_150, maxTokens: 200_000 },
  });
});

test("history reload clearing turns mid-encode never crashes the snapshot", async () => {
  // 回归：editUserQuery/compact 触发 reloadAfterHistoryChange 清空 state.thread.turns，
  // 与快照编码里的 attachments 投影 await 交错；行来自编码前拷贝的 presentationThread，
  // turnHeader 仍在而 turns 已空。旧实现对此 object(undefined) 抛 "Expected a JSON object"
  // 并使整个 bridge 连接崩溃（冒烟表现为 Codex connection closed by client）。
  const thread = threadFixture();
  thread.turns[0]!.items[0] = {
    type: "userMessage",
    id: "user-1",
    content: [image("attached")],
  } as never;
  const rpc = port();
  const store = new ThreadStateStore(rpc, cwd);
  const state = store.markStarted(thread);
  const attachments = {
    async findNativeAttachment() {
      // 模拟 reloadAfterHistoryChange 在编码中途清空 turns。
      state.thread.turns = [];
      return undefined;
    },
  } as unknown as AttachmentStore;
  const snapshots = new BridgeSnapshots(
    { rpc, cwd },
    store,
    new InteractionBroker(rpc, () => {}),
    cwd,
    attachments,
  );
  const snapshot = await snapshots.conversation(thread.id);

  assert.deepEqual(state.thread.turns, []);
  assert.ok(snapshot.rows.window.some((row) => row.kind === "turnHeader"));
});

test("completed native file add advertises real counts and a guarded rewind row action", async () => {
  const thread = threadFixture();
  thread.turns[0]!.items.push({
    type: "fileChange",
    id: "new-file",
    status: "completed",
    changes: [{ path: "/workspace/new.txt", kind: { type: "add" }, diff: "first\nsecond\n" }],
  } as never);
  const rpc = port();
  const store = new ThreadStateStore(rpc, cwd);
  store.markStarted(thread);
  const snapshots = new BridgeSnapshots(
    { rpc, cwd },
    store,
    new InteractionBroker(rpc, () => {}),
    cwd,
  );
  const snapshot = await snapshots.conversation(thread.id);
  const row = snapshot.rows.window.find((entry) => entry.kind === "turnHeader");
  assert.equal(row?.fileChanges?.additions, 2);
  assert.equal(row?.fileChanges?.deletions, 0);
  assert.equal(row?.actions?.canRewindFiles, true);
  const tool = snapshot.rows.window.find(
    (entry) => entry.kind === "toolCall" && entry.toolCallId === "new-file",
  );
  assert.equal(tool?.kind === "toolCall" && tool.output?.display?.kind, "file_diff");
  if (tool?.kind === "toolCall" && tool.output?.display?.kind === "file_diff") {
    assert.deepEqual(tool.output.display.structuredPatch[0]?.lines, ["+first", "+second"]);
  }
});

test("attachment restoration follows turn-scoped row identity when native item IDs are reused", async () => {
  const thread = threadFixture();
  const first = {
    ...thread.turns[0]!,
    id: "turn-1",
    status: "completed" as const,
    completedAt: 119,
    items: [{ type: "userMessage" as const, id: "reused-user", content: [image("first")] }],
  };
  const second = {
    ...first,
    id: "turn-2",
    startedAt: 121,
    completedAt: 122,
    items: [{ type: "userMessage" as const, id: "reused-user", content: [image("second")] }],
  };
  thread.turns = [first, second];
  const rpc = port();
  const store = new ThreadStateStore(rpc, cwd);
  store.markStarted(thread);
  const restored: AttachmentRef[] = [];
  const attachments = {
    async findNativeAttachment(path: string, sessionId: string) {
      assert.equal(sessionId, thread.id);
      const ref = path.endsWith("/first.png") ? "first-ref" : "second-ref";
      const value = { ref, fileName: `${ref}.png`, mime: "image/png", bytes: 1 };
      restored.push(value);
      return value;
    },
  } as unknown as AttachmentStore;
  const snapshots = new BridgeSnapshots(
    { rpc, cwd },
    store,
    new InteractionBroker(rpc, () => {}),
    cwd,
    attachments,
  );
  const snapshot = await snapshots.conversation(thread.id);
  const users = snapshot.rows.window.filter((row) => row.kind === "userInput");
  assert.deepEqual(
    users.map((row) => row.entityId),
    ["codex:turn:turn-1:item:reused-user", "codex:turn:turn-2:item:reused-user"],
  );
  assert.deepEqual(
    users.map((row) => row.attachments?.map((attachment) => attachment.ref)),
    [["first-ref"], ["second-ref"]],
  );
  assert.deepEqual(
    restored.map((attachment) => attachment.ref),
    ["first-ref", "second-ref"],
  );
  assert.equal(
    snapshots.authorizeAttachment({
      sessionId: thread.id,
      method: "v4/conversation/attachment/read",
      ref: "second-ref",
      target: { rowId: users[1]!.rowId, entityId: users[1]!.entityId! },
      attachmentIndex: 0,
    }),
    true,
  );
});

test("binary refs remain chips in native history and queue without exposing private markers", async () => {
  const thread = threadFixture();
  const ref: AttachmentRef = {
    ref: "codez-attachment://00000000-0000-4000-8000-000000000001",
    fileName: "archive.zip",
    mime: "application/zip",
    bytes: 4,
  };
  const path = "/private/objects/00000000-0000-4000-8000-000000000001.data";
  const marker = formatNativeFileReference({ attachment: ref, path });
  thread.turns[0]!.items[0] = {
    type: "userMessage",
    id: "user-1",
    content: [{ type: "text", text: `Inspect this\n${marker}`, text_elements: [] }],
  };
  const rpc = port();
  const store = new ThreadStateStore(rpc, cwd);
  const state = store.markStarted(thread);
  state.queue = [
    {
      id: "queue-1",
      clientUserMessageId: "command-1",
      input: [{ type: "text", text: marker, text_elements: [] }],
    },
  ];
  const attachments = {
    async findNativeAttachment(candidate: string, sessionId: string) {
      assert.equal(candidate, path);
      assert.equal(sessionId, thread.id);
      return ref;
    },
  } as unknown as AttachmentStore;
  const snapshots = new BridgeSnapshots(
    { rpc, cwd },
    store,
    new InteractionBroker(rpc, () => {}),
    cwd,
    attachments,
  );
  const snapshot = await snapshots.conversation(thread.id);
  const user = snapshot.rows.window.find((row) => row.kind === "userInput");
  assert.equal(user?.text, "Inspect this");
  assert.deepEqual(user?.attachments, [ref]);
  assert.deepEqual(snapshot.queue.items[0]?.attachments, [ref]);
  assert.equal(snapshot.queue.items[0]?.text, "");
});

test("topic snapshot compacts settled heavy tool rows while queryBridgeRowPayload returns full payload", async () => {
  const thread = threadFixture();
  const heavyOutput = "line-0123456789abcdef\n".repeat(120);
  thread.turns[0]!.items.push({
    type: "commandExecution",
    id: "cmd-heavy-1",
    command: "pnpm test",
    cwd,
    status: "completed",
    aggregatedOutput: heavyOutput,
    exitCode: 0,
    durationMs: 120,
  } as never);
  const rpc = port();
  const store = new ThreadStateStore(rpc, cwd);
  store.markStarted(thread);
  const snapshots = new BridgeSnapshots(
    { rpc, cwd },
    store,
    new InteractionBroker(rpc, () => {}),
    cwd,
  );
  const topic = await snapshots.topic(`conversation/${thread.id}`);
  const wireSnapshot = topic.snapshot as Awaited<ReturnType<BridgeSnapshots["conversation"]>>;
  const wireTool = wireSnapshot.rows.window.find(
    (row): row is Extract<typeof row, { kind: "toolCall" }> =>
      row.kind === "toolCall" && row.toolCallId === "cmd-heavy-1",
  );
  assert.ok(wireTool);
  assert.ok((wireTool.output?.text.length ?? 0) < heavyOutput.length);
  assert.equal(wireTool.output?.truncated?.ref, `v4-row-payload/${wireTool.rowId}`);

  const fullPayload = await queryBridgeRowPayload(
    { sessionId: thread.id, rowId: wireTool.rowId },
    (id) => snapshots.conversation(id),
  );
  assert.equal(fullPayload.row?.kind, "toolCall");
  if (fullPayload.row?.kind === "toolCall") {
    assert.equal(fullPayload.row.output?.text, heavyOutput);
  }
});

test("imageView rows resolve session-owned bridge attachment fileName without rewriting path", async () => {
  const thread = threadFixture();
  const blobPath = "/private/objects/00000000-0000-4000-8000-000000000099.data";
  thread.turns[0]!.items.push({
    type: "imageView",
    id: "img-att-1",
    path: blobPath,
  } as never);
  const rpc = port();
  const store = new ThreadStateStore(rpc, cwd);
  store.markStarted(thread);
  const attachments = {
    async findNativeAttachment(candidate: string, sessionId: string) {
      assert.equal(candidate, blobPath);
      assert.equal(sessionId, thread.id);
      return {
        ref: "codez-attachment://00000000-0000-4000-8000-000000000099",
        fileName: "pasted-screenshot.png",
        mime: "image/png",
        bytes: 128,
      };
    },
  } as unknown as AttachmentStore;
  const snapshots = new BridgeSnapshots(
    { rpc, cwd },
    store,
    new InteractionBroker(rpc, () => {}),
    cwd,
    attachments,
  );
  const snapshot = await snapshots.conversation(thread.id);
  const row = snapshot.rows.window.find(
    (entry) => entry.kind === "toolCall" && entry.toolCallId === "img-att-1",
  );
  assert.equal(row?.kind, "toolCall");
  if (row?.kind !== "toolCall") return;
  assert.deepEqual(row.input, {
    path: blobPath,
    fileName: "pasted-screenshot.png",
  });
});

test("streaming deltas on an active turn reuse settled historical turn projections and attachment lookups", async () => {
  const thread = threadFixture();
  const settledTurn = {
    ...thread.turns[0]!,
    id: "turn-settled-1",
    status: "completed" as const,
    completedAt: 119,
    items: [
      { type: "userMessage" as const, id: "user-1", content: [image("settled")] },
      { type: "agentMessage" as const, id: "ans-1", text: "Settled answer" },
    ],
  };
  const activeTurn = {
    ...thread.turns[0]!,
    id: "turn-active-2",
    status: "inProgress" as const,
    startedAt: 120,
    completedAt: null,
    items: [
      {
        type: "userMessage" as const,
        id: "user-2",
        content: [{ type: "text" as const, text: "Stream this", text_elements: [] }],
      },
      { type: "agentMessage" as const, id: "ans-2", status: "inProgress" as const, text: "Part 1" },
    ],
  };
  thread.status = { type: "active", activeFlags: [] };
  thread.turns = [settledTurn, activeTurn];
  const rpc = port();
  const store = new ThreadStateStore(rpc, cwd);
  store.markStarted(thread);

  let attachmentLookups = 0;
  const attachments = {
    async findNativeAttachment(path: string, sessionId: string) {
      assert.equal(sessionId, thread.id);
      attachmentLookups += 1;
      return {
        ref: "codez-attachment://00000000-0000-4000-8000-000000000010",
        fileName: `${path}.png`,
        mime: "image/png",
        bytes: 16,
      };
    },
  } as unknown as AttachmentStore;
  const snapshots = new BridgeSnapshots(
    { rpc, cwd },
    store,
    new InteractionBroker(rpc, () => {}),
    cwd,
    attachments,
  );

  const first = await snapshots.conversation(thread.id);
  assert.equal(attachmentLookups, 1);
  assert.equal(first.rows.window.at(-1)?.kind, "assistantText");

  await store.apply({
    method: "item/agentMessage/delta",
    params: {
      threadId: thread.id,
      turnId: "turn-active-2",
      itemId: "ans-2",
      delta: " + Part 2",
    },
  });
  const second = await snapshots.conversation(thread.id);
  assert.equal(
    attachmentLookups,
    1,
    "completed historical turn must not re-run attachment lookup during active-turn streaming",
  );
  const lastRow = second.rows.window.at(-1);
  assert.equal(lastRow?.kind, "assistantText");
  if (lastRow?.kind === "assistantText") {
    assert.equal(lastRow.text, "Part 1 + Part 2");
  }
});

test("settledTurnRowsCache is not mutated by idle row actions and stays active across subagent turns", async () => {
  const thread = threadFixture();
  const turn1 = {
    ...thread.turns[0]!,
    id: "turn-1",
    status: "completed" as const,
    completedAt: 110,
    items: [
      {
        type: "userMessage" as const,
        id: "user-1",
        content: [{ type: "text" as const, text: "First question", text_elements: [] }],
      },
      {
        type: "collabAgentToolCall" as const,
        id: "spawn-1",
        tool: "spawnAgent" as const,
        status: "completed" as const,
        senderThreadId: thread.id,
        receiverThreadIds: ["child-thread-1"],
        prompt: "Inspect codebase",
        model: null,
        reasoningEffort: null,
        agentsStates: { "child-thread-1": { status: "completed" } },
      },
      { type: "agentMessage" as const, id: "ans-1", text: "First answer" },
    ],
  };
  const turn2 = {
    ...thread.turns[0]!,
    id: "turn-2",
    status: "completed" as const,
    startedAt: 115,
    completedAt: 119,
    items: [
      {
        type: "userMessage" as const,
        id: "user-2",
        content: [{ type: "text" as const, text: "Second question", text_elements: [] }],
      },
      { type: "agentMessage" as const, id: "ans-2", text: "Second answer" },
    ],
  };
  thread.status = { type: "idle" };
  thread.turns = [turn1, turn2] as never;

  const rpc = port();
  const store = new ThreadStateStore(rpc, cwd);
  store.markStarted(thread);
  const snapshots = new BridgeSnapshots(
    { rpc, cwd },
    store,
    new InteractionBroker(rpc, () => {}),
    cwd,
  );

  // Idle snapshot: assistantText and userInput have actions populated
  const idleSnap = await snapshots.conversation(thread.id);
  const idleTurn1Answer = idleSnap.rows.window.find(
    (row) => row.turnId === "turn-1" && row.kind === "assistantText",
  );
  assert.deepEqual(idleTurn1Answer?.actions, { canFork: true });

  // Start a new turn -> session becomes running (not idle)
  await store.apply({
    method: "turn/started",
    params: {
      threadId: thread.id,
      turn: {
        id: "turn-3",
        status: "inProgress",
        itemsView: "full",
        items: [
          {
            type: "userMessage",
            id: "user-3",
            content: [{ type: "text", text: "Third question", text_elements: [] }],
          },
          {
            type: "agentMessage",
            id: "ans-3",
            status: "inProgress",
            text: "Streaming",
          },
        ],
      },
    },
  });
  store.get(thread.id)!.thread.status = { type: "active", activeFlags: [] };
  store.touch(thread.id);

  const busySnap1 = await snapshots.conversation(thread.id);
  const busyTurn1Answer = busySnap1.rows.window.find(
    (row) => row.turnId === "turn-1" && row.kind === "assistantText",
  );
  const busyTurn1User = busySnap1.rows.window.find(
    (row) => row.turnId === "turn-1" && row.kind === "userInput",
  );
  // Cached rows from turn-1 must not retain stale idle actions when session is running!
  assert.equal(busyTurn1Answer?.actions, undefined);
  assert.equal(busyTurn1User?.actions, undefined);

  // Streaming delta on turn-3 must reuse exact row object references for settled turn-1 and turn-2
  await store.apply({
    method: "item/agentMessage/delta",
    params: {
      threadId: thread.id,
      turnId: "turn-3",
      itemId: "ans-3",
      delta: " more",
    },
  });
  const busySnap2 = await snapshots.conversation(thread.id);
  const busySnap2Turn2Answer = busySnap2.rows.window.find(
    (row) => row.turnId === "turn-2" && row.kind === "assistantText",
  );
  const busySnap1Turn2Answer = busySnap1.rows.window.find(
    (row) => row.turnId === "turn-2" && row.kind === "assistantText",
  );
  assert.strictEqual(
    busySnap2Turn2Answer,
    busySnap1Turn2Answer,
    "settled turn-2 rows should be reused by reference even when turn-1 has subagent anchors",
  );
});

// ── 快照 in-flight 合并 / O(active) 富化（specs/codex-desktop-adapter.md）──────────────
// 观测口径：BridgeSnapshots.conversation 是唯一构建入口，每次构建恰好调用一次
// store.noteSubagentChildren，所以它是「逻辑快照构建 + projectThread」次数的计数器。

function imageViewItem(id: string, name: string) {
  return { type: "imageView", id, path: `/native/${name}.png` } as never;
}

function gatedAttachmentStore(gate: () => Promise<void>, onLookup?: () => void) {
  return {
    async findNativeAttachment(path: string) {
      onLookup?.();
      await gate();
      return {
        ref: `codez-attachment://${path}`,
        fileName: `${path.split("/").at(-1)}.png`,
        mime: "image/png",
        bytes: 8,
      };
    },
  } as unknown as AttachmentStore;
}

test("concurrent reads of one state version share a single projection build", async (t) => {
  const thread = threadFixture();
  thread.turns[0]!.items.push(imageViewItem("img-inflight", "inflight"));
  const rpc = port();
  const store = new ThreadStateStore(rpc, cwd);
  store.markStarted(thread);
  const builds = mock.method(store, "noteSubagentChildren");
  t.after(() => mock.restoreAll());
  let lookups = 0;
  let gate = Promise.withResolvers<void>();
  const snapshots = new BridgeSnapshots(
    { rpc, cwd },
    store,
    new InteractionBroker(rpc, () => {}),
    cwd,
    gatedAttachmentStore(
      () => gate.promise,
      () => {
        lookups += 1;
      },
    ),
  );

  const pending = Array.from({ length: 8 }, () => snapshots.conversation(thread.id));
  // 8 个调用的 store.ensure continuation 已按顺序排队；第一个构建会在附件解析处让出，
  // 后到的 7 个必须挂到同一个 in-flight promise 上，而不是各自再起一次构建。
  gate.resolve();
  const results = await Promise.all(pending);
  assert.equal(new Set(results).size, 1, "同一 state 版本的并发读取必须复用同一份快照");
  assert.equal(builds.mock.callCount(), 1, "逻辑快照构建 + projectThread 只能跑一次");
  assert.equal(lookups, 1, "并发读取不得放大底层附件解析次数");

  // in-flight 条目在 finally 里清理：版本推进后必须重新构建，而不是挂到已完成的旧 promise。
  store.touch(thread.id);
  const next = await snapshots.conversation(thread.id);
  assert.notStrictEqual(next, results[0]);
  assert.equal(builds.mock.callCount(), 2);
});

test("additionalDirectories order and duplicates normalize into one in-flight key", async (t) => {
  const thread = threadFixture();
  thread.id = "thread-dirs";
  thread.turns[0]!.items.push(imageViewItem("img-dirs", "dirs"));
  const rpc = port();
  const store = new ThreadStateStore(rpc, cwd);
  store.markStarted(thread);
  const builds = mock.method(store, "noteSubagentChildren");
  t.after(() => mock.restoreAll());
  const gate = Promise.withResolvers<void>();
  const snapshots = new BridgeSnapshots(
    { rpc, cwd },
    store,
    new InteractionBroker(rpc, () => {}),
    cwd,
    gatedAttachmentStore(() => gate.promise),
  );

  const pending = [
    snapshots.conversation(thread.id, ["/extra-a", "/extra-b"]),
    snapshots.conversation(thread.id, ["/extra-b", "/extra-a", "/extra-a"]),
  ];
  await Promise.resolve();
  gate.resolve();
  const [first, second] = await Promise.all(pending);
  assert.strictEqual(second, first);
  assert.equal(builds.mock.callCount(), 1);
});

test("a superseded in-flight build never republishes its snapshot into the derived cache", async (t) => {
  const thread = threadFixture();
  thread.id = "thread-superseded";
  thread.turns[0]!.items.push(imageViewItem("img-superseded", "superseded"));
  const rpc = port();
  const store = new ThreadStateStore(rpc, cwd);
  store.markStarted(thread);
  const builds = mock.method(store, "noteSubagentChildren");
  t.after(() => mock.restoreAll());
  const gate = Promise.withResolvers<void>();
  const snapshots = new BridgeSnapshots(
    { rpc, cwd },
    store,
    new InteractionBroker(rpc, () => {}),
    cwd,
    gatedAttachmentStore(() => gate.promise),
  );

  const stale = snapshots.conversation(thread.id);
  await Promise.resolve();
  // await 期间版本被顶掉：旧构建的结果只能作废，不能写回 conversationCache。
  store.touch(thread.id);
  const fresh = snapshots.conversation(thread.id);
  gate.resolve();
  const [staleSnapshot, freshSnapshot] = await Promise.all([stale, fresh]);
  assert.notStrictEqual(staleSnapshot, freshSnapshot);
  assert.equal(builds.mock.callCount(), 2);
  assert.strictEqual(
    await snapshots.conversation(thread.id),
    freshSnapshot,
    "被顶掉的在途构建不得污染新 revision 的派生缓存",
  );
  assert.equal(builds.mock.callCount(), 2, "命中新 revision 的派生缓存，不再重复构建");
});

test("33 concurrent sessions keep one build each while the in-flight table evicts", async (t) => {
  const rpc = port();
  const store = new ThreadStateStore(rpc, cwd);
  const ids: string[] = [];
  for (let index = 0; index < 33; index += 1) {
    const thread = threadFixture();
    thread.id = `thread-bounded-${index}`;
    thread.turns[0]!.items.push(imageViewItem(`img-bounded-${index}`, `bounded-${index}`));
    store.markStarted(thread);
    ids.push(thread.id);
  }
  const builds = mock.method(store, "noteSubagentChildren");
  t.after(() => mock.restoreAll());
  const gate = Promise.withResolvers<void>();
  const snapshots = new BridgeSnapshots(
    { rpc, cwd },
    store,
    new InteractionBroker(rpc, () => {}),
    cwd,
    gatedAttachmentStore(() => gate.promise),
  );

  // 33 个不同会话同时在途：合并表容量上限是 32，最旧条目会被淘汰。
  // 淘汰只影响后续合并，绝不能让已在途的构建丢结果或串会话。
  const pending = ids.map((id) => snapshots.conversation(id));
  await Promise.resolve();
  gate.resolve();
  const results = await Promise.all(pending);
  assert.equal(results.length, 33);
  assert.deepEqual(
    results.map((snapshot) => snapshot.sessionId),
    ids,
  );
  assert.equal(builds.mock.callCount(), 33);
});

test("streaming deltas reuse cached enrichment for settled turns instead of re-cloning history", async () => {
  const thread = threadFixture();
  const settledTurn = {
    ...thread.turns[0]!,
    id: "turn-settled",
    status: "completed" as const,
    completedAt: 119,
    items: [
      {
        type: "userMessage" as const,
        id: "user-settled",
        clientId: "command-settled",
        content: [{ type: "text" as const, text: "Settled question", text_elements: [] }],
      },
      {
        type: "fileChange" as const,
        id: "file-settled",
        status: "completed" as const,
        changes: [{ path: "/workspace/a.txt", kind: { type: "add" }, diff: "one\ntwo\n" }],
      },
      { type: "agentMessage" as const, id: "ans-settled", text: "Settled answer" },
    ],
  };
  const activeTurn = {
    ...thread.turns[0]!,
    id: "turn-active",
    status: "inProgress" as const,
    startedAt: 120,
    completedAt: null,
    items: [
      {
        type: "userMessage" as const,
        id: "user-active",
        content: [{ type: "text" as const, text: "Stream this", text_elements: [] }],
      },
      {
        type: "agentMessage" as const,
        id: "ans-active",
        status: "inProgress" as const,
        text: "Part 1",
      },
    ],
  };
  thread.status = { type: "active", activeFlags: [] };
  thread.turns = [settledTurn, activeTurn] as never;
  const rpc = port();
  const store = new ThreadStateStore(rpc, cwd);
  store.markStarted(thread);
  const snapshots = new BridgeSnapshots(
    { rpc, cwd },
    store,
    new InteractionBroker(rpc, () => {}),
    cwd,
  );

  const first = await snapshots.conversation(thread.id);
  const settledHeader = first.rows.window.find(
    (row): row is Extract<typeof row, { kind: "turnHeader" }> =>
      row.turnId === "turn-settled" && row.kind === "turnHeader",
  );
  assert.equal(settledHeader?.fileChanges?.additions, 2);
  assert.equal(settledHeader?.actions?.canRewindFiles, true, "该轮 header 确实被富化（会被缓存）");

  await store.apply({
    method: "item/agentMessage/delta",
    params: {
      threadId: thread.id,
      turnId: "turn-active",
      itemId: "ans-active",
      delta: " + Part 2",
    },
  });
  const second = await snapshots.conversation(thread.id);
  const rowsOf = (snapshot: typeof first, turnId: string) =>
    snapshot.rows.window.filter((row) => row.turnId === turnId);
  const settledBefore = rowsOf(first, "turn-settled");
  const settledAfter = rowsOf(second, "turn-settled");
  assert.equal(settledAfter.length, settledBefore.length);
  settledBefore.forEach((row, index) =>
    assert.strictEqual(
      settledAfter[index],
      row,
      "已 settled 轮次的富化行必须按引用复用，delta 期间不再逐帧克隆整段历史",
    ),
  );
  assert.notStrictEqual(
    rowsOf(second, "turn-active").at(-1),
    rowsOf(first, "turn-active").at(-1),
    "活跃轮次仍然每帧重投影",
  );
  const streamingRow = second.rows.window.at(-1);
  assert.equal(streamingRow?.kind === "assistantText" && streamingRow.text, "Part 1 + Part 2");

  // 撤销标记变化必须让缓存失效：canRewindFiles 不能再挂在已撤销的轮次上。
  snapshots.markFileChangesReverted(thread.id, "turn-settled");
  store.touch(thread.id);
  const third = await snapshots.conversation(thread.id);
  const revertedHeader = third.rows.window.find(
    (row): row is Extract<typeof row, { kind: "turnHeader" }> =>
      row.turnId === "turn-settled" && row.kind === "turnHeader",
  );
  assert.equal(revertedHeader?.fileChanges?.state, "reverted");
  assert.equal(revertedHeader?.actions?.canRewindFiles, undefined);
  assert.notStrictEqual(revertedHeader, settledHeader);
});

/**
 * 回归：空轮次历史 + 仍然活着的 apiRetry 观测，快照必须投影出 apiRetry: null 而不是抛错。
 *
 * 原因：旧实现用 `object(array(state.thread.turns).at(-1)).id` 取最后一轮，空历史上
 * `object(undefined)` 抛 "Expected a JSON object"。buildConversation 只有 finally 没有 catch，
 * 异常沿订阅 drain 冒泡后被 bridge-runtime.ts:129-133 判定为非 DeletedThreadError 而调用 fatal，
 * bridge 进程退出（整个窗口的会话一起断）。`reloadAfterHistoryChange` 会同步清空 turns
 * 再 await ensure，这段窗口正好命中。
 * 依据：apiRetry 是轮次作用域的瞬时观测，没有最后一轮即没有活动轮，投影为 null 与
 * CONTRACT.md「模型进度、终态通知与轮次完成清除观测」同一口径。
 */
test("an empty turn history with a live retry observation projects apiRetry null instead of throwing", async () => {
  const thread = threadFixture();
  thread.status = { type: "active", activeFlags: [] };
  thread.turns[0]!.status = "inProgress";
  thread.turns[0]!.completedAt = null;
  const rpc = port();
  const store = new ThreadStateStore(rpc, cwd);
  store.markStarted(thread);

  // 先建立一个真实的重试观测（最后一轮 inProgress + willRetry），作为阳性对照。
  await store.apply({
    method: "error",
    params: {
      threadId: thread.id,
      turnId: thread.turns[0]!.id,
      willRetry: true,
      error: {
        message: "Reconnecting... 1/5",
        additionalDetails: '{"error":{"code":"rate_limit_reached"}}',
        codexErrorInfo: { responseStreamDisconnected: { httpStatusCode: 503 } },
      },
    },
  });
  const state = store.get(thread.id)!;
  assert.ok(state.apiRetry, "前置条件：重试观测必须已经建立");

  const snapshots = new BridgeSnapshots(
    { rpc, cwd },
    store,
    new InteractionBroker(rpc, () => {}),
    cwd,
  );
  const withTurns = await snapshots.conversation(thread.id);
  const projectedRetry = withTurns.control.apiRetry;
  assert.ok(projectedRetry, "阳性对照：有活动轮时重试状态必须可见");
  // 快照里的 apiRetry 是联合类型（counted | codex），用 `in` 收窄到 codex 分支再断言，
  // 避免直接读 httpStatusCode 触发 TS2339。
  if ("httpStatusCode" in projectedRetry) {
    assert.equal(projectedRetry.httpStatusCode, 503, "阳性对照：投影必须携带原生 httpStatusCode");
  } else {
    assert.fail("阳性对照：投影必须落在 codex 分支");
  }

  // 模拟 reloadAfterHistoryChange 的空历史窗口（turns 被同步清空）。
  state.thread.turns = [];
  store.touch(thread.id);
  const emptied = await snapshots.conversation(thread.id);
  assert.equal(emptied.control.apiRetry, null, "没有最后一轮即没有活动轮");
  assert.equal(emptied.control.phase, "running");
  assert.equal(emptied.control.canStop, false);
});
