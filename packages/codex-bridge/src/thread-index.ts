import { array, type JsonObject } from "./json.js";

/**
 * `turnId → turn`、`itemId → item` 的增量索引（specs/codex-desktop-adapter.md）。
 *
 * 原因：原生 `item/started`、`item/completed`、`turn/plan/updated` 与流式 `*Delta`
 * 通知只携带 turnId/itemId，旧实现每条事件都要 `array(thread.turns).map(object).find(...)`
 * 线性扫描完整历史，并且 `map` 还会为每一轮额外分配一次数组；万轮会话下每条 delta 的
 * 成本随历史线性增长。这里按 `state.thread` 对象维护增量索引，把定位降到 O(1)，
 * 让活动轮的 delta 成本只与活动轮大小相关。
 *
 * 不变量（索引只是缓存，事实源始终是 `thread.turns` / `turn.items`）：
 * - 命中后必须校验 `turns[index] === turn`（item 同理），错位立即重建，绝不返回错位对象；
 * - `turns` / `items` 的引用或长度与索引记录不一致时按需重建，兼容外部直接替换数组；
 * - 同 id 重复出现时保留首个位置，与旧 `find` / `findIndex` 的语义一致；
 * - 未命中最多触发一次自愈扫描（按数组状态记账），未知 id 的事件流不会退化成 O(N²)；
 * - store 自己的写入通过 noteTurnAppended / noteTurnReplaced / noteItemWritten 同步索引，
 *   正常路径不会触发任何重建或自愈扫描。
 */

export interface ThreadItemEntry {
  index: number;
  item: JsonObject;
}

export interface ThreadTurnEntry {
  index: number;
  turn: JsonObject;
  /** 懒建：只有该轮真的收到 item 事件时才展开 items，全量重建索引保持 O(turns)。 */
  itemsById: Map<string, ThreadItemEntry>;
  itemsBuilt: boolean;
  /** 建立 itemsById 时的 `turn.items` 引用与长度；不一致时重建该轮的 item 索引。 */
  itemsRef: unknown;
  itemsLength: number;
  /** 已因未命中重建过 item 索引的数组状态，避免未知 itemId 反复触发重建。 */
  itemsMissRef: unknown;
  itemsMissLength: number;
}

export interface ThreadTurnItemIndex {
  turnsById: Map<string, ThreadTurnEntry>;
  turnsRef: unknown;
  turnsLength: number;
  /**
   * 已针对该 turns 数组状态完成过一次自愈扫描。外部可能在不改引用/长度的情况下原位替换
   * 元素（引用与长度校验发现不了），所以未命中时要扫一遍并把结果写回索引；记账之后同一
   * 状态的后续未命中直接判定为不存在，未知 id 的事件流不会退化成 O(N²)。
   */
  scanRef: unknown;
  scanLength: number;
}

export interface ThreadItemLookup {
  turnEntry: ThreadTurnEntry;
  turn: JsonObject;
  index: number;
  item: JsonObject;
}

const threadIndexes = new WeakMap<JsonObject, ThreadTurnItemIndex>();

function record(value: unknown): JsonObject | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonObject)
    : undefined;
}

function idOf(value: JsonObject): string | undefined {
  return typeof value.id === "string" ? value.id : undefined;
}

function itemsArray(turn: JsonObject): unknown[] | undefined {
  return Array.isArray(turn.items) ? turn.items : undefined;
}

function newTurnEntry(index: number, turn: JsonObject): ThreadTurnEntry {
  return {
    index,
    turn,
    itemsById: new Map(),
    itemsBuilt: false,
    itemsRef: undefined,
    itemsLength: -1,
    itemsMissRef: undefined,
    itemsMissLength: -1,
  };
}

/** 重建单轮的 item 索引；`turn.items` 不是数组时记为空表（与旧 `array(...)` 行为一致）。 */
function indexItems(turnEntry: ThreadTurnEntry): void {
  const items = itemsArray(turnEntry.turn);
  const itemsById = new Map<string, ThreadItemEntry>();
  if (items) {
    for (let index = 0; index < items.length; index += 1) {
      const item = record(items[index]);
      const id = item ? idOf(item) : undefined;
      // 同 id 保留首个位置：旧实现用 findIndex 原位替换首个匹配项。
      if (item && id !== undefined && !itemsById.has(id)) itemsById.set(id, { index, item });
    }
  }
  turnEntry.itemsById = itemsById;
  turnEntry.itemsBuilt = true;
  turnEntry.itemsRef = items;
  turnEntry.itemsLength = items?.length ?? -1;
  turnEntry.itemsMissRef = undefined;
  turnEntry.itemsMissLength = -1;
}

