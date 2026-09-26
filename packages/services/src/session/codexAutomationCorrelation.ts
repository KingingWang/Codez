import type { DatabaseSync } from "node:sqlite";

export const CODEX_AUTOMATION_CORRELATION_STATES = [
  "pending",
  "accepted",
  "unknown",
  "completed",
  "failed",
  "stopped",
] as const;

export type CodexAutomationCorrelationState = (typeof CODEX_AUTOMATION_CORRELATION_STATES)[number];

const legalTransitions: Record<CodexAutomationCorrelationState, ReadonlySet<string>> = {
  pending: new Set(["accepted", "failed", "unknown"]),
  accepted: new Set(["completed", "failed", "stopped"]),
  unknown: new Set(["completed", "failed", "stopped"]),
  completed: new Set(),
  failed: new Set(),
  stopped: new Set(),
};

export function isTerminalCodexAutomationCorrelationState(
  state: CodexAutomationCorrelationState,
): boolean {
  return state === "completed" || state === "failed" || state === "stopped";
}

export interface CodexAutomationCorrelation {
  workspaceKey: string;
  runId: string;
  automationId: string;
  commandId: string;
  state: CodexAutomationCorrelationState;
  threadId?: string;
  turnId?: string;
  error?: string;
  createdAt: number;
  updatedAt: number;
}

interface Row {
  workspace_key: string;
  run_id: string;
  automation_id: string;
  command_id: string;
  state: string;
  thread_id: string | null;
  turn_id: string | null;
  error: string | null;
  created_at: number;
  updated_at: number;
}

function assertState(state: string): asserts state is CodexAutomationCorrelationState {
  if (!CODEX_AUTOMATION_CORRELATION_STATES.includes(state as never)) {
    throw new Error(`Invalid Codex automation correlation state: ${state}`);
  }
}

function rowToCorrelation(row: Row): CodexAutomationCorrelation {
  assertState(row.state);
  return {
    workspaceKey: row.workspace_key,
    runId: row.run_id,
    automationId: row.automation_id,
    commandId: row.command_id,
    state: row.state,
    ...(row.thread_id ? { threadId: row.thread_id } : {}),
    ...(row.turn_id ? { turnId: row.turn_id } : {}),
    ...(row.error ? { error: row.error } : {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class CodexAutomationCorrelationRepo {
  constructor(private readonly db: DatabaseSync) {}

  get(params: { workspaceKey: string; runId: string }): CodexAutomationCorrelation | null {
    const row = this.db
      .prepare(
        "SELECT * FROM codex_automation_correlations WHERE workspace_key = @workspace_key AND run_id = @run_id",
      )
      .get({ workspace_key: params.workspaceKey, run_id: params.runId }) as Row | undefined;
    return row ? rowToCorrelation(row) : null;
  }

  prepare(params: {
    workspaceKey: string;
    runId: string;
    automationId: string;
    threadId: string;
    now: number;
  }): { created: boolean; correlation: CodexAutomationCorrelation } {
    const result = this.db
      .prepare(
        `INSERT INTO codex_automation_correlations (
          workspace_key, run_id, automation_id, command_id, state,
          thread_id, turn_id, error, created_at, updated_at
        ) VALUES (
          @workspace_key, @run_id, @automation_id, @run_id, 'pending',
          @thread_id, NULL, NULL, @now, @now
        )
        ON CONFLICT(workspace_key, run_id) DO NOTHING`,
      )
      .run({
        workspace_key: params.workspaceKey,
        run_id: params.runId,
        automation_id: params.automationId,
        thread_id: params.threadId,
        now: params.now,
      });
    const existing = this.get(params);
    if (!existing) throw new Error("Codex automation correlation insert produced no row");
    return { created: result.changes > 0, correlation: existing };
  }

  transition(params: {
    workspaceKey: string;
    runId: string;
    to: CodexAutomationCorrelationState;
    threadId?: string;
    turnId?: string;
    error?: string;
    requireFrom?: readonly CodexAutomationCorrelationState[];
    now: number;
  }): CodexAutomationCorrelation {
    const existing = this.get(params);
    if (!existing) throw new Error("Codex automation correlation does not exist");
    if (!legalTransitions[existing.state].has(params.to)) return existing;
    if (params.requireFrom && !params.requireFrom.includes(existing.state)) return existing;
    const threadId = params.threadId ?? existing.threadId;
    if (!threadId) {
      throw new Error("Codex automation correlation cannot leave pending without threadId");
    }
    const result = this.db
      .prepare(
        `UPDATE codex_automation_correlations
        SET state = @to,
            thread_id = COALESCE(@thread_id, thread_id),
            turn_id = COALESCE(@turn_id, turn_id),
            error = @error,
            updated_at = @now
        WHERE workspace_key = @workspace_key
          AND run_id = @run_id
          AND state = @from`,
      )
      .run({
        workspace_key: params.workspaceKey,
        run_id: params.runId,
        to: params.to,
        thread_id: threadId,
        turn_id: params.turnId ?? null,
        error: params.error ?? null,
        now: params.now,
        from: existing.state,
      });
    const updated = this.get(params);
    if (!updated || result.changes !== 1) {
      throw new Error("Codex automation correlation transition lost");
    }
    return updated;
  }
}
