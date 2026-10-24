import { watch, type FSWatcher } from "node:fs";
import { mkdir, readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  CODEZ_AGENT_PROVIDER,
  generateTraceId,
  isInjectedCodexContextTitle,
  type CodezTaskMeta,
} from "@codez/shared";
import { createServiceLogger } from "#src/logger/serviceLogger.js";

export interface CodexGlobalRolloutTaskStore {
  getTaskMeta(params: {
    workspacePath: string;
    workspaceIdentity?: string;
    taskId: string;
  }): Promise<CodezTaskMeta | null>;
  applyCliFacts(params: {
    meta: CodezTaskMeta;
    originProjectId?: string | null;
    titleSource?: string;
    lastOutcome?: "completed" | "interrupted" | "error";
    deleted?: boolean;
  }): Promise<CodezTaskMeta>;
}

const logger = createServiceLogger("codex-global-rollout-syncer");

const DEBOUNCE_MS = 180;
const POLL_INTERVAL_MS = 3_000;
const ROLLOUT_STAT_CONCURRENCY = 16;
const MAX_ROLLOUT_HEAD_BYTES = 128 * 1024;
const PROJECT_SOURCE_PREFIX = "codez_project:";
const UNCLASSIFIED_SOURCE = "codez_unclassified";
const SELECTION_SIDE_CHAT_THREAD_SOURCE = "codez_selection_side_chat";
const ALLOWED_SOURCES = new Set(["cli", "vscode", "exec", "appServer", "app_server"]);
const USER_MESSAGE_BEGIN = "## My request for Codex:";

interface ParsedRolloutCandidate {
  sessionId: string;
  cwd: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  forkedFromTaskId?: string;
  originProjectId?: string | null;
  lastOutcome?: "completed" | "interrupted" | "error";
}

interface CachedRolloutFile {
  mtimeMs: number;
  size: number;
  synced: boolean;
  candidate: ParsedRolloutCandidate | null;
}

function resolveCodexHome(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.CODEX_HOME?.trim();
  return override || join(homedir(), ".codex");
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
  if (!fileName.startsWith("rollout-") || !fileName.endsWith(".jsonl")) return null;
  const core = fileName.slice("rollout-".length, -".jsonl".length);
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

async function parseRolloutCandidate(
  filePath: string,
  fileName: string,
  mtimeMs: number,
): Promise<ParsedRolloutCandidate | null> {
  const fileInfo = parseRolloutFileId(fileName);
  if (!fileInfo) return null;
  let raw: string;
  try {
    const content = await readFile(filePath, "utf8");
    raw =
      content.length > MAX_ROLLOUT_HEAD_BYTES ? content.slice(0, MAX_ROLLOUT_HEAD_BYTES) : content;
  } catch {
    return null;
  }

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
      if (parentThreadId) return null;
      const sourceKind = normalizeSourceKind(meta.source);
      if (sourceKind && !ALLOWED_SOURCES.has(sourceKind)) return null;
      const threadSource =
        typeof meta.thread_source === "string"
          ? meta.thread_source.trim()
          : typeof meta.threadSource === "string"
            ? meta.threadSource.trim()
            : undefined;
      if (threadSource === SELECTION_SIDE_CHAT_THREAD_SOURCE) return null;
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
  if (!sawMeta || !cwd || !preview) {
    return null;
  }

  const updatedAt = Math.max(createdAt, Math.trunc(mtimeMs));
  const title = Array.from(preview.replace(/\s+/g, " ").trim()).slice(0, 120).join("");
  if (!title) return null;

  return {
    sessionId,
    cwd,
    title,
    createdAt,
    updatedAt,
    ...(forkedFromTaskId ? { forkedFromTaskId } : {}),
    ...(originProjectId !== undefined ? { originProjectId } : {}),
    ...(lastOutcome ? { lastOutcome } : {}),
  };
}

async function readThreadNamesIndex(codexHome: string): Promise<Map<string, string>> {
  const result = new Map<string, string>();
  try {
    const content = await readFile(join(codexHome, "session_index.jsonl"), "utf8");
    for (const line of content.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const parsed = JSON.parse(trimmed) as { id?: unknown; thread_name?: unknown };
        if (
          typeof parsed.id === "string" &&
          parsed.id.trim() &&
          typeof parsed.thread_name === "string" &&
          parsed.thread_name.trim()
        ) {
          result.set(parsed.id.trim(), parsed.thread_name.trim());
        }
      } catch {
        // ignore malformed lines
      }
    }
  } catch {
    // session_index.jsonl may not exist yet
  }
  return result;
}

async function listRolloutFiles(
  sessionsRoot: string,
): Promise<Array<{ path: string; name: string }>> {
  const files: Array<{ path: string; name: string }> = [];
  const walk = async (dir: string, depth: number): Promise<void> => {
    if (depth > 4) return;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(fullPath, depth + 1);
      } else if (
        entry.isFile() &&
        entry.name.startsWith("rollout-") &&
        entry.name.endsWith(".jsonl")
      ) {
        files.push({ path: fullPath, name: entry.name });
      }
    }
  };
  await walk(sessionsRoot, 0);
  return files;
}

