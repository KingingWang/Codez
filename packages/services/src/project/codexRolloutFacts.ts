import { open } from "node:fs/promises";
import { isInjectedCodexContextTitle } from "@codez/shared";

/**
 * Codex 原生 rollout `.jsonl` → 任务事实（sessionId / cwd / 首问标题 / 时间 / 来源 / 结局）
 * 的纯读取投影。
 *
 * 本文件只回答“一个 rollout 文件里有什么事实”，不持有缓存、不遍历目录、不写库；
 * 扫描调度、缓存剪枝与入库由 `codexGlobalRolloutSyncer.ts` 独占拥有。
 * 拆分依据：架构策略 `max-file-lines`（单文件 800 行上限，规则要求按职责拆分而不是加豁免），
 * 解析规则与同步策略因此分文件维护。
 */

const MAX_ROLLOUT_HEAD_BYTES = 128 * 1024;
const MAX_ROLLOUT_TAIL_BYTES = 64 * 1024;
const ROLLOUT_FILE_PREFIX = "rollout-";
const ROLLOUT_FILE_SUFFIX = ".jsonl";
const PROJECT_SOURCE_PREFIX = "codez_project:";
const UNCLASSIFIED_SOURCE = "codez_unclassified";
const SELECTION_SIDE_CHAT_THREAD_SOURCE = "codez_selection_side_chat";
const ALLOWED_SOURCES = new Set(["cli", "vscode", "exec", "appServer", "app_server"]);
const USER_MESSAGE_BEGIN = "## My request for Codex:";

export interface ParsedRolloutCandidate {
  sessionId: string;
  cwd: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  forkedFromTaskId?: string;
  originProjectId?: string | null;
  lastOutcome?: "completed" | "interrupted" | "error";
}

/** `settled` 表示事实已定型：即使文件继续增长也不会再解析出 candidate。 */
interface RolloutParseResult {
  candidate: ParsedRolloutCandidate | null;
  settled: boolean;
}

const PARSE_REJECTED: RolloutParseResult = { candidate: null, settled: true };
const PARSE_INCOMPLETE: RolloutParseResult = { candidate: null, settled: false };

export function isRolloutFileName(name: string): boolean {
  return name.startsWith(ROLLOUT_FILE_PREFIX) && name.endsWith(ROLLOUT_FILE_SUFFIX);
}

/**
 * rollout 文件名里的 `YYYY-MM-DDTHH-MM-SS` 前缀本身就是字典序可比的时间戳，
 * 用它挑选活跃尾部时无需对每个历史文件做 `Date.parse`。
 */
export function rolloutStampFromName(name: string): string {
  return name.slice(ROLLOUT_FILE_PREFIX.length, ROLLOUT_FILE_PREFIX.length + 19);
}

function parseOriginProjectId(source: unknown): string | null | undefined {
  if (source === UNCLASSIFIED_SOURCE) return null;
  if (typeof source !== "string" || !source.startsWith(PROJECT_SOURCE_PREFIX)) return undefined;
  const projectId = source.slice(PROJECT_SOURCE_PREFIX.length);
  return /^[a-zA-Z0-9_-]{1,128}$/.test(projectId) ? projectId : undefined;
}

function normalizeSourceKind(raw: unknown): string | null {
  if (typeof raw === "string") return raw.trim();
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    const keys = Object.keys(raw as Record<string, unknown>);
    if (keys.length === 1) return keys[0]!;
  }
  return null;
}

function extractTextFromContent(content: unknown): string {
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const entry of content) {
    if (!entry || typeof entry !== "object") continue;
    const item = entry as Record<string, unknown>;
    if (typeof item.text === "string" && item.text.trim()) {
      parts.push(item.text.trim());
    }
  }
  return parts.join("\n").trim();
}

function visibleUserText(text: string): string {
  const heading = text.indexOf(USER_MESSAGE_BEGIN);
  const visible = (heading < 0 ? text : text.slice(heading + USER_MESSAGE_BEGIN.length)).trim();
  return isInjectedCodexContextTitle(visible) ? "" : visible;
}

function parseEventPreview(
  event: Record<string, unknown>,
): { kind: "user" | "goal"; text: string } | null {
  const type = typeof event.type === "string" ? event.type : "";
  if (type === "user_message" || type === "userMessage") {
    const text = visibleUserText(
      typeof event.message === "string" && event.message.trim()
        ? event.message
        : extractTextFromContent(event.content),
    );
    return text ? { kind: "user", text } : null;
  }
  if (type === "item_completed" || type === "itemCompleted") {
    const item =
      event.item && typeof event.item === "object" && !Array.isArray(event.item)
        ? (event.item as Record<string, unknown>)
        : null;
    if (!item) return null;
    const itemType = typeof item.type === "string" ? item.type : "";
    if (itemType === "UserMessage" || itemType === "userMessage" || itemType === "user_message") {
      const text = visibleUserText(
        typeof item.message === "string" && item.message.trim()
          ? item.message
          : extractTextFromContent(item.content),
      );
      return text ? { kind: "user", text } : null;
    }
  }
  if (type === "thread_goal_updated" || type === "threadGoalUpdated") {
    const goal =
      event.goal && typeof event.goal === "object" && !Array.isArray(event.goal)
        ? (event.goal as Record<string, unknown>)
        : null;
    if (goal && typeof goal.objective === "string") {
      const text = goal.objective.trim();
      return text ? { kind: "goal", text } : null;
    }
  }
  return null;
}

