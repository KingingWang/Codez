// 中断轮的「继续」恢复入口裁决：能否继续、继续打哪一行。
//
// 状态所有者仍是 codex bridge / CLI 的行级投影：这里只读中断轮事实，
// 不缓存中断态；`canRetry` 只授权回滚，不能作为续做的前提。
import type {
  AssistantTextRow,
  ConversationRow,
  ConversationRowTarget,
  SessionControl,
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
 * 手动 stop 后这一轮以 completedInterrupted 收口，返回供续做按钮识别的稳定行。
 *
 * 原因：旧「继续」借用了 canRetry，点击即 rewind，丢失本轮工具上下文。
 * 续做使用 sendText 新增一轮，只允许最新中断轮，行 ID 仅用于点击时检查旧视图。
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
    // realUser 是本轮稳定可见的首选标识；长工具链尾窗可能只剩工具行。
    ...userRows.filter((row) => row.origin === "realUser"),
    ...userRows.filter((row) => row.origin !== "realUser"),
    ...unit.renderRows.filter(isAssistantTextRow),
    ...unit.renderRows,
  ];
  for (const row of candidates) {
    const entityId = row.entityId;
    if (entityId) return { rowId: row.rowId, entityId };
  }
  return undefined;
}

/** 配置屏障之后、真正发送之前，重新核验按钮看到的中断轮仍是最新一轮。 */
export function isCurrentInterruptedContinueTarget(
  phase: SessionControl["phase"],
  rows: readonly ConversationRow[],
  target: ConversationRowTarget,
): boolean {
  if (phase !== "completedInterrupted") return false;
  const targetRow = rows.find(
    (row) => row.rowId === target.rowId && row.entityId === target.entityId,
  );
  const lastRow = rows.at(-1);
  if (!targetRow || !lastRow || targetRow.turnId !== lastRow.turnId) return false;
  const header = rows.findLast(
    (row) => row.kind === "turnHeader" && row.turnId === targetRow.turnId,
  );
  // 冷恢复尾窗可能裁掉 header；此时以 phase + 最后一行所属 turn 为同一权威降级。
  return !header || (header.kind === "turnHeader" && header.state === "completedInterrupted");
}
