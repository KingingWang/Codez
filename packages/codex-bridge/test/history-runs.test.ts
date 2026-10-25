import assert from "node:assert/strict";
import test from "node:test";
import {
  codexConversationHistoryRunsResultSchema,
  type CodexConversationHistoryRunsResult,
} from "@codez/shared/codez-protocol-v4";
import { projectCodexHistoryRuns } from "../src/history-runs.js";
import { threadFixture } from "./projection-fixtures.test.js";
import type { CodexThread, CodexTurn } from "../src/codex-types.js";

const statuses = {
  running: { status: "inProgress" as const },
  completed: { status: "completed" as const },
  failed: { status: "failed" as const, error: { message: "Fixture failure" } },
  interrupted: { status: "interrupted" as const },
};
function run(withStatus: (typeof statuses)[keyof typeof statuses], id: string): CodexTurn {
  return {
    id,
    itemsView: "full",
    startedAt: 10,
    completedAt: 20,
    durationMs: 10_000,
    items: [],
    ...withStatus,
  };
}
function query(
  thread: CodexThread,
  params: Parameters<typeof projectCodexHistoryRuns>[0]["params"],
) {
  return codexConversationHistoryRunsResultSchema.parse(
    projectCodexHistoryRuns({ thread, params, seq: 7, revision: 3, logEpoch: "epoch-1" }),
  );
}

/** 与实现同名的水位参数化查询：缓存按 (threadId, logEpoch, revision) 记账，测试要能显式改水位。 */
function queryAt(
  thread: CodexThread,
  revision: number,
  logEpoch: string,
  params: Omit<Parameters<typeof projectCodexHistoryRuns>[0]["params"], "sessionId"> = {},
) {
  return codexConversationHistoryRunsResultSchema.parse(
    projectCodexHistoryRuns({
      thread,
      params: { sessionId: thread.id, ...params },
      seq: 7,
      revision,
      logEpoch,
    }),
  );
}

const turnIds = (result: { runs: { turnId: string }[] }) => result.runs.map((run) => run.turnId);

test("native turns project observed status, sparse facts, tools, and artifacts", () => {
  const thread = threadFixture();
  thread.turns = [
    run(statuses.running, "running"),
    run(statuses.completed, "completed"),
    run(statuses.failed, "failed"),
    run(statuses.interrupted, "interrupted"),
  ];
  const result = query(thread, { sessionId: thread.id });
  assert.deepEqual(
    result.runs.map((item) => item.status),
    ["interrupted", "failed", "completed", "running"],
  );
  assert.ok(result.runs.every((item) => item.usage === undefined));
  const completed = query(thread, { sessionId: thread.id, status: "completed" }).runs[0]!;
  assert.equal(completed.startedAtMs, 10_000);
  assert.equal(completed.completedAtMs, 20_000);
  assert.equal(completed.durationMs, 10_000);
  const failed = query(thread, { sessionId: thread.id, status: "failed" }).runs[0]!;
  assert.deepEqual(failed.failure, { code: "codex.turn.failed", message: "Fixture failure" });
});

test("unknown and unrecognized native facts stay explicit and derivable", () => {
  const thread = threadFixture();
  thread.turns = [
    {
      ...run(statuses.completed, "turn-tools"),
      items: [
        {
          type: "unknownNativeTool",
          id: "native-unknown",
          extra: 1,
        },
        {
          type: "commandExecution",
          id: "command-1",
          command: "pnpm test",
          cwd: "/workspace",
          status: "completed",
        },
        {
          type: "mcpToolCall",
          id: "mcp-1",
          server: "server",
          tool: "tool",
          status: "failed",
          arguments: {},
        },
        {
          type: "fileChange",
          id: "files-1",
          status: "completed",
          changes: [
            { path: "src/a.ts", diff: "+one\n-two", kind: { type: "update", move_path: null } },
          ],
        },
        { type: "agentMessage", id: "answer", text: "Final answer", phase: "final_answer" },
      ],
    },
  ];
  const result = query(thread, { sessionId: thread.id }).runs[0]!;
  assert.deepEqual(
    result.toolChain.map((step) => [step.kind, step.status]),
    [
      ["unknown", "unknown"],
      ["command", "completed"],
      ["mcpToolCall", "failed"],
      ["fileChange", "completed"],
    ],
  );
  assert.deepEqual(result.fileChangeSummary, {
    files: 1,
    additions: 1,
    deletions: 1,
    paths: ["src/a.ts"],
  });
  assert.equal(result.result, "Final answer");
  assert.deepEqual(result.artifacts, [{ kind: "fileChange", path: "src/a.ts" }]);
});