function buildIndex(thread: JsonObject, turns: unknown[]): ThreadTurnItemIndex {
  const turnsById = new Map<string, ThreadTurnEntry>();
  for (let index = 0; index < turns.length; index += 1) {
    const turn = record(turns[index]);
    const id = turn ? idOf(turn) : undefined;
    if (turn && id !== undefined && !turnsById.has(id))
      turnsById.set(id, newTurnEntry(index, turn));
  }
  return {
    turnsById,
    turnsRef: thread.turns,
    turnsLength: turns.length,
    // 故意不标记「已扫描」：建索引之后外部仍可能原位替换某个元素（引用与长度都不变），
    // 保留一次自愈扫描的额度，避免把已存在的 turn 判成不存在而推出重复 turnId。
    scanRef: undefined,
    scanLength: -1,
  };
}

function scanTurns(
  index: ThreadTurnItemIndex,
  turns: unknown[],
  id: unknown,
): ThreadTurnEntry | undefined {
  let found: ThreadTurnEntry | undefined;
  for (let position = 0; position < turns.length; position += 1) {
    const turn = record(turns[position]);
    if (!turn || turn.id !== id) continue;
    const entry = newTurnEntry(position, turn);
    // 非字符串 id 不进索引（避免 String(id) 与真实字符串 id 撞键），只返回本次结果。
    if (typeof id === "string") index.turnsById.set(id, entry);
    found = entry;
    break;
  }
  index.scanRef = index.turnsRef;
  index.scanLength = turns.length;
  return found;
}

/** 取索引；`turns` 引用或长度与记录不一致（外部替换/追加）时整份重建。 */
function ensureIndex(thread: JsonObject, turns: unknown[]): ThreadTurnItemIndex {
  const existing = threadIndexes.get(thread);
  if (existing && existing.turnsRef === thread.turns && existing.turnsLength === turns.length)
    return existing;
  const index = buildIndex(thread, turns);
  threadIndexes.set(thread, index);
  return index;
}

/**
 * O(1) 定位 turn。非字符串 id 与「索引落后于外部原位改写」都会退回线性扫描，
 * 结果与旧的 `turns.map(object).find((turn) => turn.id === id)` 完全一致。
 */
export function findTurnEntry(thread: JsonObject, id: unknown): ThreadTurnEntry | undefined {
  const turns = array(thread.turns);
  const index = ensureIndex(thread, turns);
  if (typeof id !== "string") return scanTurns(index, turns, id);
  const cached = index.turnsById.get(id);
  if (cached && turns[cached.index] === cached.turn) return cached;
  // 命中但位置错位：外部原位替换过该下标，先丢掉过期条目再走自愈扫描。
  if (cached) index.turnsById.delete(id);
  // 同一数组状态只扫一次：扫描过仍未命中即确认不存在（新 turn 的 turn/started 走这里）。
  if (index.scanRef === thread.turns && index.scanLength === turns.length) return undefined;
  return scanTurns(index, turns, id);
}

function syncItems(turnEntry: ThreadTurnEntry): unknown[] | undefined {
  const items = itemsArray(turnEntry.turn);
  if (
    !turnEntry.itemsBuilt ||
    turnEntry.itemsRef !== items ||
    turnEntry.itemsLength !== (items?.length ?? -1)
  ) {
    indexItems(turnEntry);
  }
  return items;
}

function itemLookupOf(
  turnEntry: ThreadTurnEntry,
  items: unknown[],
  entry: ThreadItemEntry | undefined,
): ThreadItemLookup | undefined {
  if (!entry || items[entry.index] !== entry.item) return undefined;
  return { turnEntry, turn: turnEntry.turn, index: entry.index, item: entry.item };
}

/** 在已定位的 turn 内 O(1) 定位 item；返回值持有数组里的同一对象，可直接原地合入 delta。 */
export function findItemInTurn(
  turnEntry: ThreadTurnEntry,
  itemId: unknown,
): ThreadItemLookup | undefined {
  const items = syncItems(turnEntry);
  if (!items) return undefined;
  if (typeof itemId !== "string") {
    for (let index = 0; index < items.length; index += 1) {
      const item = record(items[index]);
      if (item && item.id === itemId) return { turnEntry, turn: turnEntry.turn, index, item };
    }
    return undefined;
  }
  const cached = turnEntry.itemsById.get(itemId);
  const hit = itemLookupOf(turnEntry, items, cached);
  if (hit) return hit;
  if (cached) {
    // item 被外部原位替换：重建该轮 item 索引后重取。
    indexItems(turnEntry);
    return itemLookupOf(turnEntry, items, turnEntry.itemsById.get(itemId));
  }
  if (turnEntry.itemsMissRef === items && turnEntry.itemsMissLength === items.length)
    return undefined;
  indexItems(turnEntry);
  turnEntry.itemsMissRef = items;
  turnEntry.itemsMissLength = items.length;
  return itemLookupOf(turnEntry, items, turnEntry.itemsById.get(itemId));
}

