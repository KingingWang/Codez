import {
  PROTOCOL_V4_LIMITS as limits,
  type ConversationRow,
} from "@codez/shared/codez-protocol-v4";

// 字节上限取逻辑帧组装预算的 1/4：尾窗每帧都随投影变更重发，必须显式限带宽，
// 同时给信封与分片留足余量。工具输出可达 64KiB/行，所以字节上限会先于行数上限生效。
const anchorByteBudget = Math.floor(limits.logicalFrameAssemblyMaxBytes / 4);
// 行数上限是安全网：原生修复 itemId 复用后一轮的思考/正文行数会翻数倍，
// 必须容得下一个长轮次的完整叙事；跨轮回溯仍由客户端 rows/range 负责。
const anchorMaxRows = limits.snapshotTailWindowRows * 16;

/** 尾窗回溯预算；省略即用生产默认值，测试可注入小预算覆盖截断分支。 */
export interface TailWindowBudget {
  /** 向前补齐后的窗口行数上限。 */
  maxRows?: number;
  /** 整个窗口的序列化字节上限。 */
  maxBytes?: number;
}

function rowBytes(row: ConversationRow): number {
  return Buffer.byteLength(JSON.stringify(row), "utf8");
}

/** 轮次首行就是 turnHeader（projectRows 每轮先 push header），从 start 往前在同一轮里找它。 */
function leadingTurnHeaderIndex(
  rows: readonly ConversationRow[],
  turnId: string,
  start: number,
): number | null {
  for (let index = start - 1; index >= 0; index--) {
    const row = rows[index];
    if (!row || row.turnId !== turnId) return null;
    if (row.kind === "turnHeader") return index;
  }
  return null;
}

/**
 * 下发用尾窗：基础是尾部 snapshotTailWindowRows 行，再在行数/字节双上限内向前补齐到
 * 「基础尾窗已覆盖的最早轮次」的首行。
 *
 * 为什么必须按 turn 边界对齐：codex flavor 没有 delta 重放日志，每次投影变更都重发全量
 * 快照，客户端规则 1 是整体替换，所以 loadOlder 补拉的更早行会被下一帧抹掉——尾窗必须
 * 自带它已覆盖轮次的完整叙事。只按行数截尾时，一个工具调用密集的长轮次会把 turnHeader /
 * userInput / reasoning / assistantText 全部挤出窗口（原生 Chat/Anthropic SSE 复用
 * itemId，整轮思考与正文还被折叠钉在轮首），用户在自动置底的视图里只看得到工具行，
 * 直到该轮结束也看不到回答。
 *
 * 窗口保持 rowId 连续：loadOlder 只从窗口首行向前取，中间挖洞永远补不回来。唯一例外是
 * 上限截断时仍保留覆盖轮的 turnHeader——缺 header 会让客户端每帧都判定「首 turn 不完整」
 * 而反复补拉，与每帧全量快照形成风暴。
 */
export function projectConversationTailWindow(
  rows: readonly ConversationRow[],
  budget: TailWindowBudget = {},
): ConversationRow[] {
  const limit = limits.snapshotTailWindowRows;
  if (rows.length <= limit) return [...rows];
  const maxRows = budget.maxRows ?? anchorMaxRows;
  const base = rows.length - limit;
  const baseRow = rows[base];
  if (!baseRow) return [...rows];
  const turnId = baseRow.turnId;
  // 基础尾窗是必须下发的部分，先扣掉它的字节，剩余额度才用于向前补齐。
  let room =
    (budget.maxBytes ?? anchorByteBudget) -
    rows.slice(base).reduce((total, row) => total + rowBytes(row), 0);
  let start = base;
  for (let index = base - 1; index >= 0 && room > 0; index--) {
    const row = rows[index];
    // 不跨轮：更早的轮次属于客户端 rows/range 分页，不属于实时尾窗。
    if (!row || row.turnId !== turnId) break;
    if (rows.length - index > maxRows) break;
    const bytes = rowBytes(row);
    if (bytes > room) break;
    room -= bytes;
    start = index;
  }
  if (start === 0) return [...rows];
  const header = leadingTurnHeaderIndex(rows, turnId, start);
  return header !== null && header < start
    ? [rows[header]!, ...rows.slice(start)]
    : rows.slice(start);
}