test("stable pagination, filters, and reconnect reads never duplicate a native turn", () => {
  const thread = threadFixture();
  thread.turns = [
    run(statuses.completed, "one"),
    run(statuses.running, "two"),
    run(statuses.completed, "three"),
    run(statuses.completed, "four"),
  ];
  const first = query(thread, { sessionId: thread.id, limit: 2 });
  assert.deepEqual(
    first.runs.map((item) => item.turnId),
    ["four", "three"],
  );
  assert.equal(first.nextBeforeTurnId, "three");
  const second = query(thread, {
    sessionId: thread.id,
    limit: 2,
    beforeTurnId: first.nextBeforeTurnId,
  });
  assert.deepEqual(
    second.runs.map((item) => item.turnId),
    ["two", "one"],
  );
  assert.equal(second.nextBeforeTurnId, undefined);
  assert.deepEqual(
    query(thread, { sessionId: thread.id, status: "running" }).runs.map((item) => item.turnId),
    ["two"],
  );
  assert.deepEqual(
    first,
    query(thread, { sessionId: thread.id, limit: 2 }) as CodexConversationHistoryRunsResult,
  );
});

test("missing source or a vanished cursor fails explicitly", () => {
  assert.throws(() =>
    projectCodexHistoryRuns({
      thread: { invalid: true },
      params: { sessionId: "thread" },
      seq: 0,
      revision: 0,
      logEpoch: "epoch",
    }),
  );
  const thread = threadFixture();
  thread.turns = [run(statuses.completed, "turn-1")];
  assert.throws(
    () => query(thread, { sessionId: thread.id, beforeTurnId: "deleted-turn" }),
    /cursor turn no longer exists/,
  );
});

test("分页索引按 (logEpoch, revision) 失效：同一水位复用，水位变化立即重扫", () => {
  const thread = threadFixture();
  thread.turns = [
    run(statuses.completed, "one"),
    run(statuses.completed, "two"),
    run(statuses.completed, "three"),
  ];
  assert.deepEqual(turnIds(queryAt(thread, 3, "epoch-1")), ["three", "two", "one"]);
  // 原地替换中间 turn：长度与首尾 turn 引用都没变，只有 revision 能表达「历史变了」。
  // 生产里任何原生事件都经 ThreadStateStore.touch → revision+1，所以命中缓存不会读到过期页；
  // 这里锁住的正是这条水位合同（与 BridgeSnapshots.conversationCache 同一套失效权威）。
  thread.turns[1] = run(statuses.failed, "two-rebuilt");
  assert.deepEqual(
    turnIds(queryAt(thread, 3, "epoch-1")),
    ["three", "two", "one"],
    "同一 (epoch, revision) 必须复用已校验索引，不重新 parse 全史",
  );
  assert.deepEqual(turnIds(queryAt(thread, 4, "epoch-1")), ["three", "two-rebuilt", "one"]);
  // logEpoch 变化（重连后重放历史）同样失效，即使 revision 数字撞上。
  thread.turns[1] = run(statuses.completed, "two-again");
  assert.deepEqual(turnIds(queryAt(thread, 4, "epoch-2")), ["three", "two-again", "one"]);
  // 索引复用后游标仍按 id O(1) 定位，且不存在的游标继续显式失败。
  assert.deepEqual(turnIds(queryAt(thread, 4, "epoch-2", { beforeTurnId: "two-again" })), ["one"]);
  assert.throws(
    () => queryAt(thread, 4, "epoch-2", { beforeTurnId: "vanished" }),
    /cursor turn no longer exists/,
  );
});