/** O(1) 定位 turn 内的 item（先按 turnId 定位 turn）。 */
export function findItemEntry(
  thread: JsonObject,
  turnId: unknown,
  itemId: unknown,
): ThreadItemLookup | undefined {
  const turnEntry = findTurnEntry(thread, turnId);
  return turnEntry ? findItemInTurn(turnEntry, itemId) : undefined;
}

/**
 * turn 写入（append / 原位替换）后同步索引：store 自己的写入不该触发 O(N) 重建。
 * `expectedLength` 是写入前的索引长度；与实际长度不符说明外部也改过 turns，直接失效重建。
 */
function noteTurnWritten(
  thread: JsonObject,
  expectedLength: number,
  index: number,
  turn: JsonObject,
): void {
  const existing = threadIndexes.get(thread);
  if (!existing || existing.turnsRef !== thread.turns || existing.turnsLength !== expectedLength) {
    // turns 数组被整体换掉，或外部也改过长度：失效索引，下次查找按需重建。
    threadIndexes.delete(thread);
    return;
  }
  existing.turnsLength = array(thread.turns).length;
  // 写入改变了数组内容：之前那次「已扫描」记账不再适用。
  existing.scanRef = undefined;
  existing.scanLength = -1;
  const id = idOf(turn);
  if (id === undefined) return;
  const previous = existing.turnsById.get(id);
  // 同 id 已在别处：旧 find 返回首个匹配，保持不动。
  if (!previous || previous.index === index) existing.turnsById.set(id, newTurnEntry(index, turn));
}

/** `turns.push(turn)` 之后调用。 */
export function noteTurnAppended(thread: JsonObject, turn: JsonObject): void {
  const turns = array(thread.turns);
  noteTurnWritten(thread, Math.max(0, turns.length - 1), turns.length - 1, turn);
}

/** `turns[index] = turn` 之后调用。 */
export function noteTurnReplaced(thread: JsonObject, index: number, turn: JsonObject): void {
  noteTurnWritten(thread, array(thread.turns).length, index, turn);
}

/**
 * `turn.items` 写入（append / 原位替换）后同步该轮 item 索引。
 * 调用方必须先把 item 写进数组，再调用本函数。
 */
export function noteItemWritten(turnEntry: ThreadTurnEntry, index: number, item: JsonObject): void {
  const items = syncItems(turnEntry);
  if (!items) return;
  const id = idOf(item);
  if (id === undefined) return;
  const previous = turnEntry.itemsById.get(id);
  if (!previous || previous.index === index) turnEntry.itemsById.set(id, { index, item });
  turnEntry.itemsMissRef = undefined;
  turnEntry.itemsMissLength = -1;
}

/** `turn.items` 被索引外的代码改写（如 turn/plan/updated）后失效该轮 item 索引。 */
export function invalidateTurnItems(turnEntry: ThreadTurnEntry): void {
  turnEntry.itemsBuilt = false;
  turnEntry.itemsRef = undefined;
  turnEntry.itemsLength = -1;
  turnEntry.itemsMissRef = undefined;
  turnEntry.itemsMissLength = -1;
}

/**
 * 倒序找最后一个匹配状态的 turn；命中即返回，常见情况（活动轮在末尾）是 O(1)。
 * 旧实现先 `array(turns).map(object)` 再 findLast，每条 tokenUsage 事件都要分配整份历史副本。
 */
export function findLastTurnWithStatus(thread: JsonObject, status: string): JsonObject | undefined {
  const turns = array(thread.turns);
  for (let index = turns.length - 1; index >= 0; index -= 1) {
    const turn = record(turns[index]);
    if (turn && turn.status === status) return turn;
  }
  return undefined;
}

/** 末尾 turn（tokenUsage 归属的最后一层回退）。 */
export function lastTurn(thread: JsonObject): JsonObject | undefined {
  const turns = array(thread.turns);
  return record(turns[turns.length - 1]);
}
