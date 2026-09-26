import assert from "node:assert/strict";
import test from "node:test";
import type { ConversationRow } from "@codez/shared/codez-protocol-v4";
import {
  assertCodexScheduledPromptCapability,
  codexCorrelationStateFromRunOutcome,
  codexRunOutcomeFromCorrelationState,
  reconcileCodexAutomationHistory,
} from "../src/host/codexAutomationCorrelation.js";

function hello(capability?: string) {
  return {
    helloConversationV4: async () => ({
      capabilities: {
        ...(capability ? { codex: { scheduledPromptAutomations: capability } } : undefined),
      },
    }),
  } as unknown as Parameters<typeof assertCodexScheduledPromptCapability>[0];
}

function turnRow(
  state: "running" | "completedSuccess" | "completedInterrupted" | "failed",
  rowId: number,
  sourceCommandId = "run-1",
): ConversationRow {
  return {
    rowId,
    entityId: `turn-${rowId}`,
    kind: "turnHeader",
    origin: "userInput",
    visibility: "visible",
    createdAt: rowId,
    sourceCommandId,
    state,
  } as ConversationRow;
}

test("scheduled prompt automation capability gates missing and degraded states", async () => {
  await assert.doesNotReject(assertCodexScheduledPromptCapability(hello("supported")));
  await assert.rejects(
    assertCodexScheduledPromptCapability(hello("degraded")),
    /unavailable \(degraded\)/u,
  );
  await assert.rejects(
    assertCodexScheduledPromptCapability(hello(undefined)),
    /unavailable \(missing capability\)/u,
  );
});

test("live and restored correlation keep a stopped automation distinct from success", () => {
  assert.equal(codexCorrelationStateFromRunOutcome("succeeded"), "completed");
  assert.equal(codexCorrelationStateFromRunOutcome("stopped"), "stopped");
  assert.equal(codexCorrelationStateFromRunOutcome("failed"), "failed");
  assert.equal(codexRunOutcomeFromCorrelationState("stopped"), "stopped");
  assert.equal(codexRunOutcomeFromCorrelationState("completed"), "succeeded");
  assert.equal(codexRunOutcomeFromCorrelationState("failed"), "failed");
});

test("reconciliation restores interrupted history by matching the run id", async () => {
  const result = await reconcileCodexAutomationHistory({
    agentService: {
      async conversationRowsRangeV4() {
        return {
          rows: [turnRow("completedSuccess", 2, "other-run"), turnRow("completedInterrupted", 1)],
          hasMore: false,
        };
      },
    },
    workspacePath: "/workspace",
    threadId: "thread-1",
    commandId: "run-1",
  });
  assert.deepEqual(result, {
    kind: "resolved",
    resolution: { admitted: true, terminal: true, outcome: "stopped", turnId: undefined },
  });
});

test("history reconciliation pages authoritative rows and resolves terminal turns", async () => {
  const requests: number[] = [];
  const agentService = {
    async conversationRowsRangeV4(params: { beforeRowId?: number; limit: number }) {
      requests.push(params.beforeRowId ?? -1);
      return params.beforeRowId === undefined
        ? {
            rows: [turnRow("running", 210, "other-run")],
            hasMore: true,
          }
        : {
            rows: [turnRow("completedSuccess", 10)],
            hasMore: false,
          };
    },
  };

  const result = await reconcileCodexAutomationHistory({
    agentService,
    workspacePath: "/workspace",
    threadId: "thread-1",
    commandId: "run-1",
  });

  assert.deepEqual(result, {
    kind: "resolved",
    resolution: { admitted: true, terminal: true, outcome: "completed", turnId: undefined },
  });
  assert.deepEqual(requests, [-1, 210]);
});

test("history reconciliation distinguishes no evidence, transient failure, and deleted threads", async () => {
  const missing = await reconcileCodexAutomationHistory({
    agentService: {
      async conversationRowsRangeV4() {
        return { rows: [], hasMore: false };
      },
    },
    workspacePath: "/workspace",
    threadId: "thread-1",
    commandId: "run-1",
  });
  assert.deepEqual(missing, { kind: "missing" });

  const transient = await reconcileCodexAutomationHistory({
    agentService: {
      async conversationRowsRangeV4() {
        throw new Error("connection reset");
      },
    },
    workspacePath: "/workspace",
    threadId: "thread-1",
    commandId: "run-1",
  });
  assert.equal(transient.kind, "unavailable");

  const inactive = await reconcileCodexAutomationHistory({
    agentService: {
      async conversationRowsRangeV4() {
        throw new Error("Session is not active: thread-1");
      },
    },
    workspacePath: "/workspace",
    threadId: "thread-1",
    commandId: "run-1",
  });
  assert.equal(inactive.kind, "unavailable");

  const deleted = await reconcileCodexAutomationHistory({
    agentService: {
      async conversationRowsRangeV4() {
        throw new Error("Thread was deleted; refresh the session list");
      },
    },
    workspacePath: "/workspace",
    threadId: "thread-1",
    commandId: "run-1",
  });
  assert.equal(deleted.kind, "unrecoverable");
});
