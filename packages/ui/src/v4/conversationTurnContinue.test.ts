import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
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

// issue #36 回归：裁决函数正确并不等于入口可见。宿主必须把 handleContinue 接到
// ConversationTimeline —— ConversationTurnGroup 只在收到 onContinue 时才计算中断续跑
// 入口，漏传时快照进入 completedInterrupted 也永不渲染「继续」，而纯函数用例全绿。
// 渲染级骨架（v4SessionPaneEditUserQuery/ReadOnly）当前在本地与 CI 均未生效，
// 因此按仓库既有源码守卫惯用法（v4ConversationTurnGroup.test.ts）在 CI 入口钉住接线。
test("SessionPane 把 handleContinue 接到 ConversationTimeline，并保持 pane 级排除场景", () => {
  const source = readFileSync("packages/ui/src/v4/SessionPane.tsx", "utf8");
  assert.ok(source.includes("<ConversationTimeline"), "SessionPane 必须渲染 ConversationTimeline");
  assert.match(
    source,
    /onContinue=\{continueActionsEnabled \? handleContinue : undefined\}/,
    "ConversationTimeline 必须收到 onContinue，否则中断轮「继续」入口不可达",
  );
  // specs/codex-desktop-interrupted-turn-continue.md：只读分享、writer-conflict、
  // selection-side chat 不显示入口；pane 只给命令能力，行级裁决仍在 row.actions。
  const gateStart = source.indexOf("const continueActionsEnabled =");
  assert.ok(gateStart >= 0, "必须存在 continueActionsEnabled 门禁");
  const gate = source.slice(gateStart, source.indexOf(";", gateStart));
  for (const guard of [
    "runtimeReady",
    "!readOnly",
    "!writerConflictReadOnly",
    "!selectionSideChat",
  ]) {
    assert.ok(gate.includes(guard), `continueActionsEnabled 缺少 ${guard}`);
  }
});

// issue #36：已有会话的原生选模不得重新接到被禁用的 legacy View。
// 这是 CI 接线守卫；真实选择、ACK 与目标 provider 请求另由 native-model-switch 验证。
test("中断后原生选模型使用当前 native catalog，不依赖被禁用的 legacy View", () => {
  const source = readFileSync("packages/ui/src/v4/SessionPane.tsx", "utf8");
  const selectStart = source.indexOf("const handleSelectModel = useCallback(");
  const selectEnd = source.indexOf("const handleSelectThought = useCallback(", selectStart);
  const select = source.slice(selectStart, selectEnd);
  assert.match(
    select,
    /nativeCodexConfig\s*\?\s*codexModels\.catalog\s*\?\s*resolveCodexSelection\(codexModels\.catalog, requestedSelection\)/,
  );
  assert.match(select, /isCodexSelectionReady\(codexModels\.catalog, selection\)/);
  assert.match(select, /dispatchConfigCas\(\s*"switchModelConfig"/);
  assert.match(
    readFileSync("packages/ui/src/v4/composer/useDraftConfigControl.ts", "utf8"),
    /useModelSelectionServiceView\(\s*modelSelectionService,\s*!codexUsesCatalog,/,
    "native 不得为绕过选模失败而重新启用 legacy Registry",
  );
});
