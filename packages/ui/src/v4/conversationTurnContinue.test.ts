import assert from "node:assert/strict";
import test from "node:test";
import type {
  AssistantTextRow,
  ConversationRow,
  TurnHeaderRow,
  UserInputRow,
} from "@codez/shared/codez-protocol-v4";
import { resolveInterruptedTurnContinueTarget } from "@/v4/conversationTurnContinue.js";
import { buildConversationTurnRenderUnits } from "@/v4/conversationTurnRenderUnits.js";

// 行 fixture 只填裁决真正读取的字段：turnHeader.state 决定终态，
// userInput/assistantText 的 actions.canRetry + entityId 决定目标行。
function turnHeader(rowId: number, turnId: string, state: TurnHeaderRow["state"]): TurnHeaderRow {
  return {
    rowId,
    turnId,
    entityId: `turn-${turnId}`,
    createdAt: 0,
    createdAtSeq: rowId,
    kind: "turnHeader",
    origin: "userInput",
    executionKind: "agent",
    state,
    startedAt: 0,
  };
}

function userInput(rowId: number, turnId: string, actions?: UserInputRow["actions"]): UserInputRow {
  return {
    rowId,
    turnId,
    entityId: `user-${rowId}`,
    createdAt: 0,
    createdAtSeq: rowId,
    kind: "userInput",
    text: "原始 prompt",
    origin: "realUser",
    actions,
  };
}

function assistantText(
  rowId: number,
  turnId: string,
  state: AssistantTextRow["state"],
  actions?: AssistantTextRow["actions"],
): AssistantTextRow {
  return {
    rowId,
    turnId,
    entityId: `assistant-${rowId}`,
    createdAt: 0,
    createdAtSeq: rowId,
    kind: "assistantText",
    text: "partial",
    state,
    actions,
  };
}

/** codex bridge 空闲投影：canRetry 打在 userInput 行，被停止的正文收口为 interrupted。 */
function codexInterruptedRows(): ConversationRow[] {
  return [
    turnHeader(1, "t1", "completedInterrupted"),
    userInput(2, "t1", { canEdit: true, canRetry: true, editDisposition: "rewind" }),
    assistantText(3, "t1", "interrupted"),
  ];
}

function lastUnit(rows: ConversationRow[], sessionPhase: "running" | "completedInterrupted") {
  return buildConversationTurnRenderUnits(rows, { sessionPhase }).at(-1)!;
}

test("手动停止的最后一轮给出 retryTurn 目标行（bridge 把 canRetry 打在 userInput 行）", () => {
  assert.deepEqual(
    resolveInterruptedTurnContinueTarget(lastUnit(codexInterruptedRows(), "completedInterrupted")),
    { rowId: 2, entityId: "user-2" },
  );
});

test("正常完成的轮不出现继续入口", () => {
  const rows: ConversationRow[] = [
    turnHeader(1, "t1", "completedSuccess"),
    userInput(2, "t1", { canEdit: true, canRetry: true, editDisposition: "rewind" }),
    assistantText(3, "t1", "complete", { canFork: true }),
  ];
  assert.equal(
    resolveInterruptedTurnContinueTarget(lastUnit(rows, "completedInterrupted")),
    undefined,
  );
});

test("历史中断轮不给入口：retryTurn 会连带截断其后所有轮次", () => {
  const rows: ConversationRow[] = [
    ...codexInterruptedRows(),
    turnHeader(4, "t2", "completedSuccess"),
    userInput(5, "t2", { canRetry: true }),
    assistantText(6, "t2", "complete"),
  ];
  const units = buildConversationTurnRenderUnits(rows, { sessionPhase: "completedInterrupted" });
  assert.equal(resolveInterruptedTurnContinueTarget(units[0]!), undefined);
});

test("运行中的轮不给入口", () => {
  const rows: ConversationRow[] = [
    turnHeader(1, "t1", "running"),
    userInput(2, "t1", { canRetry: true }),
    assistantText(3, "t1", "streaming"),
  ];
  assert.equal(resolveInterruptedTurnContinueTarget(lastUnit(rows, "running")), undefined);
});

test("行级 canRetry 缺席时不渲染必然被命令层拒绝的按钮", () => {
  const rows: ConversationRow[] = [
    turnHeader(1, "t1", "completedInterrupted"),
    userInput(2, "t1"),
    assistantText(3, "t1", "interrupted"),
  ];
  assert.equal(
    resolveInterruptedTurnContinueTarget(lastUnit(rows, "completedInterrupted")),
    undefined,
  );
});

test("legacy CLI 投影把 canRetry 打在 assistantText 行时同样命中", () => {
  const rows: ConversationRow[] = [
    turnHeader(1, "t1", "completedInterrupted"),
    userInput(2, "t1", { canEdit: true, editDisposition: "rewind" }),
    assistantText(3, "t1", "interrupted", { canRetry: true }),
  ];
  assert.deepEqual(resolveInterruptedTurnContinueTarget(lastUnit(rows, "completedInterrupted")), {
    rowId: 3,
    entityId: "assistant-3",
  });
});
