import assert from "node:assert/strict";
import test from "node:test";
import type {
  AssistantTextRow,
  ConversationRow,
  TurnHeaderRow,
  UserInputRow,
} from "@codez/shared/codez-protocol-v4";
import {
  isCurrentInterruptedContinueTarget,
  resolveInterruptedTurnContinueTarget,
} from "@/v4/conversationTurnContinue.js";
import { buildConversationTurnRenderUnits } from "@/v4/conversationTurnRenderUnits.js";

// 行 fixture 只填裁决真正读取的字段：turnHeader.state 决定终态，
// userInput/assistantText 的 entityId 用于在发送前识别被中断轮。
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

test("手动停止的最后一轮给出续做目标行", () => {
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

test("历史中断轮不给入口：只能继续当前最后一轮", () => {
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

test("续做不依赖用于回滚重试的 canRetry 权限", () => {
  const rows: ConversationRow[] = [
    turnHeader(1, "t1", "completedInterrupted"),
    userInput(2, "t1"),
    assistantText(3, "t1", "interrupted"),
  ];
  assert.deepEqual(resolveInterruptedTurnContinueTarget(lastUnit(rows, "completedInterrupted")), {
    rowId: 2,
    entityId: "user-2",
  });
});

test("legacy CLI 的中断轮优先用原始 userInput 标识，不读取 assistant 的重试权限", () => {
  const rows: ConversationRow[] = [
    turnHeader(1, "t1", "completedInterrupted"),
    userInput(2, "t1", { canEdit: true, editDisposition: "rewind" }),
    assistantText(3, "t1", "interrupted", { canRetry: true }),
  ];
  assert.deepEqual(resolveInterruptedTurnContinueTarget(lastUnit(rows, "completedInterrupted")), {
    rowId: 2,
    entityId: "user-2",
  });
});

test("异步配置屏障后仅最新中断轮可继续，旧行和新运行轮均不得发送", () => {
  const rows = codexInterruptedRows();
  const target = { rowId: 2, entityId: "user-2" };
  assert.equal(isCurrentInterruptedContinueTarget("completedInterrupted", rows, target), true);
  assert.equal(
    isCurrentInterruptedContinueTarget("completedInterrupted", rows, {
      rowId: 2,
      entityId: "stale",
    }),
    false,
  );
  assert.equal(isCurrentInterruptedContinueTarget("running", rows, target), false);
  assert.equal(
    isCurrentInterruptedContinueTarget(
      "completedInterrupted",
      [...rows, turnHeader(4, "t2", "completedInterrupted"), userInput(5, "t2")],
      target,
    ),
    false,
  );
});

test("长工具链的尾窗只剩工具行时仍可继续，且点击目标属于当前中断轮", () => {
  const tool: ConversationRow = {
    rowId: 77,
    turnId: "t1",
    entityId: "tool-77",
    createdAt: 0,
    createdAtSeq: 77,
    kind: "toolCall",
    toolCallId: "completed-tool",
    toolName: "Bash",
    status: "success",
    inputText: "pwd",
    output: { text: "/workspace" },
  };
  const unit = lastUnit([tool], "completedInterrupted");
  const target = resolveInterruptedTurnContinueTarget(unit);
  assert.deepEqual(target, { rowId: 77, entityId: "tool-77" });
  assert.equal(isCurrentInterruptedContinueTarget("completedInterrupted", [tool], target!), true);
  assert.equal(
    isCurrentInterruptedContinueTarget(
      "completedInterrupted",
      [turnHeader(1, "older", "completedSuccess"), tool],
      target!,
    ),
    true,
  );
});
