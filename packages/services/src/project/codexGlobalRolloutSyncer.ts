import { watch, type FSWatcher } from "node:fs";
import { mkdir, readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { CODEZ_AGENT_PROVIDER, generateTraceId, type CodezTaskMeta } from "@codez/shared";
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
const MAX_ROLLOUT_HEAD_BYTES = 128 * 1024;
const PROJECT_SOURCE_PREFIX = "codez_project:";
const UNCLASSIFIED_SOURCE = "codez_unclassified";
const SELECTION_SIDE_CHAT_THREAD_SOURCE = "codez_selection_side_chat";
const ALLOWED_SOURCES = new Set(["cli", "vscode", "exec", "appServer", "app_server"]);

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

function parseEventPreview(event: Record<string, unknown>): string {
  const type = typeof event.type === "string" ? event.type : "";
  if (type === "user_message" || type === "userMessage") {
    if (typeof event.message === "string" && event.message.trim()) {
      return event.message.trim();
    }
    return extractTextFromContent(event.content);
  }
  if (type === "item_completed" || type === "itemCompleted") {
    const item =
      event.item && typeof event.item === "object" && !Array.isArray(event.item)
        ? (event.item as Record<string, unknown>)
        : null;
    if (!item) return "";
    const itemType = typeof item.type === "string" ? item.type : "";
    if (itemType === "userMessage" || itemType === "user_message") {
      if (typeof item.message === "string" && item.message.trim()) {
        return item.message.trim();
      }
      return extractTextFromContent(item.content);
    }
  }
  if (type === "thread_goal_updated" || type === "threadGoalUpdated") {
    const goal =
      event.goal && typeof event.goal === "object" && !Array.isArray(event.goal)
        ? (event.goal as Record<string, unknown>)
        : null;
    if (goal && typeof goal.objective === "string") {
      return goal.objective.trim();
    }
  }
  return "";
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
  let preview = "";
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

    if (!preview) {
      if (type === "event_msg" || type === "eventMsg") {
        preview = parseEventPreview(payload);
      } else if (type === "response_item" || type === "responseItem") {
        const item =
          payload.item && typeof payload.item === "object" && !Array.isArray(payload.item)
            ? (payload.item as Record<string, unknown>)
            : payload;
        if (item.role === "user") {
          preview = extractTextFromContent(item.content);
        }
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
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  let pollTimer: ReturnType<typeof setInterval> | null = null;
  let running: Promise<boolean> | null = null;
  let queued = false;
  let lastIndexMtimeMs = -1;

  const runOnce = async (): Promise<boolean> => {
    if (disposed) return false;
    const codexHome = resolveCodexHome(options.env);
    const sessionsRoot = join(codexHome, "sessions");
    const files = await listRolloutFiles(sessionsRoot);
    if (disposed) return false;

    let indexMtimeMs = -1;
    try {
      indexMtimeMs = (await stat(join(codexHome, "session_index.jsonl"))).mtimeMs;
    } catch {
      indexMtimeMs = -1;
    }
    const indexChanged = indexMtimeMs !== lastIndexMtimeMs;
    lastIndexMtimeMs = indexMtimeMs;
    const threadNames =
      indexChanged || files.length > 0
        ? await readThreadNamesIndex(codexHome)
        : new Map<string, string>();

    const seenPaths = new Set<string>();
    const latestBySessionId = new Map<
      string,
      { candidate: ParsedRolloutCandidate; changed: boolean; cacheEntries: CachedRolloutFile[] }
    >();

    for (const file of files) {
      if (disposed) return false;
      seenPaths.add(file.path);
      let fileStat;
      try {
        fileStat = await stat(file.path);
      } catch {
        continue;
      }
      const existing = cacheByPath.get(file.path);
      let entry: CachedRolloutFile;
      let fileChanged = false;
      if (existing && existing.mtimeMs === fileStat.mtimeMs && existing.size === fileStat.size) {
        entry = existing;
        fileChanged = !existing.synced || indexChanged;
      } else {
        const candidate = await parseRolloutCandidate(file.path, file.name, fileStat.mtimeMs);
        entry = {
          mtimeMs: fileStat.mtimeMs,
          size: fileStat.size,
          synced: false,
          candidate,
        };
        cacheByPath.set(file.path, entry);
        fileChanged = true;
      }
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
      });
      watcher.unref?.();
    } catch {
      // 平台不支持 recursive watch（如部分 Linux 内核）时由轻量轮询兜底
    }
  };

  return {
    start() {
      if (disposed) return;
      void ensureWatcher();
      void sync(true).catch(() => {});
      if (!pollTimer) {
        pollTimer = setInterval(() => {
          void ensureWatcher();
          void sync(true).catch(() => {});
        }, POLL_INTERVAL_MS);
        pollTimer.unref?.();
      }
    },
    syncNow() {
      return sync(false);
    },
    dispose() {
      disposed = true;
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = null;
      if (pollTimer) clearInterval(pollTimer);
      pollTimer = null;
      try {
        watcher?.close();
      } catch {
        // ignore
      }
      watcher = null;
      cacheByPath.clear();
    },
  };
}
