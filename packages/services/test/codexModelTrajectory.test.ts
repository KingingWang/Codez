import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import {
  parseCodexRolloutLines,
  readCodexModelTrajectory,
} from "../src/codez-agent/model-trajectory/index.js";

const tempDirs: string[] = [];

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) await rm(dir, { recursive: true, force: true });
  }
});

async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

describe("parseCodexRolloutLines", () => {
  it("projects a Codex turn with outputs, tools, reasoning, usage, and errors", () => {
    const lines = [
      {
        timestamp: "2026-10-19T01:00:00.000Z",
        type: "turn_context",
        payload: { turn_id: "turn-1", model: "gpt-test" },
      },
      {
        timestamp: "2026-10-19T01:00:00.100Z",
        type: "response_item",
        payload: {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "inspect project" }],
          metadata: { client_authored: true },
        },
      },
      {
        timestamp: "2026-10-19T01:00:00.200Z",
        type: "response_item",
        payload: {
          type: "reasoning",
          summary: [{ type: "summary_text", text: "need read" }],
        },
      },
      {
        timestamp: "2026-10-19T01:00:00.300Z",
        type: "response_item",
        payload: {
          type: "function_call",
          call_id: "call_read",
          name: "read_file",
          arguments: '{"path":"/tmp/a.ts"}',
        },
      },
      {
        timestamp: "2026-10-19T01:00:00.400Z",
        type: "response_item",
        payload: {
          type: "function_call_output",
          call_id: "call_read",
          output: "file body",
        },
      },
      {
        timestamp: "2026-10-19T01:00:00.500Z",
        type: "response_item",
        payload: {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "done" }],
        },
      },
      {
        timestamp: "2026-10-19T01:00:00.600Z",
        type: "event_msg",
        payload: {
          type: "token_count",
          info: {
            total_token_usage: {
              input_tokens: 20,
              output_tokens: 5,
              total_tokens: 25,
            },
            last_token_usage: {
              input_tokens: 20,
              output_tokens: 5,
              total_tokens: 25,
            },
          },
        },
      },
      {
        timestamp: "2026-10-19T01:00:00.700Z",
        type: "unknown_future",
        payload: { foo: 1 },
      },
      {
        timestamp: "2026-10-19T01:00:00.800Z",
        type: "event_msg",
        payload: {
          type: "turn_aborted",
          error: { type: "StreamError", message: "disconnected" },
        },
      },
    ].map((line) => JSON.stringify(line));

    const records = parseCodexRolloutLines("task-1", lines);
    expect(records).toHaveLength(1);
    const record = records[0];
    expect(record?.provider).toBe("codex");
    expect(record?.callSource).toEqual({
      kind: "sidecar",
      querySource: "codex_rollout",
    });
    expect(record?.request.messages).toEqual([
      { role: "user", parts: [{ kind: "text", text: "inspect project" }] },
    ]);
    expect(record?.response?.text).toBe("done");
    expect(record?.response?.reasoningText).toBe("need read");
    expect(record?.response?.toolCalls[0]).toMatchObject({
      kind: "tool-call",
      toolCallId: "call_read",
      toolName: "read_file",
      input: { path: "/tmp/a.ts" },
      output: "file body",
    });
    expect(record?.response?.usage).toMatchObject({
      inputTokens: 20,
      outputTokens: 5,
      totalTokens: 25,
    });
    expect(record?.error).toEqual({
      name: "StreamError",
      message: "disconnected",
    });
  });

  it("falls back to cumulative usage deltas and skips unknown event lines", () => {
    const lines = [
      {
        timestamp: "2026-10-19T02:00:00.000Z",
        type: "turn_context",
        payload: { turn_id: "turn-1", model: "gpt-test" },
      },
      {
        timestamp: "2026-10-19T02:00:00.100Z",
        type: "event_msg",
        payload: {
          type: "token_count",
          info: {
            total_token_usage: {
              input_tokens: 10,
              output_tokens: 2,
              total_tokens: 12,
            },
          },
        },
      },
      {
        timestamp: "2026-10-19T02:00:01.000Z",
        type: "turn_context",
        payload: { turn_id: "turn-2", model: "gpt-test" },
      },
      {
        timestamp: "2026-10-19T02:00:01.100Z",
        type: "event_msg",
        payload: {
          type: "token_count",
          info: {
            total_token_usage: {
              input_tokens: 18,
              output_tokens: 5,
              total_tokens: 23,
            },
          },
        },
      },
    ].map((line) => JSON.stringify(line));

    const records = parseCodexRolloutLines("task-1", lines);
    expect(records.map((record) => record.response?.usage?.totalTokens)).toEqual([12, 11]);
  });

  it("starts a projected call at each later user message when one turn_context spans inputs", () => {
    const base = {
      timestamp: "2026-10-19T03:00:00.000Z",
      type: "turn_context",
      payload: { turn_id: "long-turn", model: "gpt-test" },
    };
    const user = (text: string, timestamp: string, clientAuthored = true) => ({
      timestamp,
      type: "response_item",
      payload: {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text }],
        metadata: { client_authored: clientAuthored },
      },
    });
    const records = parseCodexRolloutLines("task-1", [
      JSON.stringify(base),
      JSON.stringify(user("first", "2026-10-19T03:00:01.000Z")),
      JSON.stringify(user("system notification", "2026-10-19T03:00:01.500Z", false)),
      JSON.stringify(user("second", "2026-10-19T03:00:02.000Z")),
    ]);

    expect(records.map((record) => record.request.messages[0]?.parts[0])).toEqual([
      { kind: "text", text: "first" },
      { kind: "text", text: "second" },
    ]);
    expect(records[1]?.requestId).toBe("codex-long-turn-2");
  });
});

