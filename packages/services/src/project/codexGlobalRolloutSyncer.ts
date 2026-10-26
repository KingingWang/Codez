import { watch, type Dirent, type FSWatcher } from "node:fs";
import { mkdir, readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { CODEZ_AGENT_PROVIDER, generateTraceId, type CodezTaskMeta } from "@codez/shared";
import { createServiceLogger } from "#src/logger/serviceLogger.js";
import {
  isRolloutFileName,
  parseRolloutCandidate,
  rolloutStampFromName,
  type ParsedRolloutCandidate,
} from "#src/project/codexRolloutFacts.js";
import {
  loadRolloutScanFacts,
  saveRolloutScanFacts,
  serializeRolloutScanFacts,
} from "#src/project/codexRolloutScanCache.js";

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
/** `$CODEX_HOME/sessions/YYYY/MM/DD` 的最大递归深度，与历史遍历保持一致。 */
const MAX_SESSIONS_TREE_DEPTH = 4;
/**
 * 无 watcher（单测直接 `syncNow()` 或轮询兜底）时，额外 stat 的“最新活跃 rollout”数量。
 *
 * 目录 mtime 剪枝会跳过历史文件的 stat，而追加写入不会改变所在目录的 mtime；
 * 正在被 CLI 追加的会话一定是最新创建的那几个，因此保留极小的活跃尾部窗口兜底，
 * 避免退化模式下的追加更新完全丢失。
 */
const ACTIVE_TAIL_STAT_LIMIT = 8;

interface CachedRolloutFile {
  mtimeMs: number;
  size: number;
  synced: boolean;
  candidate: ParsedRolloutCandidate | null;
  /**
   * `session_meta` 已被过滤器明确拒绝（subagent / selection side chat / 非白名单 source /
   * 缺 cwd）：文件继续增长也不会产出 candidate，后续扫描可永久跳过它的 stat 与解析。
   */
  settled: boolean;
}

/** 目录 mtime 只在直接子项增删改名时推进，追加写入文件不会改变它。 */
interface CachedSessionDir {
  mtimeMs: number;
  rolloutNames: string[];
  childDirs: string[];
}

/**
 * 对比新旧 `session_index.jsonl` 命名映射，只返回真正新增/改名/移除命名的 sessionId。
 *
 * 修复原因：index 变化过去会直接把全量扫描打开，并把所有历史文件的 `fileChanged` 置真，
 * 一次改名被放大成全部任务的 `applyCliFacts` 写事务。
 */
function diffThreadNames(previous: Map<string, string>, next: Map<string, string>): Set<string> {
  const changed = new Set<string>();
  for (const [sessionId, name] of next)
    if (previous.get(sessionId) !== name) changed.add(sessionId);
  for (const sessionId of previous.keys()) if (!next.has(sessionId)) changed.add(sessionId);
  return changed;
}

function resolveCodexHome(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.CODEX_HOME?.trim();
  return override || join(homedir(), ".codex");
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
  /**
   * 解析事实缓存文件路径（必须位于 Codez 自有数据目录，不写 `$CODEX_HOME`）。
   * 省略即保持纯内存缓存行为，现有单测与降级路径不受影响。
   */
  scanCacheFilePath?: string;
}): CodexGlobalRolloutSyncer {
  const cacheByPath = new Map<string, CachedRolloutFile>();
  /** sessionId → 该 session 的全部 rollout 路径；按会话取事实时无需遍历整个缓存。 */
  const pathsBySessionId = new Map<string, Set<string>>();
  /** 已解析出 candidate 但尚未成功入库的 session，下一轮扫描必须重试。 */
  const unsyncedSessionIds = new Set<string>();
  /** 目录级缓存：mtime 未变的目录直接复用上次 readdir 的子项名字。 */
  const dirCache = new Map<string, CachedSessionDir>();
  let disposed = false;
  let watcher: FSWatcher | null = null;
  let cachedThreadNames = new Map<string, string>();
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  let pollTimer: ReturnType<typeof setInterval> | null = null;
  let running: Promise<boolean> | null = null;
  let queued = false;
  /** 首次基线扫描是否完成；未完成前必须整树遍历，之后才允许增量。 */
  let baselineDone = false;
  let needsFullScan = false;
  const pendingWatchPaths = new Set<string>();
  let lastIndexMtimeMs = -1;
  let lastIndexSize = -1;
  /** 解析事实缓存是否已从磁盘载入（每个进程只做一次）。 */
  let scanCacheLoaded = false;
  /** 本轮是否产生了新的解析事实或被摘除的条目；只有内容真变了才落盘。 */
  let scanCacheDirty = false;
  let lastWrittenScanCache: string | undefined;

  const dropSessionPath = (sessionId: string, path: string): void => {
    const paths = pathsBySessionId.get(sessionId);
    if (!paths?.delete(path)) return;
    for (const remaining of paths) {
      const entry = cacheByPath.get(remaining);
      if (entry?.candidate && !entry.synced) return;
    }
    if (paths.size === 0) pathsBySessionId.delete(sessionId);
    unsyncedSessionIds.delete(sessionId);
  };

  const forgetEntry = (path: string): void => {
    const sessionId = cacheByPath.get(path)?.candidate?.sessionId;
    if (!cacheByPath.delete(path)) return;
    scanCacheDirty = true;
    if (sessionId) dropSessionPath(sessionId, path);
  };

  const rememberEntry = (path: string, entry: CachedRolloutFile): void => {
    const previousSessionId = cacheByPath.get(path)?.candidate?.sessionId;
    const nextSessionId = entry.candidate?.sessionId;
    cacheByPath.set(path, entry);
    if (previousSessionId && previousSessionId !== nextSessionId)
      dropSessionPath(previousSessionId, path);
    if (!nextSessionId) return;
    const paths = pathsBySessionId.get(nextSessionId) ?? new Set<string>();
    pathsBySessionId.set(nextSessionId, paths);
    paths.add(path);
    if (!entry.synced) unsyncedSessionIds.add(nextSessionId);
  };

  /**
   * 落盘解析事实，让下一次进程启动不必重新解析未变化的历史 rollout。
   *
   * 修复原因：`baselineDone` 只在内存里，每个进程启动都是一次 full scan，而 full scan 下
   * `cacheByPath` 是空的，于是 1592 个历史 rollout 全部重跑一次 head/tail 解析
   * （实测 1577ms / 读 229MiB，纯 stat 遍历只要 17ms），并且 `readTree` 会 await 这次基线
   * （node.ts 的 `repository()` → syncer `syncNow()` 返回在途基线），成本随历史会话数线性增长。
   * 修复依据：解析结果只取决于文件内容，按 `(mtimeMs, size)` 持久化后即可跨进程复用；
   * 只持久化文件事实、不持久化 `synced`，入库判定仍完全由 tasks-index 现场决定，
   * 因此自愈兜底（删任务/重建库/换 Host 后重新 applyCliFacts）一字未减。
   * 写入在 `sync()` 的串行体内完成，内容未变化时不写，失败只告警不影响同步结果。
   */
  const persistScanCache = async (codexHome: string): Promise<void> => {
    const filePath = options.scanCacheFilePath;
    if (!filePath || !scanCacheDirty || disposed) return;
    const content = serializeRolloutScanFacts(
      codexHome,
      [...cacheByPath].map(([path, entry]) => [
        path,
        {
          mtimeMs: entry.mtimeMs,
          size: entry.size,
          candidate: entry.candidate,
          settled: entry.settled,
        },
      ]),
    );
    if (content === undefined) {
      logger.debug("Codex rollout 解析事实缓存超过条目上限，本轮不落盘", { codexHome });
      return;
    }
    if (content === lastWrittenScanCache) {
      scanCacheDirty = false;
      return;
    }
    try {
      await saveRolloutScanFacts(filePath, content);
      lastWrittenScanCache = content;
      scanCacheDirty = false;
    } catch (error) {
      // 缓存只是加速手段：写失败保持 dirty 等下一轮，绝不让同步本身失败。
      logger.warn("写入 Codex rollout 解析事实缓存失败", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  };

  /**
   * 遍历 `$CODEX_HOME/sessions`，只把本轮真正需要 stat 的 rollout 交给 `addTarget`。
   *
   * 修复原因：过去每次扫描都无条件递归 readdir 整棵树并逐个 stat 历史 rollout，
   * `readTree`/`readProjects` 因此被放大成 O(历史会话数) 的磁盘扫描。现在按目录缓存
   * `mtimeMs` 与子项名字：
   * - 目录 mtime 未变 → 直接子项集合不可能变化，复用缓存名字，跳过 readdir；
   * - 仅对新发现路径、上一轮未成功入库、尚未定型（candidate 仍可能补齐）的文件，
   *   以及文件名时间戳最新的极少数活跃 rollout 做 stat；
   * - `fullScan` 保留首次基线与 watcher 异常后的整树恢复能力。
   */
  const scanSessionsTree = async (
    sessionsRoot: string,
    fullScan: boolean,
    addTarget: (path: string, name: string) => void,
  ): Promise<void> => {
    const visitedDirs = new Set<string>();
    const activeTail: Array<{ path: string; name: string; stamp: string }> = [];

    const consider = (dir: string, name: string): void => {
      const path = join(dir, name);
      if (fullScan) {
        addTarget(path, name);
        return;
      }
      const entry = cacheByPath.get(path);
      if (!entry || !entry.synced || (entry.candidate === null && !entry.settled)) {
        addTarget(path, name);
      }
      // 追加写入不会推进目录 mtime；没有 watcher 事件时，最新创建的少量 rollout
      // 仍可能被 CLI 追加，因此保留极小的活跃尾部窗口兜底。
      activeTail.push({ path, name, stamp: rolloutStampFromName(name) });
      if (activeTail.length > ACTIVE_TAIL_STAT_LIMIT) {
        activeTail.sort((left, right) => left.stamp.localeCompare(right.stamp));
        activeTail.splice(0, activeTail.length - ACTIVE_TAIL_STAT_LIMIT);
      }
    };

    const walk = async (dir: string, depth: number): Promise<void> => {
      if (depth > MAX_SESSIONS_TREE_DEPTH) return;
      visitedDirs.add(dir);
      // 先取 mtime 再 readdir：期间若有新文件落盘，缓存 mtime 会偏旧，
      // 下一轮会重新 readdir，不会把“新名字 + 新 mtime”错误地当成已同步基线。
      let dirMtimeMs = -1;
      try {
        dirMtimeMs = (await stat(dir)).mtimeMs;
      } catch {
        // 目录不可 stat 时保持 -1：永不命中 mtime 复用，下一轮仍会重新 readdir。
      }
      const cached = dirCache.get(dir);
      if (!fullScan && cached && dirMtimeMs >= 0 && cached.mtimeMs === dirMtimeMs) {
        for (const name of cached.rolloutNames) consider(dir, name);
        for (const child of cached.childDirs) await walk(join(dir, child), depth + 1);
        return;
      }
      let entries: Dirent[];
      try {
        entries = await readdir(dir, { withFileTypes: true });
      } catch {
        // 目录被删除或不可读：丢弃目录缓存与其中的文件缓存，避免陈旧事实继续入库。
        dirCache.delete(dir);
        for (const name of cached?.rolloutNames ?? []) forgetEntry(join(dir, name));
        return;
      }
      const rolloutNames: string[] = [];
      const childDirs: string[] = [];
      for (const entry of entries) {
        if (entry.isDirectory()) {
          childDirs.push(entry.name);
        } else if (entry.isFile() && isRolloutFileName(entry.name)) {
          rolloutNames.push(entry.name);
          consider(dir, entry.name);
        }
      }
      if (cached) {
        const alive = new Set(rolloutNames);
        for (const name of cached.rolloutNames) if (!alive.has(name)) forgetEntry(join(dir, name));
      }
      dirCache.set(dir, { mtimeMs: dirMtimeMs, rolloutNames, childDirs });
      for (const child of childDirs) await walk(join(dir, child), depth + 1);
    };

    await walk(sessionsRoot, 0);

    // 整棵日期子目录被删除时不会再被访问到，这里统一清理其目录与文件缓存。
    // Map 迭代器允许删除当前项，因此无需先复制一份 key 数组。
    for (const dir of dirCache.keys()) {
      if (visitedDirs.has(dir)) continue;
      const removed = dirCache.get(dir);
      dirCache.delete(dir);
      for (const name of removed?.rolloutNames ?? []) forgetEntry(join(dir, name));
    }

    for (const item of activeTail) addTarget(item.path, item.name);
  };

  const runOnce = async (): Promise<boolean> => {
    if (disposed) return false;
    const codexHome = resolveCodexHome(options.env);
    const sessionsRoot = join(codexHome, "sessions");

    if (!scanCacheLoaded) {
      scanCacheLoaded = true;
      if (options.scanCacheFilePath) {
        for (const [path, facts] of await loadRolloutScanFacts(
          options.scanCacheFilePath,
          codexHome,
        )) {
          // `synced` 不从磁盘恢复，按「刚解析完、尚未与库对账」的口径重算：
          // 没有 candidate 就没有可入库的事实（与 parseRolloutCandidate 后的赋值完全一致），
          // 有 candidate 则一律视为未入库，交给下面的 before 比较重新确认。
          rememberEntry(path, { ...facts, synced: facts.candidate === null });
        }
      }
    }

    let indexMtimeMs = -1;
    let indexSize = -1;
    try {
      const indexStat = await stat(join(codexHome, "session_index.jsonl"));
      indexMtimeMs = indexStat.mtimeMs;
      indexSize = indexStat.size;
    } catch {
      // session_index.jsonl 还不存在时保持 -1，与“上次也不存在”比较即为未变化。
    }
    // 修复原因：原先写成 `indexChanged || files.length > 0` 导致只要本地存在任一 rollout 文件，
    // 每次扫描都会无条件重读并逐行 JSON.parse 整个 session_index.jsonl。
    // 现在仅当 session_index.jsonl 的 mtimeMs 或 size 变化时才重新读取并缓存映射。
    const indexChanged = indexMtimeMs !== lastIndexMtimeMs || indexSize !== lastIndexSize;
    lastIndexMtimeMs = indexMtimeMs;
    lastIndexSize = indexSize;
    // 修复原因：index 变化过去会把全量扫描打开，并把所有未变化文件的 `fileChanged` 置为
    // `!existing.synced || indexChanged`（即全部为真），一次改名被放大成全部历史会话的
    // `applyCliFacts` 写事务。现在只 diff 出真正新增/改名/移除命名的 sessionId。
    let renamedSessionIds: Set<string> | null = null;
    if (indexChanged) {
      const nextThreadNames =
        indexMtimeMs >= 0 ? await readThreadNamesIndex(codexHome) : new Map<string, string>();
      renamedSessionIds = diffThreadNames(cachedThreadNames, nextThreadNames);
      cachedThreadNames = nextThreadNames;
    }
    const threadNames = cachedThreadNames;

    // watcher 事件先取快照再清空：扫描期间新到的事件保留在集合里，由 `queued` 复扫消费。
    const dirtyPaths = [...pendingWatchPaths];
    pendingWatchPaths.clear();

    const fullScan = !baselineDone || needsFullScan;
    // 修复原因：`syncNow()` 过去无条件 forceFullScan，于是每次 `readTree`/`readProjects`
    // 都会递归遍历整个 sessions 目录并逐个 stat 历史 rollout。基线完成后：
    // - watcher 健康 → 变更已由事件精确投递到 `pendingWatchPaths`，普通读取无需遍历目录；
    // - 无 watcher（单测直接调用或轮询兜底）→ 走目录 mtime 剪枝的增量遍历。
    const watchOnly = !fullScan && watcher !== null;
    if (fullScan) needsFullScan = false;

    const targets: Array<{ path: string; name: string }> = [];
    const targetPaths = new Set<string>();
    const addTarget = (path: string, name: string): void => {
      if (targetPaths.has(path)) return;
      targetPaths.add(path);
      targets.push({ path, name });
    };
    if (!watchOnly) {
      await scanSessionsTree(sessionsRoot, fullScan, addTarget);
      if (fullScan) baselineDone = true;
    }
    for (const path of dirtyPaths) addTarget(path, basename(path));
    if (disposed) return false;

    if (fullScan) {
      // 基线遍历覆盖了整棵树：本轮没被访问到的缓存条目对应已删除或已轮转的 rollout，
      // 不清理会让持久化缓存随时间无界增长，也会让已消失的路径一直被写回磁盘。
      // Map 迭代器允许删除当前项（与下方未访问目录清理同一口径），无需先复制 key 数组。
      for (const path of cacheByPath.keys()) if (!targetPaths.has(path)) forgetEntry(path);
    }

    const inspectedFiles = await mapBounded(targets, ROLLOUT_STAT_CONCURRENCY, async (file) => {
      if (disposed) return null;
      let fileStat;
      try {
        fileStat = await stat(file.path);
      } catch {
        // 文件已删除：连同 session 反向索引一起摘除，避免陈旧事实反复入库。
        forgetEntry(file.path);
        return null;
      }
      const existing = cacheByPath.get(file.path);
      if (existing && existing.mtimeMs === fileStat.mtimeMs && existing.size === fileStat.size) {
        return { file, entry: existing, fileChanged: false };
      }
      const parsed = await parseRolloutCandidate(
        file.path,
        file.name,
        fileStat.mtimeMs,
        fileStat.size,
      );
      const entry: CachedRolloutFile = {
        mtimeMs: fileStat.mtimeMs,
        size: fileStat.size,
        // 没有 candidate 就没有可入库的事实；是否继续 stat 由 `settled` 决定。
        synced: parsed.candidate === null,
        candidate: parsed.candidate,
        settled: parsed.settled,
      };
      return { file, entry, fileChanged: true };
    });
    if (disposed) return false;

    for (const inspected of inspectedFiles) {
      if (!inspected) continue;
      rememberEntry(inspected.file.path, inspected.entry);
      // 只有真正解析过（或被摘除）的条目才需要落盘；命中 (mtimeMs, size) 的复用不产生写入。
      if (inspected.fileChanged) scanCacheDirty = true;
    }

    // 待更新集合只包含：本轮真正变化的文件所属 session、历史遗留未入库的 session，
    // 以及 session_index.jsonl 中命名发生变化的 session。
    const dirtySessionIds = new Set<string>(unsyncedSessionIds);
    for (const inspected of inspectedFiles) {
      const sessionId = inspected?.fileChanged ? inspected.entry.candidate?.sessionId : undefined;
      if (sessionId) dirtySessionIds.add(sessionId);
    }
    // 没有对应 rollout 缓存的命名变化没有事实可写，跳过以免产生无意义的读事务。
    for (const sessionId of renamedSessionIds ?? [])
      if (pathsBySessionId.has(sessionId)) dirtySessionIds.add(sessionId);

    let changedAny = false;
    for (const sessionId of dirtySessionIds) {
      if (disposed) break;
      const paths = pathsBySessionId.get(sessionId);
      if (!paths?.size) {
        unsyncedSessionIds.delete(sessionId);
        continue;
      }
      const sessionEntries: CachedRolloutFile[] = [];
      let candidate: ParsedRolloutCandidate | null = null;
      for (const path of paths) {
        const entry = cacheByPath.get(path);
        if (!entry) continue;
        sessionEntries.push(entry);
        if (!entry.candidate) continue;
        const namedTitle = threadNames.get(entry.candidate.sessionId);
        const effective: ParsedRolloutCandidate = namedTitle
          ? { ...entry.candidate, title: namedTitle }
          : entry.candidate;
        // 同一 session 可能有多份 rollout，事实以 updatedAt 最新的一份为准。
        if (!candidate || effective.updatedAt >= candidate.updatedAt) candidate = effective;
      }
      if (!candidate) {
        unsyncedSessionIds.delete(sessionId);
        for (const entry of sessionEntries) entry.synced = true;
        continue;
      }
      let workspaceIdentity: string | undefined;
      if (options.resolveWorkspaceIdentity) {
        try {
          workspaceIdentity = await options.resolveWorkspaceIdentity(candidate.cwd);
        } catch {
          workspaceIdentity = undefined;
        }
      }
      // 读侧 rowToMeta 把 interrupted 也投影成 completed，这里保持同一口径。
      const nextStatus = candidate.lastOutcome
        ? candidate.lastOutcome === "error"
          ? "error"
          : "completed"
        : undefined;
      try {
        const before = await options.taskIndexRepo.getTaskMeta({
          workspacePath: candidate.cwd,
          ...(workspaceIdentity ? { workspaceIdentity } : {}),
          taskId: candidate.sessionId,
        });
        // 修复原因：事实完全一致时重复 `applyCliFacts` 只是一次无意义的 SQLite 写事务。
        // 手动改名行（`titleOverridden`）无法从 `before.title` 反推 `cli_title`，保守起见
        // 仍然写入；预留行的 title/createdAt 必然与事实不同，因此首次发现（含
        // `originProjectId` 入库）与污染标题修复都不受影响。
        if (
          before &&
          !before.titleOverridden &&
          before.title === candidate.title &&
          before.createdAt === candidate.createdAt &&
          before.updatedAt >= candidate.updatedAt &&
          (nextStatus === undefined || before.status === nextStatus) &&
          (before.forkedFromTaskId ?? undefined) === (candidate.forkedFromTaskId ?? undefined)
        ) {
          for (const entry of sessionEntries) entry.synced = true;
          unsyncedSessionIds.delete(sessionId);
          continue;
        }
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
            ...(nextStatus ? { status: nextStatus } : {}),
          },
          ...(candidate.originProjectId !== undefined
            ? { originProjectId: candidate.originProjectId }
            : {}),
          titleSource: "default",
          ...(candidate.lastOutcome ? { lastOutcome: candidate.lastOutcome } : {}),
        });
        for (const entry of sessionEntries) entry.synced = true;
        unsyncedSessionIds.delete(sessionId);
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

    // 落在 sync() 的串行体内：并发调用者只会排队，不会出现两个写者交错写同一份缓存。
    await persistScanCache(codexHome);
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
      watcher = watch(sessionsRoot, { recursive: true }, (_eventType, filename) => {
        // 只报目录或不报文件名的事件无法定位单个 rollout，交给整树恢复扫描。
        if (typeof filename !== "string" || !filename.trim()) {
          needsFullScan = true;
        } else if (isRolloutFileName(basename(filename))) {
          pendingWatchPaths.add(join(sessionsRoot, filename));
        } else {
          needsFullScan = true;
        }
        scheduleSync();
      });
      watcher.on("error", () => {
        try {
          watcher?.close();
        } catch {
          // ignore
        }
        watcher = null;
        // watcher 断开期间的事件已丢失：标记整树恢复，避免增量扫描长期漏掉这段时间的变更。
        needsFullScan = true;
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
      // 先建立 watcher 再做基线扫描：否则两者之间落盘的新文件既不在基线里，也没有事件。
      void (async () => {
        await ensureWatcher();
        if (disposed) return;
        await sync(true);
      })().catch(() => {});
    },
    syncNow() {
      // 普通 `readTree`/`readProjects` 只做增量对账，不再强制整树 full scan。
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
      pathsBySessionId.clear();
      unsyncedSessionIds.clear();
      dirCache.clear();
      cachedThreadNames.clear();
      scanCacheDirty = false;
      lastWrittenScanCache = undefined;
    },
  };
}
