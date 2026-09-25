import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { mkdtempSync, rmSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import type { ConversationRow } from "@codez/shared/codez-protocol-v4";
import {
  buildCodexAutomationSendTextPayload,
  resolveCodexAutomationHistory,
} from "../src/codez-agent/codexAutomationAdapter.js";
import {
  CodexAutomationCorrelationRepo,
  isTerminalCodexAutomationCorrelationState,
  type CodexAutomationCorrelationState,
} from "../src/session/codexAutomationCorrelation.js";
import { runTasksDatabaseMigrations } from "../src/session/tasksDatabase/migrations.js";

async function createDb() {
  const root = await mkdtemp(join(tmpdir(), "codez-codex-automation-"));
  const db = new DatabaseSync(join(root, "tasks-index.sqlite"));
  runTasksDatabaseMigrations(db);
  return { root, db };
}

function prepare(
  repo: CodexAutomationCorrelationRepo,
  state?: CodexAutomationCorrelationState,
  runId = "automation-1:1000",
) {
  const result = repo.prepare({
    workspaceKey: "workspace-a",
    runId,
    automationId: "automation-1",
    threadId: "thread-1",
    now: 1,
  });
  if (state && state !== "pending") {
    repo.transition({
      workspaceKey: "workspace-a",
      runId,
      to: state === "completed" ? "accepted" : state,
      now: 2,
    });
    if (state === "completed") {
      repo.transition({ workspaceKey: "workspace-a", runId, to: "completed", now: 3 });
    }
  }
  return result.correlation;
}

test("migration 0004 is additive and idempotent on fresh and old databases", () => {
  const root = mkdtempSync(join(tmpdir(), "codez-old-automation-"));
  try {
    const db = new DatabaseSync(join(root, "tasks-index.sqlite"));
    runTasksDatabaseMigrations(db);
    // 模拟一个已停在 0003 的旧库：删除 0004 账本与表，再完整走 runner。
    db.prepare("DELETE FROM tasks_schema_migration WHERE id = ?").run(
      "0004_codex_automation_correlations",
    );
    db.exec("DROP TABLE codex_automation_correlations");
    runTasksDatabaseMigrations(db);
    assert.ok(
      db
        .prepare(
          "SELECT 1 FROM sqlite_master WHERE type='table' AND name='codex_automation_correlations'",
        )
        .get(),
    );
    runTasksDatabaseMigrations(db);
    db.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("correlation primary key enforces workspace and run uniqueness", async () => {
  const { root, db } = await createDb();
  try {
    const repo = new CodexAutomationCorrelationRepo(db);
    assert.equal(
      repo.prepare({
        workspaceKey: "workspace-a",
        runId: "run-1",
        automationId: "automation-1",
        threadId: "thread-1",
        now: 1,
      }).created,
      true,
    );
    assert.equal(
      repo.prepare({
        workspaceKey: "workspace-a",
        runId: "run-1",
        automationId: "automation-1",
        threadId: "thread-2",
        now: 2,
      }).created,
      false,
    );
    assert.equal(repo.get({ workspaceKey: "workspace-a", runId: "run-1" })?.threadId, "thread-1");
    assert.equal(
      repo.prepare({
        workspaceKey: "workspace-b",
        runId: "run-1",
        automationId: "automation-1",
        threadId: "thread-2",
        now: 3,
      }).created,
      true,
    );
    assert.equal(
      db.prepare("SELECT count(*) AS count FROM codex_automation_correlations").get().count,
      2,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("duplicate preparation and terminal transitions are idempotent", async () => {
  const { root, db } = await createDb();
  try {
    const repo = new CodexAutomationCorrelationRepo(db);
    prepare(repo, "accepted");
    const completed = repo.transition({
      workspaceKey: "workspace-a",
      runId: "automation-1:1000",
      to: "completed",
      turnId: "turn-1",
      now: 3,
    });
    assert.equal(completed.state, "completed");
    const lateFailure = repo.transition({
      workspaceKey: "workspace-a",
      runId: "automation-1:1000",
      to: "failed",
      error: "thread deleted",
      now: 4,
    });
    assert.equal(lateFailure.state, "completed");
    assert.equal(lateFailure.updatedAt, 3);
    assert.equal(lateFailure.error, undefined);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("state machine permits only exhaustive legal transitions", async () => {
  const { root, db } = await createDb();
  try {
    const cases: Array<
      [CodexAutomationCorrelationState, CodexAutomationCorrelationState, boolean]
    > = [
      ["pending", "accepted", true],
      ["pending", "failed", true],
      ["pending", "unknown", true],
      ["pending", "completed", false],
      ["accepted", "completed", true],
      ["accepted", "failed", true],
      ["accepted", "unknown", false],
      ["unknown", "completed", true],
      ["unknown", "failed", true],
      ["unknown", "accepted", false],
    ];
    for (const [from, to, legal] of cases) {
      const runId = `automation-${from}-${to}`;
      const fresh = new CodexAutomationCorrelationRepo(db);
      prepare(fresh, from, runId);
      const next = fresh.transition({ workspaceKey: "workspace-a", runId, to, now: 2 });
      assert.equal(next.state === to, legal, `${from} -> ${to}`);
    }
    for (const state of ["completed", "failed"] as const) {
      assert.equal(isTerminalCodexAutomationCorrelationState(state), true);
      for (const to of ["pending", "accepted", "unknown", "completed", "failed"] as const) {
        const runId = `automation-terminal-${state}-${to}`;
        const fresh = new CodexAutomationCorrelationRepo(db);
        prepare(fresh, state, runId);
        const next = fresh.transition({ workspaceKey: "workspace-a", runId, to, now: 2 });
        assert.equal(next.state, state);
      }
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("fresh and migrated databases rerun migration without rewriting rows", async () => {
  const { root, db } = await createDb();
  try {
    const repo = new CodexAutomationCorrelationRepo(db);
    const created = repo.prepare({
      workspaceKey: "workspace-a",
      runId: "run-1",
      automationId: "automation-1",
      threadId: "thread-1",
      now: 1,
    });
    runTasksDatabaseMigrations(db);
    assert.deepEqual(
      repo.get({ workspaceKey: "workspace-a", runId: "run-1" }),
      created.correlation,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("run id projects to command id and no native legacy execution fields are present", async () => {
  const { root, db } = await createDb();
  try {
    const repo = new CodexAutomationCorrelationRepo(db);
    const correlation = repo.prepare({
      workspaceKey: "workspace-a",
      runId: "automation-1:1700000000000",
      automationId: "automation-1",
      threadId: "thread-1",
      now: 1,
    }).correlation;
    assert.equal(correlation.commandId, correlation.runId);
    const nativePayload = buildCodexAutomationSendTextPayload({
      text: "Run nightly check",
      modelSelection: {
        providerId: "openai",
        modelId: "gpt-5",
      },
    });
    assert.equal(nativePayload.modelSelection?.modelId, "gpt-5");
    assert.equal("automationId" in nativePayload, false);
    assert.equal("offPeakTaskId" in nativePayload, false);
    assert.equal("toolDisallowlist" in nativePayload, false);
    assert.equal("modelExecution" in nativePayload, false);
    assert.equal("botDeliveryTarget" in nativePayload, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("history reconciliation matches source command id and terminal state", () => {
  const rows = [
    {
      rowId: 1,
      entityId: "turn-1",
      kind: "turnHeader",
      origin: "userInput",
      visibility: "visible",
      createdAt: 1,
      sourceCommandId: "other-run",
      state: "completedSuccess",
    },
    {
      rowId: 2,
      entityId: "turn-2",
      kind: "turnHeader",
      origin: "userInput",
      visibility: "visible",
      createdAt: 2,
      sourceCommandId: "automation-1:1000",
      state: "failed",
    },
  ] as ConversationRow[];
  assert.deepEqual(resolveCodexAutomationHistory(rows, "automation-1:1000"), {
    admitted: true,
    terminal: true,
    outcome: "failed",
    turnId: undefined,
  });
  assert.equal(resolveCodexAutomationHistory(rows, "missing-run"), null);
});
