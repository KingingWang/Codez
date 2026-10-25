import { array, object, type JsonObject } from "./json.js";
import { findItemEntry, findItemInTurn, findTurnEntry, noteItemWritten } from "./thread-index.js";
import type { ThreadProjectionState } from "./thread-state-types.js";

/**
 * turn 查找：item/delta 事件只携带 turnId，在已投影历史里定位。
 * 原因：旧实现每条事件都 `array(thread.turns).map(object).find(...)` 线性扫描完整历史，
 * 还会为每一轮分配一次 map 结果数组；改用 thread-index 的增量索引后是 O(1)
 * （索引自愈规则见 thread-index.ts 头部说明）。
 */
export function findNativeTurn(thread: JsonObject, id: unknown): JsonObject | undefined {
  return findTurnEntry(thread, id)?.turn;
}

const LIFECYCLE_STATUS_ITEM_TYPES = new Set(["contextCompaction", "reasoning"]);

/**
 * item/started 与 item/completed 合入 turn.items。
 * 原生 ContextCompaction / Reasoning 不带 status 字段，
 * 按 item/started 与 item/completed 生命周期补充 inProgress / completed。
 */
export function applyNativeItemLifecycle(
  state: ThreadProjectionState,
  threadId: string,
  method: "item/started" | "item/completed",
  params: JsonObject,
  completedItems: Set<string>,
): boolean {
  const turnEntry = findTurnEntry(state.thread, params.turnId);
  if (!turnEntry) return false;
  const turn = turnEntry.turn;
  if (state.apiRetry?.turnId === params.turnId) state.apiRetry = null;
  const items = array(turn.items);
  const rawItem = object(params.item);
  const item =
    typeof rawItem.type === "string" && LIFECYCLE_STATUS_ITEM_TYPES.has(rawItem.type)
      ? { ...rawItem, status: method === "item/started" ? "inProgress" : "completed" }
      : rawItem;
  const itemKey = JSON.stringify([threadId, params.turnId, item.id]);
  if (method === "item/started" && completedItems.has(itemKey)) return false;
  if (method === "item/completed") completedItems.add(itemKey);
  // 索引定位替代 items.findIndex 的线性扫描；未命中即 -1，与旧语义一致。
  const index = findItemInTurn(turnEntry, item.id)?.index ?? -1;
  if (index < 0) items.push(item);
  else items[index] = item;
  turn.items = items;
  // 写入后同步索引，下一条同 item 的 delta 仍是 O(1)（而不是触发一次重建）。
  noteItemWritten(turnEntry, index < 0 ? items.length - 1 : index, item);
  return true;
}

/**
 * 流式 delta 合入已收 item。返回 true 表示已应用（调用方继续 touch 收尾）；
 * false 表示事件被跳过（已完成 item 的迟到 delta / 未知 delta 类型），调用方直接 return。
 */
export function applyNativeItemDelta(
  state: ThreadProjectionState,
  method: string,
  params: JsonObject,
  completedItems: ReadonlySet<string>,
): boolean {
  if (completedItems.has(JSON.stringify([params.threadId, params.turnId, params.itemId])))
    return false;
  // 同上：turnId/itemId 定位走增量索引，delta 直接原地合入数组里的同一 item 对象。
  const item = findItemEntry(state.thread, params.turnId, params.itemId)?.item;
  if (!item || typeof params.delta !== "string") return false;
  if (state.apiRetry?.turnId === params.turnId) state.apiRetry = null;
  if (method === "item/agentMessage/delta" || method === "item/plan/delta") {
    item.text = String(item.text ?? "") + params.delta;
  } else if (method === "item/commandExecution/outputDelta") {
    item.aggregatedOutput = String(item.aggregatedOutput ?? "") + params.delta;
  } else if (method === "item/reasoning/summaryTextDelta") {
    const summary = array(item.summary);
    const index = typeof params.summaryIndex === "number" ? params.summaryIndex : 0;
    summary[index] = String(summary[index] ?? "") + params.delta;
    item.summary = summary;
  } else if (method === "item/reasoning/textDelta") {
    // Chat Completions / Anthropic 以及 Responses raw reasoning 流通过
    // item/reasoning/textDelta 下发流式思考正文；合入 item.content[contentIndex]，
    // 让流式期间即可实时渲染思考内容（item/completed 时会被完整 item 替换）。
    const content = array(item.content);
    const index = typeof params.contentIndex === "number" ? params.contentIndex : 0;
    content[index] = String(content[index] ?? "") + params.delta;
    item.content = content;
  } else return false;
  return true;
}