async function mapBounded<T, R>(
  items: readonly T[],
  limit: number,
  operation: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = Array.from({ length: items.length });
  let next = 0;
  async function worker(): Promise<void> {
    while (next < items.length) {
      const index = next++;
      results[index] = await operation(items[index]!);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

export interface CodexGlobalRolloutSyncer {
  start(): void;
  syncNow(): Promise<boolean>;
  dispose(): void;
}

/**
 * 监视并同步本 Host `$CODEX_HOME/sessions` 下的全部 Codex 原生会话到 `tasks-index.sqlite`。
 *
 * 修复原因（issue #19）：用户在任意目录（含尚未添加进项目列表的本地或远程目录）通过命令行
 * 创建并回复 Codex 会话时，Codex 只写 `$CODEX_HOME/sessions/YYYY/MM/DD/rollout-*.jsonl`，
 * 不会主动拉起该目录的 Desktop bridge 进程。通过在持库 Host 侧扫描并监听 `$CODEX_HOME/sessions`，
 * 任意项目或新目录下的会话都能立即入库并触发 `state:projects` 刷新侧栏任务列表。
 */
export function createCodexGlobalRolloutSyncer(options: {
  taskIndexRepo: CodexGlobalRolloutTaskStore;
  resolveWorkspaceIdentity?: (workspacePath: string) => Promise<string | undefined>;
  afterChange?: () => Promise<void> | void;
  env?: NodeJS.ProcessEnv;
}): CodexGlobalRolloutSyncer {
  const cacheByPath = new Map<string, CachedRolloutFile>();
  let disposed = false;
  let watcher: FSWatcher | null = null;
  let cachedThreadNames = new Map<string, string>();
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  let pollTimer: ReturnType<typeof setInterval> | null = null;
  let running: Promise<boolean> | null = null;
  let queued = false;
  let lastIndexMtimeMs = -1;
  let lastIndexSize = -1;

  const runOnce = async (): Promise<boolean> => {
    if (disposed) return false;
    const codexHome = resolveCodexHome(options.env);
    const sessionsRoot = join(codexHome, "sessions");
    const files = await listRolloutFiles(sessionsRoot);
    if (disposed) return false;

    let indexMtimeMs = -1;
    let indexSize = -1;
    try {
      const indexStat = await stat(join(codexHome, "session_index.jsonl"));
      indexMtimeMs = indexStat.mtimeMs;
      indexSize = indexStat.size;
    } catch {
      indexMtimeMs = -1;
      indexSize = -1;
    }
    // 修复原因：原先写成 `indexChanged || files.length > 0` 导致只要本地存在任一 rollout 文件，
    // 每次扫描都会无条件重读并逐行 JSON.parse 整个 session_index.jsonl。
    // 现在仅当 session_index.jsonl 的 mtimeMs 或 size 变化时才重新读取并缓存映射。
    const indexChanged = indexMtimeMs !== lastIndexMtimeMs || indexSize !== lastIndexSize;
    lastIndexMtimeMs = indexMtimeMs;
    lastIndexSize = indexSize;
    if (indexChanged) {
      cachedThreadNames =
        indexMtimeMs >= 0 ? await readThreadNamesIndex(codexHome) : new Map<string, string>();
    }
    const threadNames = cachedThreadNames;

    const seenPaths = new Set<string>();
    const latestBySessionId = new Map<
      string,
      { candidate: ParsedRolloutCandidate; changed: boolean; cacheEntries: CachedRolloutFile[] }
    >();

    const inspectedFiles = await mapBounded(files, ROLLOUT_STAT_CONCURRENCY, async (file) => {
      if (disposed) return null;
      let fileStat;
      try {
        fileStat = await stat(file.path);
      } catch {
        return null;
      }
      const existing = cacheByPath.get(file.path);
      if (existing && existing.mtimeMs === fileStat.mtimeMs && existing.size === fileStat.size) {
        return {
          file,
          entry: existing,
          fileChanged: !existing.synced || indexChanged,
        };
      }
      const candidate = await parseRolloutCandidate(file.path, file.name, fileStat.mtimeMs);
      const entry: CachedRolloutFile = {
        mtimeMs: fileStat.mtimeMs,
        size: fileStat.size,
        synced: false,
        candidate,
      };
      return { file, entry, fileChanged: true };
    });
    if (disposed) return false;

    for (const inspected of inspectedFiles) {
      if (!inspected) continue;
      const { file, entry, fileChanged } = inspected;
      seenPaths.add(file.path);
      cacheByPath.set(file.path, entry);
      if (!entry.candidate) {
        entry.synced = true;
        continue;
      }
      const namedTitle = threadNames.get(entry.candidate.sessionId);
      const effectiveCandidate: ParsedRolloutCandidate = namedTitle
        ? { ...entry.candidate, title: namedTitle }
        : entry.candidate;
      const current = latestBySessionId.get(effectiveCandidate.sessionId);
      if (!current) {
        latestBySessionId.set(effectiveCandidate.sessionId, {
          candidate: effectiveCandidate,
          changed: fileChanged,
          cacheEntries: [entry],
        });
      } else {
        current.cacheEntries.push(entry);
        current.changed ||= fileChanged;
        if (effectiveCandidate.updatedAt >= current.candidate.updatedAt) {
          current.candidate = effectiveCandidate;
        }
      }
    }

    for (const cachedPath of cacheByPath.keys()) {
      if (!seenPaths.has(cachedPath)) {
        cacheByPath.delete(cachedPath);
      }
    }

    let changedAny = false;
    for (const { candidate, changed, cacheEntries } of latestBySessionId.values()) {
      if (!changed || disposed) continue;
      let workspaceIdentity: string | undefined;
      if (options.resolveWorkspaceIdentity) {
        try {
          workspaceIdentity = await options.resolveWorkspaceIdentity(candidate.cwd);
        } catch {
          workspaceIdentity = undefined;
        }
      }
      try {
        const before = await options.taskIndexRepo.getTaskMeta({
          workspacePath: candidate.cwd,
          ...(workspaceIdentity ? { workspaceIdentity } : {}),
          taskId: candidate.sessionId,
        });
        const after = await options.taskIndexRepo.applyCliFacts({
          meta: {
            taskId: candidate.sessionId,
            traceId: generateTraceId(candidate.sessionId),
            title: candidate.title,
            workspacePath: candidate.cwd,
            ...(workspaceIdentity ? { workspaceIdentity } : {}),
            createdAt: candidate.createdAt,
            updatedAt: candidate.updatedAt,
            mode: "default",
            provider: CODEZ_AGENT_PROVIDER,
            ...(candidate.forkedFromTaskId ? { forkedFromTaskId: candidate.forkedFromTaskId } : {}),
            ...(candidate.lastOutcome
              ? { status: candidate.lastOutcome === "error" ? "error" : "completed" }
              : {}),
          },
          ...(candidate.originProjectId !== undefined
            ? { originProjectId: candidate.originProjectId }
            : {}),
          titleSource: "default",
          ...(candidate.lastOutcome ? { lastOutcome: candidate.lastOutcome } : {}),
        });
        for (const cacheEntry of cacheEntries) {
          cacheEntry.synced = true;
        }
        if (
          !before ||
          before.title !== after.title ||
          before.updatedAt !== after.updatedAt ||
          before.status !== after.status
        ) {
          changedAny = true;
        }
      } catch (error) {
        logger.debug("同步全局 Codex rollout 会话失败", {
          sessionId: candidate.sessionId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    return changedAny;
  };

  const sync = async (notifyIfChanged: boolean): Promise<boolean> => {
    if (disposed) return false;
    if (running) {
      queued = true;
      return running;
    }
    const current = (async () => {
      let anyChanged = false;
      do {
        queued = false;
        const changed = await runOnce();
        anyChanged ||= changed;
      } while (queued && !disposed);
      if (anyChanged && notifyIfChanged && !disposed) {
        await options.afterChange?.();
      }
      return anyChanged;
    })().finally(() => {
      if (running === current) {
        running = null;
      }
    });
    running = current;
    return current;
  };

  const scheduleSync = () => {
    if (disposed) return;
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      void sync(true).catch(() => {});
    }, DEBOUNCE_MS);
    debounceTimer.unref?.();
  };

  const startFallbackPoll = () => {
    if (disposed || pollTimer) return;
    pollTimer = setInterval(() => {
      void ensureWatcher();
      void sync(true).catch(() => {});
    }, POLL_INTERVAL_MS);
    pollTimer.unref?.();
  };

  const stopFallbackPoll = () => {
    if (!pollTimer) return;
    clearInterval(pollTimer);
    pollTimer = null;
  };

  const ensureWatcher = async () => {
    if (disposed || watcher) return;
    const codexHome = resolveCodexHome(options.env);
    const sessionsRoot = join(codexHome, "sessions");
    try {
      await mkdir(sessionsRoot, { recursive: true });
      if (disposed || watcher) return;
      watcher = watch(sessionsRoot, { recursive: true }, () => {
        scheduleSync();
      });
      watcher.on("error", () => {
        try {
          watcher?.close();
        } catch {
          // ignore
        }
        watcher = null;
        // recursive watch 异常退化时才启动轮询兜底，避免正常监听期间每 3 秒全量遍历。
        startFallbackPoll();
      });
      watcher.unref?.();
      stopFallbackPoll();
    } catch {
      // 平台不支持 recursive watch（如部分 Linux 内核）时由轻量轮询兜底
      startFallbackPoll();
    }
  };

  return {
    start() {
      if (disposed) return;
      void ensureWatcher();
      void sync(true).catch(() => {});
    },
    syncNow() {
      return sync(false);
    },
    dispose() {
      disposed = true;
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = null;
      stopFallbackPoll();
      try {
        watcher?.close();
      } catch {
        // ignore
      }
      watcher = null;
      cacheByPath.clear();
      cachedThreadNames.clear();
    },
  };
}
