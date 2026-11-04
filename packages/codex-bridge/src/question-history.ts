import { createReadStream } from "node:fs";
import { realpath } from "node:fs/promises";
import { createZstdDecompress } from "node:zlib";
import { StringDecoder } from "node:string_decoder";
import { pipeline } from "node:stream/promises";
import { resolveCodexHomeDir } from "./default-codex-config.js";
import { scopedRolloutPath } from "./session-data-files.js";
import { findItemInTurn, findTurnEntry, invalidateTurnItems } from "./thread-index.js";
import { array, object, type JsonObject } from "./json.js";

interface QuestionFact {
  turnId: string;
  item: JsonObject;
  nextItemId?: string;
}

function record(value: unknown): JsonObject | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonObject)
    : undefined;
}

function questionItem(itemId: string, input: JsonObject, response?: unknown): JsonObject {
  const questions = array(input.questions).map(object);
  const answers = record(record(response)?.answers);
  const safeAnswers = answers && { ...answers };
  if (safeAnswers) {
    for (const question of questions)
      if (
        question.isSecret === true &&
        typeof question.id === "string" &&
        Object.hasOwn(safeAnswers, question.id)
      )
        safeAnswers[question.id] = { answers: ["••••"] };
  }
  // 固定 Native 不物化此工具；dynamicToolCall 只是现有投影表示，不是一次新的工具执行。
  // secret 答案归 Native，不进入 UI 历史或 bridge 的派生缓存。
  return {
    type: "dynamicToolCall",
    id: itemId,
    tool: "request_user_input",
    namespace: null,
    arguments: { questions },
    status: safeAnswers ? "completed" : "inProgress",
    contentItems: safeAnswers
      ? [{ type: "inputText", text: JSON.stringify({ answers: safeAnswers }) }]
      : [],
    success: safeAnswers ? true : null,
  };
}

function upsertQuestion(thread: JsonObject, fact: QuestionFact): boolean {
  const turn = findTurnEntry(thread, fact.turnId);
  if (!turn) return false;
  const existing = findItemInTurn(turn, fact.item.id);
  // 原生若将来提供同 ID 的正式 item，不能覆盖不同工具或额外生成重复历史。
  if (
    existing &&
    (existing.item.type !== "dynamicToolCall" || existing.item.tool !== "request_user_input")
  )
    return false;
  // 冷文件读取期间 live 回答可能已完成，旧的无输出记录不能把同一工具退回 waiting。
  if (existing?.item.status === "completed" && fact.item.status === "inProgress") return false;
  const items = [...array(turn.turn.items)];
  if (existing) items[existing.index] = fact.item;
  else {
    const before = fact.nextItemId
      ? items.findIndex((item) => object(item).id === fact.nextItemId)
      : -1;
    items.splice(before < 0 ? items.length : before, 0, fact.item);
  }
  turn.turn.items = items;
  invalidateTurnItems(turn);
  return true;
}

export function observeNativeQuestion(
  thread: JsonObject,
  params: JsonObject,
  response?: unknown,
): boolean {
  if (typeof params.turnId !== "string" || typeof params.itemId !== "string") return false;
  return upsertQuestion(thread, {
    turnId: params.turnId,
    item: questionItem(params.itemId, params, response),
  });
}

/** 有界逐行解析：大图片/工具输出行跳过，避免把整个原生 rollout 或超大一行读入内存。 */
async function* rolloutLines(path: string): AsyncGenerator<string | { oversizedPrefix: string }> {
  const file = createReadStream(path);
  const decoded = path.endsWith(".zst") ? createZstdDecompress() : undefined;
  const input = decoded ?? file;
  const completion = decoded ? pipeline(file, decoded) : undefined;
  // pipeline 将文件读取失败传给 decoder；提前绑定 rejection，不能产生进程级未处理异常。
  void completion?.catch(() => {});
  const decoder = new StringDecoder("utf8");
  const maxLine = 1_048_576;
  let line = "",
    prefix = "",
    dropping = false;
  try {
    for await (const chunk of input) {
      const text = decoder.write(chunk as Buffer);
      let start = 0;
      for (;;) {
        const end = text.indexOf("\n", start);
        const part = text.slice(start, end < 0 ? text.length : end);
        if (!dropping) {
          if (line.length + part.length > maxLine) {
            prefix = (line + part.slice(0, 8192)).slice(0, 8192);
            line = "";
            dropping = true;
          } else line += part;
        }
        if (end < 0) break;
        yield dropping ? { oversizedPrefix: prefix } : line;
        line = "";
        prefix = "";
        dropping = false;
        start = end + 1;
      }
    }
    // 在途 Native 可能只写出半行；没有换行的尾部不应被当作已提交历史。
    await completion;
  } finally {
    input.destroy();
    file.destroy();
    await completion?.catch(() => {});
  }
}

