import { array, object, type JsonObject } from "./json.js";
import type { ThreadProjectionState } from "./thread-state-types.js";

/** turn 查找：item/delta 事件只携带 turnId，在已投影历史里定位。 */
export function findNativeTurn(thread: JsonObject, id: unknown): JsonObject | undefined {
  return array(thread.turns)
    .map(object)
    .find((turn) => turn.id === id);
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
  const turn = findNativeTurn(state.thread, params.turnId);
  const item = array(turn?.items)
    .map(object)
    .find((value) => value.id === params.itemId);
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
  } else return false;
  return true;
}
