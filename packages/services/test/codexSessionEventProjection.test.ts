import assert from "node:assert/strict";
import test from "node:test";
import type { CodezSessionEvent } from "@codez/shared";
import type {
  AssistantTextRow,
  ConversationRow,
  ConversationSnapshot,
  ConversationTopicFrame,
  ReasoningRow,
  SessionPhase,
  ToolCallRow,
  TurnHeaderRow,
  UserInputRow,
} from "@codez/shared/codez-protocol-v4";
import { createCodexSessionEventProjection } from "../src/codez-agent/codexSessionEventProjection.js";

// 投影器是纯函数：v4 快照帧进、legacy session 事件出。这里钉住 Bot 流式回复
// 依赖的全部映射（spec: specs/codex-bot-stream-projection.md），防止编译完成后
// 机器人侧再次「什么都看不到」。

const SESSION_ID = "session-1";

let rowSeq = 0;
function nextRowId(): number {
  rowSeq += 1;
  return rowSeq;
}

function userInputRow(turnId: string, text: string): UserInputRow {
  return {
    rowId: nextRowId(),
    turnId,
    createdAt: 1_700_000_000,
    createdAtSeq: rowSeq,
    kind: "userInput",
    text,
    origin: "realUser",
  };
}

function assistantTextRow(
  turnId: string,
  text: string,
  state: AssistantTextRow["state"] = "streaming",
): AssistantTextRow {
  return {
    rowId: nextRowId(),
    turnId,
    entityId: `msg-${rowSeq}`,
    createdAt: 1_700_000_000,
    createdAtSeq: rowSeq,
    kind: "assistantText",
    text,
    state,
  };
}

function reasoningRow(
  turnId: string,
  text: string,
  state: ReasoningRow["state"] = "streaming",
): ReasoningRow {
  return {
    rowId: nextRowId(),
    turnId,
    entityId: `reason-${rowSeq}`,
    createdAt: 1_700_000_000,
    createdAtSeq: rowSeq,
    kind: "reasoning",
    text,
    state,
  };
}

function toolCallRow(
  turnId: string,
  status: ToolCallRow["status"],
  overrides: Partial<ToolCallRow> = {},
): ToolCallRow {
  return {
    rowId: nextRowId(),
    turnId,
    createdAt: 1_700_000_000,
    createdAtSeq: rowSeq,
    kind: "toolCall",
    toolCallId: `tool-${rowSeq}`,
    toolName: "Bash",
    status,
    inputText: '{"command":"ls"}',
    ...overrides,
  };
}

function turnHeaderRow(turnId: string, state: TurnHeaderRow["state"]): TurnHeaderRow {
  return {
    rowId: nextRowId(),
    turnId,
    createdAt: 1_700_000_000,
    createdAtSeq: rowSeq,
    kind: "turnHeader",
    origin: "userInput",
    state,
    startedAt: 1_700_000_000,
  };
}

function snapshot(
  rows: readonly ConversationRow[],
  phase: SessionPhase,
  lastError: ConversationSnapshot["control"]["lastError"] = null,
): ConversationSnapshot {
  return {
    sessionId: SESSION_ID,
    control: { phase, lastError },
    rows: {
      window: [...rows],
      totalCount: rows.length,
      firstRowId: rows.length > 0 ? rows[0]!.rowId : null,
    },
  } as unknown as ConversationSnapshot;
}

function frame(rows: readonly ConversationRow[], phase: SessionPhase): ConversationTopicFrame {
  return {
    topic: `conversation/${SESSION_ID}`,
    subscriptionId: "sub-1",
    fromSeq: 0,
    toSeq: 1,
    sentAt: Date.now(),
    payload: { kind: "snapshot", snapshot: snapshot(rows, phase) },
  } as unknown as ConversationTopicFrame;
}

function types(events: readonly CodezSessionEvent[]): string[] {
  return events.map((event) =>
    event.type === "model.streaming"
      ? `${event.type}:${(event.payload as { kind: string }).kind}`
      : event.type === "tool.updated"
        ? `${event.type}:${(event.payload as { kind: string }).kind}`
        : event.type,
  );
}

