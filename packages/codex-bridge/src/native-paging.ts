import type { CodexRpcPort } from "./contract.js";
import { array, object, string } from "./json.js";
import { CodexTransportError } from "./rpc-errors.js";

/** 分页链路标签：重复游标报错时指明是哪条原生读取。 */
export type NativePageLabel = "history" | "queue" | "thread";
const DEFAULT_PAGE_LIMIT = 100;
const OVERSIZED_ITEM_PAGE_LIMIT = 32;

function oversizedNativeResponse(error: unknown): boolean {
  return (
    error instanceof CodexTransportError &&
    error.code === "LIMIT" &&
    error.message === "Codex response frame exceeds size limit"
  );
}

/**
 * 通过只读 `thread/items/list` 分页补全单个 turn 的完整 items。
 * 校验 item 归属 turnId、重复 itemId、空页带 cursor 与重复 cursor，避免异常游标死循环。
 */
export async function hydrateNativeTurnItems(
  rpc: CodexRpcPort,
  threadId: unknown,
  turnId: string,
): Promise<unknown[]> {
  const items: unknown[] = [];
  const ids = new Set<string>();
  const seenCursors = new Set<string>();
  let itemCursor: string | undefined;
  let itemLimit = OVERSIZED_ITEM_PAGE_LIMIT;
  do {
    let itemPage: Record<string, unknown>;
    while (true) {
      try {
        itemPage = object(
          await rpc.request("thread/items/list", {
            threadId,
            turnId,
            cursor: itemCursor,
            sortDirection: "asc",
            limit: itemLimit,
          }),
        );
        break;
      } catch (error) {
        if (!oversizedNativeResponse(error) || itemLimit === 1) throw error;
        itemLimit = Math.max(1, Math.floor(itemLimit / 2));
      }
    }
    const itemData = array(itemPage.data);
    for (const value of itemData) {
      const entry = object(value);
      if (entry.turnId !== turnId) throw new Error("Native item belongs to another turn");
      const item = object(entry.item);
      const itemId = string(item.id);
      if (ids.has(itemId)) throw new Error("Repeated native history item");
      ids.add(itemId);
      items.push(item);
    }
    itemCursor = typeof itemPage.nextCursor === "string" ? itemPage.nextCursor : undefined;
    // 原因：只有游标而没有 item 的页不推进历史身份；拒绝继续请求，
    // 避免原生异常持续生成新游标时无限读取同一 turn。
    if (itemCursor && itemData.length === 0)
      throw new Error("Empty native item page with another cursor");
    if (itemCursor && seenCursors.has(itemCursor))
      throw new Error("Repeated native history cursor");
    if (itemCursor) seenCursors.add(itemCursor);
  } while (itemCursor);
  return items;
}

/** Only a full history page may be retried after the native framer drops its response. */
async function readFullHistoryPage(
  rpc: CodexRpcPort,
  params: Record<string, unknown>,
  cursor: string | undefined,
  limit: number,
): Promise<Record<string, unknown>> {
  try {
    return object(await rpc.request("thread/turns/list", { ...params, cursor, limit }));
  } catch (error) {
    if (!oversizedNativeResponse(error) || limit !== 1) throw error;
  }
  // 原因：单 turn 超限时继续缩 limit 没有意义。固定原生版本提供 notLoaded 的
  // turn envelope 和 thread/items/list；只组合已完整读到的 item，不丢事实。
  const page = object(
    await rpc.request("thread/turns/list", { ...params, cursor, limit: 1, itemsView: "notLoaded" }),
  );
  const turns = array(page.data);
  if (turns.length !== 1) throw new Error("Oversized native turn metadata is incomplete");
  const turn = object(turns[0]);
  const turnId = string(turn.id);
  if (turn.itemsView !== "notLoaded" || array(turn.items).length !== 0)
    throw new Error("Native turn metadata did not exclude full items");
  const items = await hydrateNativeTurnItems(rpc, params.threadId, turnId);
  return { ...page, data: [{ ...turn, itemsView: "full", items }] };
}

/**
 * 原生 cursor 分页的唯一读取入口。
 * 各链路自己实现 seen/nextCursor 时容易漏掉重复游标保护，从而在原生回传同一游标时死循环；
 * 这里统一注入 limit 并保留「重复游标即失败」的原有语义，调用方只负责过滤与投影。
 */
export async function paginateNativeRows(
  rpc: CodexRpcPort,
  method: string,
  params: Record<string, unknown>,
  label: NativePageLabel,
): Promise<unknown[]> {
  const rows: unknown[] = [];
  const seen = new Set<string>();
  const seenHistoryIds = new Set<string>();
  const fullHistory =
    method === "thread/turns/list" && label === "history" && params.itemsView === "full";
  let limit = DEFAULT_PAGE_LIMIT;
  let cursor: string | undefined;
  do {
    let page: Record<string, unknown>;
    while (true) {
      try {
        page = fullHistory
          ? await readFullHistoryPage(rpc, params, cursor, limit)
          : object(await rpc.request(method, { ...params, cursor, limit }));
        break;
      } catch (error) {
        if (!fullHistory || !oversizedNativeResponse(error) || limit === 1) throw error;
        // 原因：已被丢弃的只读页不进入 rows，同一个 cursor 可安全缩页重读；
        // 不能把该策略扩展到 resume、写命令或非响应帧的 backpressure LIMIT。
        limit = Math.max(1, Math.floor(limit / 2));
      }
    }
    const data = array(page.data);
    if (fullHistory) {
      const normalized: unknown[] = [];
      for (const value of data) {
        const turn = object(value);
        const id = string(turn.id);
        if (seenHistoryIds.has(id)) throw new Error("Repeated native history turn");
        seenHistoryIds.add(id);
        // 修复原因：部分原生会话在 `thread/turns/list(itemsView="full")` 中仍返回
        // `summary` / `notLoaded` 的 turn，直接进入投影会稳定抛
        // `Codex conversation projection requires full turn items`。
        // 修复依据：在分页只读入口逐轮核验 `itemsView`，非 full 轮一律通过
        // `thread/items/list` 补齐完整 items（保留已携带的 item 并用完整项覆盖）后再标记为 full。
        if (turn.itemsView === "summary" || turn.itemsView === "notLoaded") {
          const hydratedItems = await hydrateNativeTurnItems(rpc, params.threadId, id);
          const mergedItems = new Map(
            array(turn.items).map((item) => [string(object(item).id), item]),
          );
          for (const item of hydratedItems) mergedItems.set(string(object(item).id), item);
          normalized.push({ ...turn, itemsView: "full", items: [...mergedItems.values()] });
        } else {
          normalized.push(value);
        }
      }
      rows.push(...normalized);
    } else {
      rows.push(...data);
    }
    cursor = typeof page.nextCursor === "string" ? page.nextCursor : undefined;
    if (fullHistory && cursor && data.length === 0)
      throw new Error("Empty native history page with another cursor");
    if (cursor && seen.has(cursor)) throw new Error(`Repeated native ${label} cursor`);
    if (cursor) seen.add(cursor);
  } while (cursor);
  return rows;
}
