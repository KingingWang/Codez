import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { queryCodexAppUsageStats } from "../src/codex-app-usage.js";

const DAY_MS = 86_400_000;

async function createFixtureCodexHome(now: number): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "codex-app-usage-"));
  const rolloutDir = join(root, "sessions", "2026", "10", "18");
  await mkdir(rolloutDir, { recursive: true });

  const rolloutAlphaPath = join(rolloutDir, "rollout-thread-alpha.jsonl");
  const day1Iso = new Date(now - DAY_MS).toISOString();
  const day2Iso = new Date(now - 2 * DAY_MS).toISOString();

  // Thread alpha: 2 turns across 2 days, switching models from gpt-5.4 to gemini-4-argon
  const rolloutLines = [
    JSON.stringify({
      timestamp: day2Iso,
      ordinal: 1,
      type: "turn_context",
      payload: {
        turn_id: "turn-1",
        model: "gpt-5.4",
      },
    }),
    JSON.stringify({
      timestamp: day2Iso,
      ordinal: 2,
      type: "event_msg",
      payload: {
        type: "token_count",
        info: {
          total_token_usage: {
            input_tokens: 1000,
            cached_input_tokens: 400,
            cache_write_input_tokens: 0,
            output_tokens: 200,
            reasoning_output_tokens: 50,
            total_tokens: 1200,
          },
          last_token_usage: {
            input_tokens: 1000,
            cached_input_tokens: 400,
            cache_write_input_tokens: 0,
            output_tokens: 200,
            reasoning_output_tokens: 50,
            total_tokens: 1200,
          },
        },
      },
    }),
    JSON.stringify({
      timestamp: day1Iso,
      ordinal: 3,
      type: "turn_context",
      payload: {
        turn_id: "turn-2",
        model: "gemini-4-argon",
      },
    }),
    JSON.stringify({
      timestamp: day1Iso,
      ordinal: 4,
      type: "event_msg",
      payload: {
        type: "token_count",
        info: {
          total_token_usage: {
            input_tokens: 3000,
            cached_input_tokens: 1400,
            cache_write_input_tokens: 0,
            output_tokens: 500,
            reasoning_output_tokens: 100,
            total_tokens: 3500,
          },
          last_token_usage: {
            input_tokens: 2000,
            cached_input_tokens: 1000,
            cache_write_input_tokens: 0,
            output_tokens: 300,
            reasoning_output_tokens: 50,
            total_tokens: 2300,
          },
        },
      },
    }),
  ];
  await writeFile(rolloutAlphaPath, `${rolloutLines.join("\n")}\n`, "utf8");

  const stateDb = new DatabaseSync(join(root, "state_5.sqlite"));
  try {
    stateDb.exec(`
      CREATE TABLE threads (
        id TEXT PRIMARY KEY,
        rollout_path TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        created_at_ms INTEGER,
        updated_at INTEGER NOT NULL,
        updated_at_ms INTEGER,
        model TEXT,
        tokens_used INTEGER NOT NULL DEFAULT 0
      );
    `);
    const insertThread = stateDb.prepare(`
      INSERT INTO threads (id, rollout_path, created_at, created_at_ms, updated_at, updated_at_ms, model, tokens_used)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    // Thread 1 with rollout file
    insertThread.run(
      "thread-alpha",
      rolloutAlphaPath,
      Math.trunc((now - 2 * DAY_MS) / 1000),
      now - 2 * DAY_MS,
      Math.trunc((now - DAY_MS) / 1000),
      now - DAY_MS,
      "gemini-4-argon",
      3500,
    );
    // Thread 2 without rollout file (archived/cleaned), 15 days ago
    insertThread.run(
      "thread-legacy",
      join(rolloutDir, "missing-rollout.jsonl"),
      Math.trunc((now - 15 * DAY_MS) / 1000),
      now - 15 * DAY_MS,
      Math.trunc((now - 15 * DAY_MS) / 1000),
      now - 15 * DAY_MS,
      "claude-opus-5",
      5000,
    );
  } finally {
    stateDb.close();
  }

  const historyDb = new DatabaseSync(join(root, "thread_history_1.sqlite"));
  try {
    historyDb.exec(`
      CREATE TABLE thread_turns (
        thread_id TEXT NOT NULL,
        turn_id TEXT NOT NULL,
        started_at INTEGER,
        completed_at INTEGER,
        duration_ms INTEGER,
        PRIMARY KEY (thread_id, turn_id)
      );
    `);
    const insertTurn = historyDb.prepare(`
      INSERT INTO thread_turns (thread_id, turn_id, started_at, completed_at, duration_ms)
      VALUES (?, ?, ?, ?, ?)
    `);
    insertTurn.run(
      "thread-alpha",
      "turn-1",
      Math.trunc((now - 2 * DAY_MS) / 1000),
      Math.trunc((now - 2 * DAY_MS) / 1000) + 120,
      120_000,
    );
    insertTurn.run(
      "thread-alpha",
      "turn-2",
      Math.trunc((now - DAY_MS) / 1000),
      Math.trunc((now - DAY_MS) / 1000) + 180,
      180_000,
    );
  } finally {
    historyDb.close();
  }

  return root;
}

test("queryCodexAppUsageStats aggregates rollout per-turn model usage and SQLite fallback", async () => {
  const now = Date.parse("2026-10-18T12:00:00.000Z");
  const codexHome = await createFixtureCodexHome(now);
  try {
    const env = { CODEX_HOME: codexHome };
    const snapshot7d = await queryCodexAppUsageStats(
      { range: "7d", timeZone: "UTC" },
      { env, now },
    );

    assert.equal(snapshot7d.range, "7d");
    assert.equal(snapshot7d.summary.totalTokens, 3500);
    assert.equal(snapshot7d.summary.inputTokens, 3000);
    assert.equal(snapshot7d.summary.outputTokens, 500);
    assert.equal(snapshot7d.summary.cacheReadTokens, 1400);
    assert.equal(snapshot7d.summary.longestSessionMs, 300_000);
    assert.equal(snapshot7d.models.length, 2);
    assert.deepEqual(
      snapshot7d.models.map((m) => ({
        modelId: m.modelId,
        totalTokens: m.totalTokens,
        inputTokens: m.inputTokens,
        outputTokens: m.outputTokens,
        cacheReadTokens: m.cacheReadTokens,
      })),
      [
        {
          modelId: "gemini-4-argon",
          totalTokens: 2300,
          inputTokens: 2000,
          outputTokens: 300,
          cacheReadTokens: 1000,
        },
        {
          modelId: "gpt-5.4",
          totalTokens: 1200,
          inputTokens: 1000,
          outputTokens: 200,
          cacheReadTokens: 400,
        },
      ],
    );

    const snapshot30d = await queryCodexAppUsageStats(
      { range: "30d", timeZone: "UTC" },
      { env, now },
    );
    assert.equal(snapshot30d.summary.totalTokens, 8500);
    assert.equal(snapshot30d.models.length, 3);
    assert.equal(snapshot30d.models[0]?.modelId, "claude-opus-5");
    assert.equal(snapshot30d.models[0]?.totalTokens, 5000);
  } finally {
    await rm(codexHome, { recursive: true, force: true });
  }
});
