import type { CodexRpcPort } from "./contract.js";
import { array, object } from "./json.js";

/** 分页链路标签：重复游标报错时指明是哪条原生读取。 */
export type NativePageLabel = "history" | "queue" | "thread";

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
  let cursor: string | undefined;
  do {
    const page = object(await rpc.request(method, { ...params, cursor, limit: 100 }));
    rows.push(...array(page.data));
    cursor = typeof page.nextCursor === "string" ? page.nextCursor : undefined;
    if (cursor && seen.has(cursor)) throw new Error(`Repeated native ${label} cursor`);
    if (cursor) seen.add(cursor);
  } while (cursor);
  return rows;
}
