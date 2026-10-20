import {
  PROTOCOL_V4_LIMITS as limits,
  type ConversationRow,
} from "@codez/shared/codez-protocol-v4";

// 字节上限取逻辑帧组装预算的 1/4：尾窗每帧都随投影变更重发，必须显式限带宽，
// 同时给信封与分片留足余量。
const anchorByteBudget = Math.floor(limits.logicalFrameAssemblyMaxBytes / 4);
// 行数上限是安全网：原生修复 itemId 复用后一轮的思考/正文行数会翻数倍，
// 必须容得下一个长轮次的完整叙事；跨轮回溯仍由客户端 rows/range 负责。
const anchorMaxRows = limits.snapshotTailWindowRows * 16;

/** 用户阅读的行；工具行是可折叠的批量内容，预算不足时先牺牲工具行。 */
const NARRATIVE_ROW_KINDS = new Set(["turnHeader", "userInput", "reasoning", "assistantText"]);

/** 尾窗回溯预算；省略即用生产默认值，测试可注入小预算覆盖截断分支。 */
export interface TailWindowBudget {
  /** 向前补齐后的窗口行数上限。 */
  maxRows?: number;
  /** 整个窗口的序列化字节上限。 */
  maxBytes?: number;
  /** 叙事行的专属字节预算；与 maxBytes 分开计账，避免被工具行挤占。 */
  narrativeMaxBytes?: number;
}

function rowBytes(row: ConversationRow): number {
  return Buffer.byteLength(JSON.stringify(row), "utf8");
}

function isNarrativeRow(row: ConversationRow): boolean {
  return NARRATIVE_ROW_KINDS.has(row.kind);
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
 * 下发用尾窗：基础是尾部 snapshotTailWindowRows 行，再在行数/字节上限内向前补齐到
 * 「基础尾窗已覆盖的最早轮次」的首行。
 *
 * 为什么必须按 turn 边界对齐：codex flavor 没有 delta 重放日志，每次投影变更都重发全量
 * 快照，客户端规则 1 是整体替换，所以 loadOlder 补拉的更早行会被下一帧抹掉——尾窗必须
 * 自带它已覆盖轮次的完整叙事。只按行数截尾时，一个工具调用密集的长轮次会把 turnHeader /
 * userInput / reasoning / assistantText 全部挤出窗口（原生 Chat/Anthropic SSE 复用
 * itemId，整轮思考与正文还被折叠钉在轮首），用户在自动置底的视图里只看得到工具行，
 * 直到该轮结束也看不到回答。
 *
 * 补齐顺序有优先级：工具行只在总字节预算内向前连续扩展；预算耗尽后仍继续扫描同一轮，
 * 把剩下的叙事行单独收进窗口头部。代价是工具序列可能出现 rowId 空洞——协议对此是安全的
 * （apply.ts 对未加载 rowId 的 upsert 是 no-op，row.removed 按 rowId 过滤，渲染单元按
 * turnId 分组），而丢掉用户消息/思考/正文的代价远大于丢掉一段可折叠的工具历史。
 *
 * 唯一强制保留的额外行是覆盖轮的 turnHeader：缺 header 会让客户端每帧都判定「首 turn
 * 不完整」而反复补拉，与每帧全量快照形成风暴。
 */
export function projectConversationTailWindow(
  rows: readonly ConversationRow[],
  budget: TailWindowBudget = {},
): ConversationRow[] {
  const limit = limits.snapshotTailWindowRows;
  if (rows.length <= limit) return [...rows];
  const maxRows = budget.maxRows ?? anchorMaxRows;
  const maxBytes = budget.maxBytes ?? anchorByteBudget;
  // 叙事行单独预留一半预算。工具行终态 output 按 toolOutputFinalHead+Tail 截断后单条仍可达
  // 64KiB，而基础尾窗的 60 行是必须下发的：重工具轮次光基础窗就能吃掉 ~3.75MiB，若叙事行与
  // 工具行共用同一预算，补齐额度会被饿死到 0，表现退回「整轮只剩工具行、用户消息与思考全丢」。
  // 叙事行是用户真正阅读的内容且体量小（实测一整轮 217 行里叙事只占 20KiB），优先牺牲工具行。
  const narrativeMaxBytes = budget.narrativeMaxBytes ?? Math.floor(maxBytes / 2);
  const base = rows.length - limit;
  const baseRow = rows[base];
  if (!baseRow) return [...rows];
  const turnId = baseRow.turnId;
  // 基础尾窗是必须下发的部分，先扣掉它的字节，剩余额度才用于向前补齐。
  let room = maxBytes - rows.slice(base).reduce((total, row) => total + rowBytes(row), 0);
  let narrativeRoom = narrativeMaxBytes;
  let contiguousStart = base;
  let taken = rows.length - base;
  // 基础窗自身就可能超预算（60 行重工具 ≈ 3.75MiB）；此时只收叙事行。
  let toolsExhausted = room <= 0;
  const head: ConversationRow[] = [];

  for (let index = base - 1; index >= 0; index--) {
    const row = rows[index];
    // 不跨轮：更早的轮次属于客户端 rows/range 分页，不属于实时尾窗。
    if (!row || row.turnId !== turnId) break;
    if (taken >= maxRows) break;
    const narrative = isNarrativeRow(row);
    // 工具预算耗尽后只继续收叙事行；跳过工具行时不序列化，避免每帧重复计字节。
    if (!narrative && toolsExhausted) continue;
    const bytes = rowBytes(row);
    if (narrative) {
      // 叙事预算也用尽就停止扩展：再往前的叙事行同样放不下，保留已收部分。
      if (bytes > narrativeRoom) break;
      narrativeRoom -= bytes;
      room -= bytes;
      taken += 1;
      if (toolsExhausted) head.unshift(row);
      else contiguousStart = index;
      continue;
    }
    if (bytes > room) {
      toolsExhausted = true;
      continue;
    }
    room -= bytes;
    taken += 1;
    contiguousStart = index;
  }

  if (contiguousStart === 0) return [...rows];
  const window = rows.slice(contiguousStart);
  const headerIndex = leadingTurnHeaderIndex(rows, turnId, contiguousStart);
  if (headerIndex === null) return [...head, ...window];
  const header = rows[headerIndex]!;
  const alreadyKept = head.some((row) => row.rowId === header.rowId);
  return alreadyKept ? [...head, ...window] : [header, ...head, ...window];
}