function parseRolloutFileId(fileName: string): { createdAtMs: number; sessionId: string } | null {
  if (!isRolloutFileName(fileName)) return null;
  const core = fileName.slice(ROLLOUT_FILE_PREFIX.length, -ROLLOUT_FILE_SUFFIX.length);
  if (core.length < 21 || core[19] !== "-") return null;
  const tsPart = core.slice(0, 19);
  const idsPart = core.slice(20);
  const [threadId] = idsPart.split("_");
  if (!threadId) return null;
  const iso = `${tsPart.slice(0, 10)}T${tsPart.slice(11, 13)}:${tsPart.slice(14, 16)}:${tsPart.slice(17, 19)}Z`;
  const parsedTs = Date.parse(iso);
  return {
    createdAtMs: Number.isFinite(parsedTs) && parsedTs > 0 ? parsedTs : 0,
    sessionId: threadId,
  };
}

/** 只读 head/tail 有界切片，避免把数 MB 的 rollout 整体读进内存。 */
async function readBoundedRolloutSlice(
  filePath: string,
  fileSize: number,
): Promise<{ headText: string; tailText: string } | null> {
  let handle: Awaited<ReturnType<typeof open>>;
  try {
    handle = await open(filePath, "r");
  } catch {
    return null;
  }
  try {
    const headLength = Math.min(MAX_ROLLOUT_HEAD_BYTES, Math.max(0, fileSize));
    if (headLength <= 0) {
      const content = await handle.readFile({ encoding: "utf8" });
      return {
        headText: content.slice(0, MAX_ROLLOUT_HEAD_BYTES),
        tailText: "",
      };
    }
    const headBuffer = Buffer.allocUnsafe(headLength);
    const { bytesRead: headRead } = await handle.read(headBuffer, 0, headLength, 0);
    const headText = headBuffer.subarray(0, headRead).toString("utf8");
    if (fileSize <= MAX_ROLLOUT_HEAD_BYTES) {
      return { headText, tailText: "" };
    }
    const tailOffset = Math.max(MAX_ROLLOUT_HEAD_BYTES, fileSize - MAX_ROLLOUT_TAIL_BYTES);
    const tailLength = Math.max(0, fileSize - tailOffset);
    if (tailLength <= 0) {
      return { headText, tailText: "" };
    }
    const tailBuffer = Buffer.allocUnsafe(tailLength);
    const { bytesRead: tailRead } = await handle.read(tailBuffer, 0, tailLength, tailOffset);
    const rawTail = tailBuffer.subarray(0, tailRead).toString("utf8");
    const firstNewline = tailOffset > 0 ? rawTail.indexOf("\n") : -1;
    const tailText = firstNewline >= 0 ? rawTail.slice(firstNewline + 1) : rawTail;
    return { headText, tailText };
  } catch {
    return null;
  } finally {
    await handle.close();
  }
}

