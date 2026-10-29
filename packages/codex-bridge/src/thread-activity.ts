import { array, object, type JsonObject } from "./json.js";
import type { CodexRpcPort } from "./contract.js";
import { isInjectedCodexContextTitle } from "@codez/shared";

export interface ThreadActivityClock {
  at: number;
  metadataAt: number;
  frozen: boolean;
}

const activityReadSlots = new WeakMap<
  CodexRpcPort,
  { active: number; waiting: Array<() => void> }
>();

/** 仅变更的外部线程补读最后一条历史；按连接限流，不为每次 list 的每行读取完整历史。 */
export async function readRecentNativeActivity(
  rpc: CodexRpcPort,
  threadId: string,
): Promise<{
  at?: number;
  complete: boolean;
}> {
  let slots = activityReadSlots.get(rpc);
  if (!slots) {
    slots = { active: 0, waiting: [] };
    activityReadSlots.set(rpc, slots);
  }
  if (slots.active >= 4) await new Promise<void>((resolve) => slots.waiting.push(resolve));
  else slots.active++;
  try {
    const page = object(
      await rpc.request("thread/turns/list", {
        threadId,
        sortDirection: "desc",
        itemsView: "summary",
        limit: 1,
      }),
    );
    const turn = object(array(page.data)[0] ?? {});
    if (typeof turn.id !== "string" || !turn.id) return { complete: true };
    const turnAt = nativeHistoryActivity({ turns: [turn] });
    let items: JsonObject;
    try {
      items = object(
        await rpc.request("thread/items/list", {
          threadId,
          turnId: turn.id,
          sortDirection: "desc",
          limit: 1,
        }),
      );
    } catch {
      // item 补读失败不能丢弃已经确认的 turn 时间；保留 dirty 指纹，下一次扫描仍可补齐。
      return { at: turnAt, complete: false };
    }
    const entry = object(array(items.data)[0] ?? {});
    const item = object(entry.item ?? {});
    const text = array(item.content)
      .map((part) => object(part).text)
      .filter((value): value is string => typeof value === "string")
      .join("\n");
    const injected = item.type === "userMessage" && isInjectedCodexContextTitle(text);
    const itemAt =
      entry.turnId === turn.id &&
      typeof item.id === "string" &&
      item.id.length > 0 &&
      typeof item.type === "string" &&
      !injected
        ? latest(time(entry.startedAtMs), time(entry.completedAtMs))
        : undefined;
    return { at: latest(turnAt, itemAt), complete: true };
  } finally {
    const next = slots.waiting.shift();
    if (next) next();
    else slots.active--;
  }
}

/** 原生 turn 用秒，item envelope 用毫秒；拒绝无效值，不将历史缺时改为读取时刻。 */
function time(value: unknown, scale = 1): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return;
  const ms = value * scale;
  return Number.isSafeInteger(Math.trunc(ms)) ? ms : undefined;
}

function latest(...values: Array<number | undefined>): number | undefined {
  const valid = values.filter((value): value is number => value !== undefined);
  return valid.length ? Math.max(...valid) : undefined;
}

export function nativeHistoryActivity(thread: JsonObject): number | undefined {
  let at: number | undefined;
  for (const value of array(thread.turns)) {
    const turn = object(value);
    if (typeof turn.id !== "string" || !turn.id) continue;
    at = latest(at, time(turn.startedAt, 1000), time(turn.completedAt, 1000));
    for (const value of array(turn.items)) {
      const item = object(value);
      at = latest(at, time(item.startedAtMs), time(item.completedAtMs));
    }
  }
  return at;
}

/** 只在 Store 已成功应用该事件后调用；delta 没有原生时间时才使用 live 接收时刻。 */
export function nativeLiveActivity(
  method: string,
  params: JsonObject,
  receivedAt: number,
): number | undefined {
  if (method === "turn/started" || method === "turn/completed") {
    const turn = object(params.turn);
    if (typeof turn.id !== "string" || !turn.id) return;
    return latest(time(turn.startedAt, 1000), time(turn.completedAt, 1000)) ?? receivedAt;
  }
  if (method === "item/started" || method === "item/completed") {
    const item = object(params.item);
    if (typeof item.id !== "string" || !item.id || typeof item.type !== "string") return;
    return (
      latest(
        time(params.startedAtMs),
        time(params.completedAtMs),
        time(item.startedAtMs),
        time(item.completedAtMs),
      ) ?? receivedAt
    );
  }
  if (method.endsWith("/delta") || method.endsWith("Delta"))
    return latest(time(params.startedAtMs), time(params.completedAtMs)) ?? receivedAt;
}

export function nativeActivityBaseline(thread: JsonObject): number {
  return time(thread.updatedAt, 1000) ?? time(thread.createdAt, 1000) ?? 0;
}
