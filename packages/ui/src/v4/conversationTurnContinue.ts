// 中断轮的「继续」恢复入口裁决：能否继续、继续打哪一行。
//
// 状态所有者仍是 codex bridge / CLI 的行级投影：这里只读 `turnHeader.state` 与
// `actions.canRetry`，不缓存中断态、不按 row kind 猜目标，也不另立第二套 phase guard。
import type {
  AssistantTextRow,
  ConversationRow,
  ConversationRowTarget,
  UserInputRow,
} from "@codez/shared/codez-protocol-v4";
import type { ConversationTurnRenderUnit } from "@/v4/conversationTurnRenderUnits.js";

function isUserInputRow(row: ConversationRow): row is UserInputRow {
  return row.kind === "userInput";
}

function isAssistantTextRow(row: ConversationRow): row is AssistantTextRow {
  return row.kind === "assistantText";
}

/**
 * 手动 stop 后这一轮以 completedInterrupted 收口，返回重跑原 prompt 的 retryTurn 目标行。
 *
 * 只允许最后一轮：retryTurn 在 codex bridge 侧等价于 `thread/revert{beforeTurnId}` +
 * 重发原 userMessage，指向历史中断轮会连带截断其后所有轮次。
 * 目标行必须自带 `actions.canRetry` 权威——bridge 空闲态把它打在 userInput 行、
 * legacy CLI 打在最新 assistantText 行，两种投影都由同一裁决命中；
 * 权威缺席时返回 undefined，入口不渲染，不产生必然被命令层拒绝的按钮。
 */
export function resolveInterruptedTurnContinueTarget(
  unit: ConversationTurnRenderUnit,
): ConversationRowTarget | undefined {
  if (!unit.isLastTurn || unit.isRunning) return undefined;
  // turnHeader 是终态权威；冷恢复尾窗裁掉 header 时才回退轮级 workStatus
  //（与 conversationTurnRenderUnits.resolveTurnRunning 同一套降级）。
  const interrupted = unit.header
    ? unit.header.state === "completedInterrupted"
    : unit.workStatus?.state === "interrupted";
  if (!interrupted) return undefined;
  const userRows = unit.renderRows.filter(isUserInputRow);
  const candidates: readonly ConversationRow[] = [
    // 重跑的是「原 user prompt」，realUser 行就是它的 canonical 载体；
    // steer/排队输入与 assistant 行只是同轮其它可重试锚点，按 CLI row 全序兜底。
    ...userRows.filter((row) => row.origin === "realUser"),
    ...userRows.filter((row) => row.origin !== "realUser"),
    ...unit.renderRows.filter(isAssistantTextRow),
  ];
  for (const row of candidates) {
    const entityId = row.entityId;
    if (row.actions?.canRetry === true && entityId) return { rowId: row.rowId, entityId };
  }
  return undefined;
}
