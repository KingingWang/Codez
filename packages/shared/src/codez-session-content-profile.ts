// session/read 的 contentProfile="index" 裁剪。
// 背景：task index 每次 turn 完成 / 改标题 / 变可见都会 existing-only 读一次 session，
// 旧实现拿到的是完整历史（长 session 单行可达 ~15MB），host stdio 与 JSON 解析被打满，
// 而 index 只需要 title / searchableText / hasUserVisibleContent / status / model。
// 这里只剥离这些派生都不读取的大载荷字段，保持 message / part 数量、顺序、id、type、metadata 不变，
// 以保证可见性与投影策略判定和 full snapshot 完全一致（spec：docs/task/task-sqlite-index.md「Index read profile」）。
// 不能改用 messageLimit：searchableText 取前 200K 字符、标题回退首条真实用户输入，都依赖历史开头。
import type {
  CodezSessionIndexReadResult,
  CodezSessionIndexTarget,
  CodezSessionStateSnapshot,
} from "./codez-protocol/index.js";
import type { CodezMessagePart, CodezMessageWithParts } from "./codez-protocol-legacy-types.js";
import { formatModelPickerValue } from "./model-selection.js";
import {
  getCodezUserVisibleMessages,
  isCodezGoalContinuationReminderText,
  isCodezModelOnlySyntheticUserMessage,
} from "./codez-session-visible-content.js";

export type CodezSessionContentProfile = "full" | "index";

const ELIDED_DATA_URL = "data:,";

function elidePartForIndex(part: CodezMessagePart): CodezMessagePart {
  switch (part.type) {
    case "reasoning":
      return part.text ? { ...part, text: "" } : part;
    case "file":
      return part.url.startsWith("data:") && part.url !== ELIDED_DATA_URL
        ? { ...part, url: ELIDED_DATA_URL }
        : part;
    case "tool": {
      const state = part.state;
      switch (state.status) {
        case "pending":
          return { ...part, state: { ...state, input: {}, raw: "" } };
        case "running":
          return {
            ...part,
            state: { ...state, input: {}, ...(state.metadata ? { metadata: {} } : {}) },
          };
        case "completed":
          return { ...part, state: { ...state, input: {}, output: "", metadata: {} } };
        case "error":
          return {
            ...part,
            state: { ...state, input: {}, error: "", ...(state.metadata ? { metadata: {} } : {}) },
          };
        default:
          return part;
      }
    }
    default:
      return part;
  }
}

function elideMessageForIndex(message: CodezMessageWithParts): CodezMessageWithParts {
  let changed = false;
  const parts = message.parts.map((part) => {
    const next = elidePartForIndex(part);
    if (next !== part) changed = true;
    return next;
  });
  return changed ? { ...message, parts } : message;
}

/** 生成 task index 专用的轻量 snapshot；不修改入参（CLI 侧 messages 可能来自共享缓存）。 */
export function elideSessionSnapshotForIndex<T extends CodezSessionStateSnapshot>(snapshot: T): T {
  return { ...snapshot, messages: snapshot.messages.map(elideMessageForIndex) };
}

export const TASK_SEARCH_TEXT_MAX_CHARS = 200_000;

export type CodezSessionIndexSemanticInput = Pick<
  CodezSessionStateSnapshot,
  "session" | "settings" | "projection" | "messages"
>;

function targetForSessionIndex(snapshot: CodezSessionIndexSemanticInput): CodezSessionIndexTarget {
  const target = snapshot.projection.target;
  if (target === undefined) return { kind: "absent" };
  return target === null ? { kind: "null" } : { kind: "value", value: target };
}

export function hasUserVisibleContentForSessionIndex(
  snapshot: CodezSessionIndexSemanticInput,
): boolean {
  const title = snapshot.session.title?.trim() ?? "";
  if (title && !isCodezGoalContinuationReminderText(title)) return true;
  if (snapshot.projection.target?.objective.trim()) return true;
  return snapshot.messages.some((message) => {
    if (message.info.role !== "user") return false;
    if (isCodezModelOnlySyntheticUserMessage(message)) return false;
    return message.parts.some((part) => part.type === "text" && part.text.trim().length > 0);
  });
}

export function buildSearchableTextForSessionIndex(
  snapshot: CodezSessionIndexSemanticInput,
): CodezSessionIndexReadResult["searchableText"] {
  const parts: string[] = [];
  let total = 0;
  let truncated = false;
  // 与旧 Host 推导一致：排除思考、tool、compaction；assistant 只取最后一段正文。
  for (const message of getCodezUserVisibleMessages(snapshot.messages, {
    target: snapshot.projection.target,
  })) {
    const textParts = message.parts.filter(
      (part): part is Extract<CodezMessagePart, { type: "text" }> => part.type === "text",
    );
    if (textParts.length === 0) continue;
    const chosen = message.info.role === "assistant" ? textParts.slice(-1) : textParts;
    for (const part of chosen) {
      const content = part.text.trim();
      if (!content) continue;
      parts.push(content);
      total += content.length;
      if (total >= TASK_SEARCH_TEXT_MAX_CHARS) {
        truncated = total > TASK_SEARCH_TEXT_MAX_CHARS;
        break;
      }
    }
    if (total >= TASK_SEARCH_TEXT_MAX_CHARS) break;
  }
  const text = parts.join("\n");
  truncated ||= text.length > TASK_SEARCH_TEXT_MAX_CHARS;
  return { text: text.slice(0, TASK_SEARCH_TEXT_MAX_CHARS), truncated };
}

/** full snapshot 与 native 轻量 projector 共用的唯一 task-index 派生规则。 */
export function projectSessionIndexContent(
  snapshot: CodezSessionIndexSemanticInput,
): Omit<CodezSessionIndexReadResult, "watermark"> {
  let latestMessageModel;
  for (let index = snapshot.messages.length - 1; index >= 0; index -= 1) {
    const model = snapshot.messages[index]?.info.model;
    if (model) {
      latestMessageModel = model;
      break;
    }
  }
  return {
    session: snapshot.session,
    presentation: {
      mode:
        snapshot.session.mode === "build" || snapshot.session.mode === "custom"
          ? "build"
          : snapshot.session.mode,
      model: formatModelPickerValue(latestMessageModel ?? snapshot.settings.model.current),
      thoughtLevel: snapshot.settings.thoughtLevel.current,
      lastError: snapshot.projection.lastError
        ? {
            code: snapshot.projection.lastError.code ?? snapshot.projection.lastError.type,
            message: snapshot.projection.lastError.message,
            ...(snapshot.projection.lastError.detail
              ? { detail: snapshot.projection.lastError.detail }
              : {}),
            ...(snapshot.projection.lastError.attribution
              ? { attribution: snapshot.projection.lastError.attribution }
              : {}),
          }
        : undefined,
    },
    target: targetForSessionIndex(snapshot),
    hasUserVisibleContent: hasUserVisibleContentForSessionIndex(snapshot),
    searchableText: buildSearchableTextForSessionIndex(snapshot),
  };
}