describe("readCodexModelTrajectory", () => {
  it("resolves rollout_path from state sqlite", async () => {
    const root = await tempDir("codex-trajectory-sqlite-");
    const rolloutPath = join(root, "rollout-task-sqlite.jsonl");
    await writeFile(rolloutPath, rolloutText("task-sqlite"), "utf8");
    const stateDb = new DatabaseSync(join(root, "state_7.sqlite"));
    try {
      stateDb.exec("CREATE TABLE threads (id TEXT PRIMARY KEY, rollout_path TEXT NOT NULL)");
      stateDb.prepare("INSERT INTO threads VALUES (?, ?)").run("task-sqlite", rolloutPath);
    } finally {
      stateDb.close();
    }

    const trajectory = await readCodexModelTrajectory("task-sqlite", 200, {
      CODEX_HOME: root,
    });
    expect(trajectory.available).toBe(true);
    expect(trajectory.sourceFiles).toEqual([rolloutPath]);
    expect(trajectory.records[0]?.request.messages[0]?.parts).toEqual([
      { kind: "text", text: "hello" },
    ]);
  });

  it("falls back to a bounded sessions filename scan and ignores mismatched session_meta", async () => {
    const root = await tempDir("codex-trajectory-scan-");
    const dayDir = join(root, "sessions", "2026", "10", "19");
    await mkdir(dayDir, { recursive: true });
    const mismatched = join(dayDir, `rollout-not-target.jsonl`);
    const matched = join(dayDir, `rollout-2026-10-19T01-02-03-task-scan.jsonl`);
    await writeFile(mismatched, rolloutText("other-task"), "utf8");
    await writeFile(matched, rolloutText("task-scan"), "utf8");

    const trajectory = await readCodexModelTrajectory("task-scan", 200, {
      CODEX_HOME: root,
    });
    expect(trajectory.sourceFiles).toEqual([matched]);
    expect(trajectory.records).toHaveLength(1);

    const missing = await readCodexModelTrajectory("missing", 200, {
      CODEX_HOME: root,
    });
    expect(missing).toEqual({
      taskId: "missing",
      available: true,
      records: [],
      sourceFiles: [],
      truncated: false,
    });
  });
});

function rolloutText(sessionId: string): string {
  return `${[
    {
      timestamp: "2026-10-19T00:00:00.000Z",
      type: "session_meta",
      payload: { id: sessionId },
    },
    {
      timestamp: "2026-10-19T00:00:01.000Z",
      type: "turn_context",
      payload: { turn_id: `${sessionId}-turn`, model: "gpt-test" },
    },
    {
      timestamp: "2026-10-19T00:00:01.100Z",
      type: "response_item",
      payload: {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "hello" }],
        metadata: { client_authored: true },
      },
    },
  ]
    .map((line) => JSON.stringify(line))
    .join("\n")}\n`;
}