export async function parseRolloutCandidate(
  filePath: string,
  fileName: string,
  mtimeMs: number,
  fileSize = 0,
): Promise<RolloutParseResult> {
  const fileInfo = parseRolloutFileId(fileName);
  // 文件名不符合 rollout 约定，永远不会变成合法 rollout。
  if (!fileInfo) return PARSE_REJECTED;
  const slice = await readBoundedRolloutSlice(filePath, fileSize);
  // 打开/读取失败属于可重试的瞬时状态，不能定型。
  if (!slice) return PARSE_INCOMPLETE;
  const raw = slice.tailText ? `${slice.headText}\n${slice.tailText}` : slice.headText;

  let sessionId = fileInfo.sessionId;
  let cwd = "";
  let createdAt = fileInfo.createdAtMs || Math.max(1, Math.trunc(mtimeMs));
  let sawMeta = false;
  let userPreview = "";
  let responsePreview = "";
  let goalPreview = "";
  let forkedFromTaskId: string | undefined;
  let originProjectId: string | null | undefined;
  let lastOutcome: "completed" | "interrupted" | "error" | undefined;

  const lines = raw.split("\n");
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let record: Record<string, unknown>;
    try {
      const parsed = JSON.parse(trimmed);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) continue;
      record = parsed as Record<string, unknown>;
    } catch {
      continue;
    }

    const type = typeof record.type === "string" ? record.type : "";
    const payload =
      record.payload && typeof record.payload === "object" && !Array.isArray(record.payload)
        ? (record.payload as Record<string, unknown>)
        : record;

    if (
      !sawMeta &&
      (type === "session_meta" || ("meta" in record && typeof record.meta === "object"))
    ) {
      const meta =
        payload.meta && typeof payload.meta === "object" && !Array.isArray(payload.meta)
          ? (payload.meta as Record<string, unknown>)
          : payload;
      const parentThreadId =
        typeof meta.parent_thread_id === "string" && meta.parent_thread_id.trim()
          ? meta.parent_thread_id.trim()
          : typeof meta.parentThreadId === "string" && meta.parentThreadId.trim()
            ? meta.parentThreadId.trim()
            : undefined;
      // subagent / 内部辅助线程：meta 一次性写死，后续增长不会改变结论。
      if (parentThreadId) return PARSE_REJECTED;
      const sourceKind = normalizeSourceKind(meta.source);
      if (sourceKind && !ALLOWED_SOURCES.has(sourceKind)) return PARSE_REJECTED;
      const threadSource =
        typeof meta.thread_source === "string"
          ? meta.thread_source.trim()
          : typeof meta.threadSource === "string"
            ? meta.threadSource.trim()
            : undefined;
      if (threadSource === SELECTION_SIDE_CHAT_THREAD_SOURCE) return PARSE_REJECTED;
      originProjectId = parseOriginProjectId(threadSource);
      if (typeof meta.id === "string" && meta.id.trim()) {
        sessionId = meta.id.trim();
      }
      if (typeof meta.cwd === "string" && meta.cwd.trim()) {
        cwd = meta.cwd.trim();
      }
      if (typeof meta.timestamp === "string") {
        const ts = Date.parse(meta.timestamp);
        if (Number.isFinite(ts) && ts > 0) createdAt = ts;
      }
      const forkedFrom =
        typeof meta.forked_from_id === "string" && meta.forked_from_id.trim()
          ? meta.forked_from_id.trim()
          : typeof meta.forkedFromId === "string" && meta.forkedFromId.trim()
            ? meta.forkedFromId.trim()
            : undefined;
      if (forkedFrom) forkedFromTaskId = forkedFrom;
      sawMeta = true;
      continue;
    }

    if (type === "event_msg" || type === "eventMsg") {
      // 修复原因：Codex 先落盘 user-role <environment_context> response_item，
      // 再落盘 item_completed/UserMessage；前者不是用户输入，不能抢占首个标题。
      const candidate = parseEventPreview(payload);
      if (candidate?.kind === "user" && !userPreview) userPreview = candidate.text;
      if (candidate?.kind === "goal" && !goalPreview) goalPreview = candidate.text;
    } else if ((type === "response_item" || type === "responseItem") && !responsePreview) {
      const item =
        payload.item && typeof payload.item === "object" && !Array.isArray(payload.item)
          ? (payload.item as Record<string, unknown>)
          : payload;
      if (item.role === "user") {
        // 仅在旧 rollout 缺少 UserMessage 事件时使用真实 response item 兜底。
        responsePreview = visibleUserText(extractTextFromContent(item.content));
      }
    }

    if (type === "event_msg" || type === "eventMsg") {
      const evType = typeof payload.type === "string" ? payload.type : "";
      if (evType === "task_complete" || evType === "turn_completed" || evType === "agent_message") {
        lastOutcome = "completed";
      } else if (evType === "turn_aborted" || evType === "interrupted") {
        lastOutcome = "interrupted";
      } else if (evType === "error") {
        lastOutcome = "error";
      }
    }
  }

  const preview = userPreview || responsePreview || goalPreview;
  // meta 尚未落盘（首行可能被写一半）时保持未定型，下一轮追加后仍要重试。
  if (!sawMeta) return PARSE_INCOMPLETE;
  // meta 已定型却缺 cwd：不会补齐，直接拒绝。
  if (!cwd) return PARSE_REJECTED;
  // 首条真实用户消息可能稍后才落盘，这类文件必须继续参与后续 stat。
  if (!preview) return PARSE_INCOMPLETE;

  const updatedAt = Math.max(createdAt, Math.trunc(mtimeMs));
  const title = Array.from(preview.replace(/\s+/g, " ").trim()).slice(0, 120).join("");
  if (!title) return PARSE_INCOMPLETE;

  return {
    candidate: {
      sessionId,
      cwd,
      title,
      createdAt,
      updatedAt,
      ...(forkedFromTaskId ? { forkedFromTaskId } : {}),
      ...(originProjectId !== undefined ? { originProjectId } : {}),
      ...(lastOutcome ? { lastOutcome } : {}),
    },
    settled: false,
  };
}
