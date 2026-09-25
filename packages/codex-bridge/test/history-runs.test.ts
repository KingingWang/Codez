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
  });
});