export async function readNativeQuestionHistory(
  thread: JsonObject,
  home = resolveCodexHomeDir(),
): Promise<QuestionFact[]> {
  if (typeof thread.path !== "string") return [];
  const scoped = scopedRolloutPath(home, thread.path);
  if (!scoped) return [];
  // 除词法作用域外验证物理路径，避免 rollout symlink 读取 CODEX_HOME 外的文件。
  const [path, physicalHome] = await Promise.all([realpath(scoped), realpath(home)]);
  if (!scopedRolloutPath(physicalHome, path)) return [];
  const facts = new Map<string, QuestionFact>();
  const order = new Map<string, string[]>();
  let authorized = false;
  for await (const line of rolloutLines(path)) {
    if (typeof line !== "string") {
      const callId = /"call_id"\s*:\s*("(?:\\.|[^"\\])*")/u.exec(line.oversizedPrefix)?.[1];
      const knownQuestion =
        callId && [...facts.values()].some((fact) => fact.item.id === JSON.parse(callId));
      // 大图片/普通工具行可跳过；已知问题的输入/结果必须明确失败，不能静默伪造未回答。
      if (knownQuestion || /"name"\s*:\s*"request_user_input"/u.test(line.oversizedPrefix))
        throw new Error("Native question history record exceeds the bounded read budget");
      continue;
    }
    let entry: JsonObject;
    try {
      entry = object(JSON.parse(line));
    } catch {
      continue;
    }
    const payload = record(entry.payload);
    if (!payload) continue;
    if (entry.type === "session_meta") {
      if (payload.id !== thread.id)
        throw new Error("Native question history has a different thread identity");
      authorized = true;
      continue;
    }
    if (!authorized || entry.type !== "response_item") continue;
    const metadata = record(payload.internal_chat_message_metadata_passthrough);
    // 不按「最近一轮」猜归属，itemId 可跨 turn 复用，必须使用真实 turn metadata。
    const turnId = metadata?.turn_id;
    if (typeof turnId !== "string") continue;
    const key = (itemId: string) => JSON.stringify([turnId, itemId]);
    const orderedId = payload.type === "function_call" ? payload.call_id : payload.id;
    if (typeof orderedId === "string") {
      const ids = order.get(turnId) ?? [];
      ids.push(orderedId);
      order.set(turnId, ids);
    }
    if (
      payload.type === "function_call" &&
      payload.name === "request_user_input" &&
      typeof payload.call_id === "string" &&
      typeof payload.arguments === "string"
    ) {
      let input: JsonObject;
      try {
        input = object(JSON.parse(payload.arguments));
      } catch {
        continue;
      }
      if (!Array.isArray(input.questions)) continue;
      facts.set(key(payload.call_id), { turnId, item: questionItem(payload.call_id, input) });
    } else if (payload.type === "function_call_output" && typeof payload.call_id === "string") {
      const fact = facts.get(key(payload.call_id));
      if (!fact || typeof payload.output !== "string") continue;
      let response: unknown;
      try {
        response = JSON.parse(payload.output);
      } catch {
        continue;
      }
      fact.item = questionItem(payload.call_id, object(fact.item.arguments), response);
    }
  }
  for (const [turnId, ids] of order) {
    const turn = findTurnEntry(thread, turnId);
    if (!turn) continue;
    let nextItemId: string | undefined;
    for (let index = ids.length - 1; index >= 0; index--) {
      const id = ids[index]!;
      const fact = facts.get(JSON.stringify([turnId, id]));
      if (fact) fact.nextItemId = nextItemId;
      else if (findItemInTurn(turn, id)) nextItemId = id;
    }
  }
  return [...facts.values()];
}

export function applyNativeQuestionHistory(
  thread: JsonObject,
  facts: readonly QuestionFact[],
): void {
  for (const fact of facts) upsertQuestion(thread, fact);
}