test("settled turn 的 run 与 fileChangeSummary 命中 turn 级缓存，items 变化后失效", () => {
  let diffReads = 0;
  const thread = threadFixture();
  thread.turns = [
    {
      ...run(statuses.completed, "files"),
      items: [
        {
          type: "fileChange",
          id: "files-1",
          status: "completed",
          changes: [
            {
              path: "src/a.ts",
              kind: { type: "update", move_path: null },
              // 用 getter 计数：Zod 校验与 diff 行统计都要读它，缓存命中后一次都不该再读。
              get diff() {
                diffReads += 1;
                return "+one\n-two";
              },
            },
          ],
        },
      ],
    } as unknown as CodexTurn,
  ];
  const first = queryAt(thread, 3, "epoch-1").runs[0]!;
  assert.deepEqual(first.fileChangeSummary, {
    files: 1,
    additions: 1,
    deletions: 1,
    paths: ["src/a.ts"],
  });
  const afterFirst = diffReads;
  assert.ok(afterFirst > 0, "首次投影必须真的读过 diff");
  // 同一水位重复查询与翻页：settled turn 的投影与 diff 统计都不得重跑。
  queryAt(thread, 3, "epoch-1");
  queryAt(thread, 3, "epoch-1", { beforeTurnId: "files" });
  assert.equal(diffReads, afterFirst, "settled turn 的 run/fileChangeSummary 必须命中缓存");
  // revision 变化只失效分页索引；turn 引用未变时 turn 级缓存按身份继续复用。
  queryAt(thread, 4, "epoch-1");
  assert.equal(diffReads, afterFirst, "turn 级缓存与分页水位无关，按 turn 身份复用");
  // 终态 turn 追加 item（items 长度变化）→ 两级缓存都失效并重新投影。
  (thread.turns[0]!.items as unknown[]).push({
    type: "agentMessage",
    id: "answer",
    text: "Done",
    phase: "final_answer",
  });
  const refreshed = queryAt(thread, 5, "epoch-1").runs[0]!;
  assert.ok(diffReads > afterFirst, "items 变化必须让 turn 级缓存失效");
  assert.equal(refreshed.result, "Done");
});

test("分页索引缓存有界（LRU 32）：命中不重解析线程，超上限后最久未用的会话被淘汰", () => {
  // 与 history-runs.ts 的 PAGE_INDEX_CACHE_LIMIT 对齐：超量后最久未用的一条必须被挤出。
  const limit = 32;
  let previewReads = 0;
  const watched = {
    ...threadFixture(),
    id: "thread-lru-watched",
    turns: [run(statuses.completed, "only")],
    // 线程头只在索引未命中（需要 parse）时被读；命中缓存时一次都不读。
    get preview() {
      previewReads += 1;
      return "Hello";
    },
  } as unknown as CodexThread;
  assert.deepEqual(turnIds(queryAt(watched, 1, "epoch-lru")), ["only"]);
  const afterFirst = previewReads;
  assert.ok(afterFirst > 0, "首次查询必须 parse 线程头");
  queryAt(watched, 1, "epoch-lru");
  assert.equal(previewReads, afterFirst, "同一水位复用索引时不得重新 parse 线程");
  for (let index = 0; index < limit; index += 1) {
    const filler = threadFixture();
    filler.id = `thread-lru-filler-${index}`;
    filler.turns = [run(statuses.completed, `filler-${index}`)];
    queryAt(filler, 1, "epoch-lru");
  }
  queryAt(watched, 1, "epoch-lru");
  assert.ok(previewReads > afterFirst, "超出 LRU 上限后最久未用的索引必须被淘汰并重建");
});

test("capability authority marks only the independent read surface supported", async () => {
  const { bridgeCodexFeatureCapabilities } = await import("../src/control-plane.js");
  assert.deepEqual(bridgeCodexFeatureCapabilities({ supports: () => false }), {
    auxiliaryTextGeneration: "unsupported",
    observedSessionUsage: "supported",
    observedAppUsage: "supported",
    sharedContextContentCopy: "degraded",
    scheduledPromptAutomations: "supported",
    nativeBrowserCuaMcp: "unsupported",
    readOnlyWorkflowHistory: "supported",
    safeDesktopFileRewind: "supported",
    legacyWorkflowRuns: "unsupported",
    autoReviewApprovals: "unsupported",
    // 原生无逐条反馈通道：显式 unsupported（UI 隐藏点赞/点踩）。
    messageFeedback: "unsupported",
  });
});