test("fresh turn: userInput starts turn, text growth streams suffix chunks, completion carries response", () => {
  const projection = createCodexSessionEventProjection({ sessionId: SESSION_ID });
  const user = userInputRow("turn-1", "你好");
  const header = turnHeaderRow("turn-1", "running");
  const assistant = assistantTextRow("turn-1", "你");

  const first = projection.acceptFrame(frame([user, header, assistant], "running"));
  assert.deepEqual(types(first), ["turn.started", "model.streaming:text_delta"]);
  const started = first[0]!;
  assert.equal(started.type, "turn.started");
  assert.equal(started.turnId, "turn-1");
  assert.equal((started.payload as { input: string }).input, "你好");
  const chunk = first[1]!;
  assert.equal((chunk.payload as { delta: string }).delta, "你");

  // 文本增长只投增量后缀；assistantMessageId 透传 entityId。
  const grown = { ...assistant, text: "你好，世界" };
  const second = projection.acceptFrame(frame([user, header, grown], "running"));
  assert.deepEqual(types(second), ["model.streaming:text_delta"]);
  assert.equal((second[0]!.payload as { delta: string }).delta, "好，世界");
  assert.equal(
    (second[0]!.payload as { assistantMessageId: string }).assistantMessageId,
    assistant.entityId,
  );

  // 回合完成：response 携带全量正文（adapter 在 chunk 已送达时抑制回投）。
  const doneHeader = { ...header, state: "completedSuccess" as const };
  const doneText = { ...grown, state: "complete" as const };
  const third = projection.acceptFrame(frame([user, doneHeader, doneText], "completedSuccess"));
  assert.deepEqual(types(third), ["turn.completed"]);
  const completed = third[0]!;
  const payload = completed.payload as { response: string; resultType: string };
  assert.equal(payload.response, "你好，世界");
  assert.equal(payload.resultType, "success");
  assert.equal(completed.turnId, "turn-1");
  assert.equal(completed.traceId, "codex-turn-turn-1");
});

test("duplicate snapshot is a no-op (idempotent diff)", () => {
  const projection = createCodexSessionEventProjection({ sessionId: SESSION_ID });
  const rows = [userInputRow("turn-1", "hi"), assistantTextRow("turn-1", "hello")];
  const first = projection.acceptFrame(frame(rows, "running"));
  assert.ok(first.length > 0);
  const again = projection.acceptFrame(frame(rows, "running"));
  assert.deepEqual(again, []);
});

test("first snapshot seeds history silently but streams the live tail", () => {
  const projection = createCodexSessionEventProjection({ sessionId: SESSION_ID });
  const historyUser = userInputRow("turn-0", "old question");
  const historyText = assistantTextRow("turn-0", "old answer", "complete");
  const historyHeader = turnHeaderRow("turn-0", "completedSuccess");
  const liveHeader = turnHeaderRow("turn-1", "running");
  const liveTail = assistantTextRow("turn-1", "partial reply", "streaming");

  const events = projection.acceptFrame(
    frame([historyUser, historyText, historyHeader, liveHeader, liveTail], "running"),
  );
  // 历史回合不补任何事件；live 尾巴发射一次当前累积文本。
  assert.deepEqual(types(events), ["turn.started", "model.streaming:text_delta"]);
  assert.equal((events[1]!.payload as { delta: string }).delta, "partial reply");

  // 历史行后续出现在窗口里也不能再投事件。
  const again = projection.acceptFrame(
    frame([historyUser, historyText, historyHeader, liveHeader, liveTail], "running"),
  );
  assert.deepEqual(again, []);
});

test("tool lifecycle: scheduled → in_progress → result with content", () => {
  const projection = createCodexSessionEventProjection({ sessionId: SESSION_ID });
  const user = userInputRow("turn-1", "run ls");
  const tool = toolCallRow("turn-1", "inputStreaming");

  const first = projection.acceptFrame(frame([user, tool], "running"));
  assert.deepEqual(types(first), ["turn.started", "tool.updated:scheduled"]);
  const scheduled = first[1]!.payload as {
    toolCallId: string;
    toolName: string;
    input: unknown;
  };
  assert.equal(scheduled.toolName, "Bash");
  assert.deepEqual(scheduled.input, { command: "ls" });

  const running = { ...tool, status: "running" as const };
  const second = projection.acceptFrame(frame([user, running], "running"));
  assert.deepEqual(types(second), ["tool.updated:started"]);

  const succeeded = {
    ...tool,
    status: "success" as const,
    output: { text: "file-a\nfile-b" },
    startedAt: 1_700_000_000,
    endedAt: 1_700_000_002,
  };
  const third = projection.acceptFrame(frame([user, succeeded], "running"));
  assert.deepEqual(types(third), ["tool.updated:result"]);
  const result = third[0]!.payload as {
    result: { content: string; success: boolean };
    duration: number;
  };
  assert.equal(result.result.content, "file-a\nfile-b");
  assert.equal(result.result.success, true);
  assert.equal(result.duration, 2000);

  // 终态后不再发射。
  const fourth = projection.acceptFrame(frame([user, succeeded], "running"));
  assert.deepEqual(fourth, []);
});

test("tool error maps to error payload and stays terminal", () => {
  const projection = createCodexSessionEventProjection({ sessionId: SESSION_ID });
  const user = userInputRow("turn-1", "run");
  const tool = toolCallRow("turn-1", "running");
  projection.acceptFrame(frame([user, tool], "running"));

  const failed = {
    ...tool,
    status: "error" as const,
    error: { code: "spawn_failed", message: "command not found" },
  };
  const events = projection.acceptFrame(frame([user, failed], "running"));
  assert.deepEqual(types(events), ["tool.updated:error"]);
  const payload = events[0]!.payload as { error: { message: string; code: string } };
  assert.equal(payload.error.message, "command not found");
  assert.equal(payload.error.code, "spawn_failed");
});

