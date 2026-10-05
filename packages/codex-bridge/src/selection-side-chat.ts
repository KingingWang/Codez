import type { CodexRpcPort } from "./contract.js";
import { array, object, string } from "./json.js";

/**
 * 辅助对话（selection side chat）child 线程的标记、边界指令与继承裁剪规则。
 * 语义与 legacy codez-cli 运行时的 selection_side_chat 对齐（spec：
 * specs/codex-selection-side-chat.md）。
 *
 * 标记走原生 rollout 持久化字段 threadSource（协议 ThreadSource::Feature(String)
 * 原样回读），thread/read 与 thread/list 都返回；bridge 不引入本地持久化文件，
 * 重启后仍能识别 child 并重建裁剪边界。
 */
export const SELECTION_SIDE_CHAT_THREAD_SOURCE = "codez_selection_side_chat";

/**
 * 与 legacy（apps/codez-cli/.../session-fork.ts SELECTION_SIDE_CHAT_BOUNDARY）同文案；
 * 继承历史只进模型上下文、不自动继续父工作。改任一侧必须同步另一侧。
 */
export const SELECTION_SIDE_CHAT_BOUNDARY = [
  "The preceding conversation was inherited from the parent task for reference only.",
  "Do not continue the parent's active work automatically; answer only new questions sent in this side chat.",
  "Modify the workspace only when the user explicitly asks you to do so in this side chat.",
].join(" ");

/** 边界指令拼在 child 的第一条自有输入前；后续输入不再重复。 */
export function withSelectionSideChatBoundary(text: string): string {
  return `${SELECTION_SIDE_CHAT_BOUNDARY}\n\n${text}`;
}

/** 仅以持久化标记判定 child 身份；forkedFromId 缺失时身份成立但无法裁剪继承历史。 */
export function isSelectionSideChatThread(thread: unknown): boolean {
  return object(thread).threadSource === SELECTION_SIDE_CHAT_THREAD_SOURCE;
}

/**
 * 是否需要为下一次输入拼接边界指令：child 当前所有 turn 都来自父线程继承
 * （fork 保留源 turn id），即还没有任何自有输入。turn id 不在继承集合里的
 * turn 一律视为自有 turn（父之后的 revert/新增不影响本判定）。
 */
export function selectionSideChatNeedsBoundary(
  thread: unknown,
  inheritedTurnIds: ReadonlySet<string>,
): boolean {
  return array(object(thread).turns)
    .map((turn) => string(object(turn).id))
    .every((id) => inheritedTurnIds.has(id));
}

/** sendText 入口：child 尚无自有输入时给文本拼边界指令，否则原样返回。 */
export function applySelectionSideChatBoundary(
  sideChat: SelectionSideChatBoundary | undefined,
  thread: unknown,
  text: string,
): string {
  return sideChat && selectionSideChatNeedsBoundary(thread, sideChat.inheritedTurnIds)
    ? withSelectionSideChatBoundary(text)
    : text;
}

/** 辅助对话 child 的继承裁剪边界：fork 保留源 turn id，继承集合 = child turns ∩ 父 turns。 */
export interface SelectionSideChatBoundary {
  parentThreadId: string;
  inheritedTurnIds: ReadonlySet<string>;
}

/**
 * load 时按父线程当前 turn id 求交重建继承边界。父读取失败（已删除/不可读）
 * fail-open 返回 undefined：child 保持可用、不裁剪。
 */
export async function resolveSelectionSideChatBoundary(
  rpc: CodexRpcPort,
  thread: Record<string, unknown>,
): Promise<SelectionSideChatBoundary | undefined> {
  if (
    thread.threadSource !== SELECTION_SIDE_CHAT_THREAD_SOURCE ||
    typeof thread.forkedFromId !== "string"
  )
    return undefined;
  try {
    const parentThreadId = thread.forkedFromId;
    const parentTurnIds = new Set<string>();
    let cursor: string | undefined;
    const seen = new Set<string>();
    do {
      const page = object(
        await rpc.request("thread/turns/list", { threadId: parentThreadId, cursor, limit: 100 }),
      );
      for (const turn of array(page.data)) parentTurnIds.add(string(object(turn).id));
      cursor = typeof page.nextCursor === "string" ? page.nextCursor : undefined;
      if (cursor && seen.has(cursor)) throw new Error("Repeated native history cursor");
      if (cursor) seen.add(cursor);
    } while (cursor);
    return {
      parentThreadId,
      inheritedTurnIds: new Set(
        array(thread.turns)
          .map((turn) => string(object(turn).id))
          .filter((turnId) => parentTurnIds.has(turnId)),
      ),
    };
  } catch {
    return undefined;
  }
}
