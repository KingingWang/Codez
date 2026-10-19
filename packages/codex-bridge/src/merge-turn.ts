import { array, object, string, type JsonObject } from "./json.js";

/** Merge the paginated history and live item stream without replacing a whole turn. */
export function mergeNativeTurn(previous: JsonObject, incoming: JsonObject): JsonObject {
  const preserveTerminal =
    previous.status && previous.status !== "inProgress" && incoming.status === "inProgress";
  const first = preserveTerminal ? incoming : previous;
  const last = preserveTerminal ? previous : incoming;
  const items = new Map(array(first.items).map((item) => [string(object(item).id), item]));
  for (const item of array(last.items)) items.set(string(object(item).id), item);
  // 生命周期 summary 的空 items 不代表删除；full 由分页或当前 item 流确立。
  return {
    ...first,
    ...last,
    itemsView:
      previous.itemsView === "full" || incoming.itemsView === "full" ? "full" : last.itemsView,
    items: [...items.values()],
  };
}
