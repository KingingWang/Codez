import assert from "node:assert/strict";
import test from "node:test";
import type { AttachmentRef } from "@codez/shared/codez-protocol-v4";
import { BridgeSnapshots } from "../src/bridge-snapshots.js";
import { InteractionBroker } from "../src/interactions.js";
import { ThreadStateStore } from "../src/thread-state.js";
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