test("phase backstop closes the turn when turnHeader is absent", () => {
  const projection = createCodexSessionEventProjection({ sessionId: SESSION_ID });
  const user = userInputRow("turn-1", "hi");
  const text = assistantTextRow("turn-1", "answer", "complete");
  projection.acceptFrame(frame([user, text], "running"));

  const events = projection.acceptFrame(frame([user, text], "completedSuccess"));
  assert.deepEqual(types(events), ["turn.completed"]);
  assert.equal((events[0]!.payload as { response: string }).response, "answer");
  // 相位停留在终态不重复收口。
  assert.deepEqual(projection.acceptFrame(frame([user, text], "completedSuccess")), []);
});

test("phase error closes the turn with turn.failed carrying lastError", () => {
  const projection = createCodexSessionEventProjection({ sessionId: SESSION_ID });
  const user = userInputRow("turn-1", "hi");
  projection.acceptFrame(frame([user], "running"));

  const failing = snapshot([user], "error", {
    code: "model_not_found",
    message: "model ollama1/deepseek missing",
    recoverable: false,
    at: 1_700_000_000,
    source: "provider",
  });
  const events = projection.acceptFrame({
    topic: `conversation/${SESSION_ID}`,
    subscriptionId: "sub-1",
    fromSeq: 0,
    toSeq: 2,
    sentAt: Date.now(),
    payload: { kind: "snapshot", snapshot: failing },
  } as unknown as ConversationTopicFrame);
  assert.deepEqual(types(events), ["turn.failed"]);
  const payload = events[0]!.payload as {
    error: { type: string; message: string; code: string };
  };
  assert.equal(payload.error.message, "model ollama1/deepseek missing");
  assert.equal(payload.error.code, "model_not_found");
});

test("reasoning rows stream as reasoning_delta", () => {
  const projection = createCodexSessionEventProjection({ sessionId: SESSION_ID });
  const user = userInputRow("turn-1", "think");
  const reasoning = reasoningRow("turn-1", "思考中");
  const events = projection.acceptFrame(frame([user, reasoning], "running"));
  assert.deepEqual(types(events), ["turn.started", "model.streaming:reasoning_delta"]);
  assert.equal((events[1]!.payload as { delta: string }).delta, "思考中");
});

test("a new turn closes the previous one whose terminal frame was missed", () => {
  const projection = createCodexSessionEventProjection({ sessionId: SESSION_ID });
  const turn1User = userInputRow("turn-1", "first");
  const turn1Text = assistantTextRow("turn-1", "a");
  projection.acceptFrame(frame([turn1User, turn1Text], "running"));
  const events = projection.acceptFrame(
    frame(
      [turn1User, turn1Text, turnHeaderRow("turn-2", "running"), userInputRow("turn-2", "second")],
      "running",
    ),
  );
  assert.deepEqual(types(events), ["turn.completed", "turn.started"]);
  const closed = events[0]!;
  assert.equal(closed.turnId, "turn-1");
  assert.equal((closed.payload as { resultType: string }).resultType, "cancelled");
  assert.equal(events[1]!.turnId, "turn-2");
});

test("deltas frames materialize onto the snapshot baseline", () => {
  const projection = createCodexSessionEventProjection({ sessionId: SESSION_ID });
  const user = userInputRow("turn-1", "hi");
  const text = assistantTextRow("turn-1", "he");
  projection.acceptFrame(frame([user, text], "running"));

  // 无基线的 deltas 被丢弃；有基线后 row.delta append 走同一差分。
  const baseline = snapshot([user, text], "running");
  const deltasFrame = {
    topic: `conversation/${SESSION_ID}`,
    subscriptionId: "sub-1",
    fromSeq: 1,
    toSeq: 2,
    sentAt: Date.now(),
    payload: {
      kind: "deltas",
      deltas: [
        { op: "row.delta", rowId: text.rowId, path: "text", append: "llo" },
        {
          op: "state.updated",
          patch: { control: snapshot([user, text], "completedSuccess").control },
        },
      ],
    },
  } as unknown as ConversationTopicFrame;
  void baseline;
  const events = projection.acceptFrame(deltasFrame);
  assert.deepEqual(types(events), ["model.streaming:text_delta", "turn.completed"]);
  assert.equal((events[0]!.payload as { delta: string }).delta, "llo");
});

test("deltas frame without baseline is dropped", () => {
  const projection = createCodexSessionEventProjection({ sessionId: SESSION_ID });
  const deltasFrame = {
    topic: `conversation/${SESSION_ID}`,
    subscriptionId: "sub-1",
    fromSeq: 1,
    toSeq: 2,
    sentAt: Date.now(),
    payload: {
      kind: "deltas",
      deltas: [{ op: "row.delta", rowId: 1, path: "text", append: "x" }],
    },
  } as unknown as ConversationTopicFrame;
  assert.deepEqual(projection.acceptFrame(deltasFrame), []);
});
