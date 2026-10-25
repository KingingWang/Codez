import type {
  AppUsageHeatmapCell,
  AppUsageHeatmapWeek,
  AppUsageRange,
  AppUsageSnapshot,
} from "@codez/shared";
import {
  v4UsageStatsParamsSchema,
  v4UsageStatsResultSchema,
} from "@codez/shared/codez-protocol-v4";
import { resolveCodexHomeDir } from "./default-codex-config.js";
import {
  EVENT_LOOP_YIELD_SLICE_MS,
  parseRolloutUsage,
  readDbFingerprint,
  readThreadsFromStateDb,
  readTurnsFromHistoryDb,
  resolveLatestSqliteFile,
  yieldToEventLoop,
  type DbFingerprint,
  type ThreadRow,
  type TokenBreakdown,
  type TurnRecord,
  type UsageEventSample,
} from "./codex-app-usage-store.js";

const DAY_MS = 86_400_000;
const ROLLOUT_USAGE_CONCURRENCY = 8;
// 结果缓存上限：key 内含 DB 指纹，过期条目只是占位，LRU 淘汰即可，无需 TTL
const USAGE_RESULT_CACHE_LIMIT = 24;
const RANGE_DAYS: Record<Exclude<AppUsageRange, "all">, number> = {
  "7d": 7,
  "30d": 30,
};

const usageResultCache = new Map<string, AppUsageSnapshot>();
const usageResultInFlight = new Map<string, Promise<AppUsageSnapshot>>();

async function mapBounded<T, R>(
  items: readonly T[],
  limit: number,
  operation: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = Array.from({ length: items.length });
  let next = 0;
  async function worker(): Promise<void> {
    while (next < items.length) {
      const sliceStartedAt = Date.now();
      const index = next++;
      results[index] = await operation(items[index]!);
      // rollout 命中解析缓存时 operation 内部几乎没有真正的宏任务让出点（await 只走微任务队列），
      // 几千个线程连续扫描会把 bridge 的 stdio 消息处理饿死，因此按时间片主动让出事件循环。
      if (Date.now() - sliceStartedAt > EVENT_LOOP_YIELD_SLICE_MS) {
        await yieldToEventLoop();
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

export function resolveTzOffsetMs(timeZone: string, atMs: number): number {
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    }).formatToParts(new Date(atMs));
    const lookup = (type: string) => Number(parts.find((p) => p.type === type)?.value);
    const asUtc = Date.UTC(
      lookup("year"),
      lookup("month") - 1,
      lookup("day"),
      lookup("hour"),
      lookup("minute"),
      lookup("second"),
    );
    return asUtc - Math.trunc(atMs / 1000) * 1000;
  } catch {
    return 0;
  }
}

function dayIndexFor(timestampMs: number, tzOffsetMs: number): number {
  return Math.floor((timestampMs + tzOffsetMs) / DAY_MS);
}

function dayIndexToDate(dayIndex: number): string {
  return new Date(dayIndex * DAY_MS).toISOString().slice(0, 10);
}

function levelFor(tokens: number, max: number): AppUsageHeatmapCell["level"] {
  if (tokens <= 0 || max <= 0) return 0;
  const ratio = tokens / max;
  if (ratio > 0.75) return 4;
  if (ratio > 0.5) return 3;
  if (ratio > 0.25) return 2;
  return 1;
}

function emptyBreakdown(): TokenBreakdown {
  return {
    totalTokens: 0,
    inputTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
    requestCount: 0,
  };
}

function addBreakdown(target: TokenBreakdown, sample: TokenBreakdown): TokenBreakdown {
  target.totalTokens += sample.totalTokens;
  target.inputTokens += sample.inputTokens;
  target.outputTokens += sample.outputTokens;
  target.reasoningTokens += sample.reasoningTokens;
  target.cacheCreationTokens += sample.cacheCreationTokens;
  target.cacheReadTokens += sample.cacheReadTokens;
  target.requestCount += sample.requestCount;
  return target;
}

function fallbackSample(
  timestampMs: number,
  modelId: string | null,
  tokens: number,
): UsageEventSample {
  return {
    timestampMs,
    modelId,
    totalTokens: tokens,
    inputTokens: tokens,
    outputTokens: 0,
    reasoningTokens: 0,
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
    requestCount: 1,
  };
}

function fingerprintKeyPart(fingerprint: DbFingerprint | null): string {
  return fingerprint ? `${fingerprint.mtimeMs}:${fingerprint.size}` : "none";
}

function rememberUsageResult(cacheKey: string, snapshot: AppUsageSnapshot): void {
  usageResultCache.delete(cacheKey);
  usageResultCache.set(cacheKey, snapshot);
  while (usageResultCache.size > USAGE_RESULT_CACHE_LIMIT) {
    const oldest = usageResultCache.keys().next();
    if (oldest.done) break;
    usageResultCache.delete(oldest.value);
  }
}

interface UsageComputeContext {
  range: AppUsageRange;
  timeZone: string;
  until: number;
  tzOffsetMs: number;
  stateDbPath: string | null;
  historyDbPath: string | null;
  stateFingerprint: DbFingerprint | null;
  historyFingerprint: DbFingerprint | null;
}

/**
 * 聚合 `CODEX_HOME`（默认 `~/.codex`）下的本地持久化记录，生成 `AppUsageSnapshot`。
 *
 * 结果缓存与 in-flight 合并的唯一所有者是本模块的两个 Map（store 只拥有 DB 行缓存与 rollout 解析缓存）：
 *
 * - key = (codexHome, stateDb 指纹, historyDb 指纹, range, timeZone, dayBucket)；指纹覆盖主库与 `-wal`，
 *   DB 一有写入就立刻变化，缓存随之立即失效，因此不需要 TTL；
 * - 同 key 的并发与重复请求合并成一个 in-flight 计算（面板挂载会同时请求 all/7d/30d，切 range 会重复请求）；
 * - dayBucket 承担热力图与滚动窗口的按天推进。取舍：同一 day bucket 内重复请求复用首个结果，
 *   所以 `7d`/`30d` 的滚动边界样本最多滞后到当天结束或下一次 DB 写入；换来的是重复请求
 *   0 次 SQLite IO、0 次 rollout 读盘，对统计面板是合适的取舍；
 * - 命中缓存返回同一个快照实例，调用方按只读契约使用，不得原地修改。
 */
export async function queryCodexAppUsageStats(
  rawParams: unknown,
  options?: { env?: NodeJS.ProcessEnv; now?: number },
): Promise<AppUsageSnapshot> {
  const params = v4UsageStatsParamsSchema.parse(rawParams ?? {});
  const timeZone = params.timeZone?.trim() || "UTC";
  const until = options?.now ?? Date.now();
  const codexHome = resolveCodexHomeDir(options?.env ?? process.env);
  const [stateDbPath, historyDbPath] = await Promise.all([
    resolveLatestSqliteFile(codexHome, "state_"),
    resolveLatestSqliteFile(codexHome, "thread_history_"),
  ]);
  // 指纹必须在读之前取：它是「能不能直接用结果缓存」的唯一依据，
  // 同时透传给 store，保证同一次查询的缓存判定与结果 key 用的是同一份指纹。
  const [stateFingerprint, historyFingerprint] = await Promise.all([
    stateDbPath ? readDbFingerprint(stateDbPath) : Promise.resolve(null),
    historyDbPath ? readDbFingerprint(historyDbPath) : Promise.resolve(null),
  ]);
  const tzOffsetMs = resolveTzOffsetMs(timeZone, until);
  const cacheKey = [
    codexHome,
    fingerprintKeyPart(stateFingerprint),
    fingerprintKeyPart(historyFingerprint),
    params.range,
    timeZone,
    dayIndexFor(until, tzOffsetMs),
  ].join("\u0000");

  const cachedSnapshot = usageResultCache.get(cacheKey);
  if (cachedSnapshot) {
    usageResultCache.delete(cacheKey);
    usageResultCache.set(cacheKey, cachedSnapshot);
    return cachedSnapshot;
  }
  const inFlight = usageResultInFlight.get(cacheKey);
  if (inFlight) return inFlight;

  const pending = computeCodexAppUsageStats({
    range: params.range,
    timeZone,
    until,
    tzOffsetMs,
    stateDbPath,
    historyDbPath,
    stateFingerprint,
    historyFingerprint,
  })
    .then((snapshot) => {
      rememberUsageResult(cacheKey, snapshot);
      return snapshot;
    })
    .finally(() => {
      if (usageResultInFlight.get(cacheKey) === pending) usageResultInFlight.delete(cacheKey);
    });
  usageResultInFlight.set(cacheKey, pending);
  return pending;
}

async function computeCodexAppUsageStats(context: UsageComputeContext): Promise<AppUsageSnapshot> {
  const { range, timeZone, until, tzOffsetMs, stateDbPath, historyDbPath } = context;
  const since = range === "all" ? 0 : until - RANGE_DAYS[range] * DAY_MS;

  // 先读 thread_turns（时间窗已下推到 SQL WHERE），得到窗口内活跃线程 id；再读 threads 时把
  // since 与活跃 id 一起下推。这样既不会把成千上万条明显早于窗口的历史线程行读进内存，
  // 也不会为它们读 rollout 文件——大历史库下 rollout 读盘才是主要开销。
  const turnRows = historyDbPath
    ? await readTurnsFromHistoryDb(historyDbPath, {
        sinceMs: since,
        untilMs: until,
        fingerprint: context.historyFingerprint,
      })
    : null;
  const turns: TurnRecord[] = turnRows?.rows ?? [];
  const activeThreadIds = new Set<string>();
  for (const turn of turns) {
    if (turn.threadId.length > 0) activeThreadIds.add(turn.threadId);
  }
  const threadRows = stateDbPath
    ? await readThreadsFromStateDb(stateDbPath, {
        sinceMs: since,
        activeThreadIds,
        fingerprint: context.stateFingerprint,
      })
    : null;
  const threads: ThreadRow[] = threadRows?.rows ?? [];

  const allSamples: UsageEventSample[] = [];
  const turnTimestampsByThread = new Map<string, number[]>();
  for (const turn of turns) {
    if (turn.startedAtMs <= 0) continue;
    const list = turnTimestampsByThread.get(turn.threadId) ?? [];
    list.push(turn.startedAtMs);
    turnTimestampsByThread.set(turn.threadId, list);
  }

  // 时间窗过滤已由 store 在 SQL（或全表内存缓存）层完成，这里不再保留第二条过滤路径，
  // 否则「哪些线程该读 rollout」会有两个可能分歧的判定。rollout 仍用有界并发读取，
  // 并依赖 parseRolloutUsage 的 in-flight 合并，使 all/7d/30d 并发时每个文件只读一次。
  const threadRollouts = await mapBounded(threads, ROLLOUT_USAGE_CONCURRENCY, async (thread) => ({
    thread,
    rollout: await parseRolloutUsage(
      thread.rolloutPath,
      thread.model,
      thread.updatedAtMs || thread.createdAtMs || until,
    ),
  }));

  let sliceStartedAt = Date.now();
  // 每 256 项才查一次时钟，且只有真的超片才 await，避免逐项分配 Promise 的开销盖过聚合本身
  const shouldYieldSlice = (itemCount: number): boolean =>
    itemCount % 256 === 0 && Date.now() - sliceStartedAt > EVENT_LOOP_YIELD_SLICE_MS;
  const yieldSlice = async (): Promise<void> => {
    await yieldToEventLoop();
    sliceStartedAt = Date.now();
  };

  let processedThreads = 0;
  for (const { thread, rollout } of threadRollouts) {
    if (rollout && rollout.samples.length > 0) {
      for (const sample of rollout.samples) {
        allSamples.push(sample);
      }
      const rolloutSum = rollout.samples.reduce((sum, s) => sum + s.totalTokens, 0);
      // Fork 线程的 rollout 只包含续写后的事件；若 threads.tokens_used 高于 rollout 增量且未计入父线程，
      // 以 rollout 实测增量加上差值兜底归入线程创建日（仅当差值有效且无单独父 rollout 覆盖时）。
      if (!thread.rolloutPath.includes("_") && thread.tokensUsed > rolloutSum) {
        allSamples.push(
          fallbackSample(
            thread.createdAtMs || thread.updatedAtMs || until,
            thread.model,
            thread.tokensUsed - rolloutSum,
          ),
        );
      }
      if (!turnTimestampsByThread.has(thread.id) && rollout.turnTimestampsMs.length > 0) {
        turnTimestampsByThread.set(thread.id, rollout.turnTimestampsMs);
      }
    } else if (thread.tokensUsed > 0) {
      // 历史会话 rollout 文件已被归档或清理时，回退使用 threads 表的 tokens_used 与 updated_at。
      const ts = thread.updatedAtMs || thread.createdAtMs || until;
      allSamples.push(fallbackSample(ts, thread.model, thread.tokensUsed));
      if (!turnTimestampsByThread.has(thread.id)) {
        turnTimestampsByThread.set(thread.id, [ts]);
      }
    }
    processedThreads += 1;
    if (shouldYieldSlice(processedThreads)) await yieldSlice();
  }

  const totals = emptyBreakdown();
  const dayTotals = new Map<number, { totalTokens: number; turnCount: number }>();
  const dayModels = new Map<number, Map<string | null, TokenBreakdown>>();
  const modelTotals = new Map<string | null, TokenBreakdown>();

  // 单趟完成「时间窗过滤 + 聚合」：旧实现先 filter 出中间数组再遍历一次，
  // 大历史库下等于两趟全量扫描外加一个常驻中间数组。
  let processedSamples = 0;
  for (const sample of allSamples) {
    // 计数放在过滤之前：被跳过的样本同样要参与时间片判定，否则大历史库下不会让出事件循环
    processedSamples += 1;
    if (shouldYieldSlice(processedSamples)) await yieldSlice();
    if (sample.timestampMs < since || sample.timestampMs > until || sample.totalTokens <= 0) {
      continue;
    }
    addBreakdown(totals, sample);

    const di = dayIndexFor(sample.timestampMs, tzOffsetMs);
    const dayEntry = dayTotals.get(di) ?? { totalTokens: 0, turnCount: 0 };
    dayEntry.totalTokens += sample.totalTokens;
    dayTotals.set(di, dayEntry);

    const dmInner = dayModels.get(di) ?? new Map<string | null, TokenBreakdown>();
    dmInner.set(
      sample.modelId,
      addBreakdown(dmInner.get(sample.modelId) ?? emptyBreakdown(), sample),
    );
    dayModels.set(di, dmInner);

    modelTotals.set(
      sample.modelId,
      addBreakdown(modelTotals.get(sample.modelId) ?? emptyBreakdown(), sample),
    );
  }

  // 统计区间内的会话数、轮次数与最长会话时长
  let totalTurns = 0;
  let processedTurns = 0;
  for (const [, tsList] of turnTimestampsByThread) {
    for (const ts of tsList) {
      if (ts >= since && ts <= until) {
        totalTurns++;
        const di = dayIndexFor(ts, tzOffsetMs);
        const dayEntry = dayTotals.get(di);
        if (dayEntry) {
          dayEntry.turnCount += 1;
        }
      }
      processedTurns += 1;
      if (shouldYieldSlice(processedTurns)) await yieldSlice();
    }
  }

  const sessionDurationByThread = new Map<string, number>();
  let processedDurationTurns = 0;
  for (const turn of turns) {
    // 计数放在过滤之前：被跳过的行同样消耗 CPU，否则时间片永远不会触发
    processedDurationTurns += 1;
    if (shouldYieldSlice(processedDurationTurns)) await yieldSlice();
    if (turn.startedAtMs < since || turn.startedAtMs > until) continue;
    if (turn.durationMs <= 0) continue;
    sessionDurationByThread.set(
      turn.threadId,
      (sessionDurationByThread.get(turn.threadId) ?? 0) + turn.durationMs,
    );
  }
  let longestSessionMs = 0;
  for (const dur of sessionDurationByThread.values()) {
    longestSessionMs = Math.max(longestSessionMs, dur);
  }
  if (longestSessionMs === 0) {
    // 若无 thread_turns 明细，则用会话活跃跨度（上限单次会话 24 小时防止跨周挂起失真）兜底
    for (const thread of threads) {
      const refTs = thread.updatedAtMs || thread.createdAtMs;
      if (refTs < since || refTs > until) continue;
      const span = Math.max(0, thread.updatedAtMs - thread.createdAtMs);
      if (span > 0 && span <= DAY_MS) {
        longestSessionMs = Math.max(longestSessionMs, span);
      }
    }
  }

  const totalSessions = threads.filter((t) => {
    const refTs = t.updatedAtMs || t.createdAtMs;
    return t.tokensUsed > 0 && refTs >= since && refTs <= until;
  }).length;

  const endDayIndex = dayIndexFor(until, tzOffsetMs);
  const allDayIndexes = [...dayTotals.keys()];
  const startDayIndex =
    range !== "all"
      ? dayIndexFor(since, tzOffsetMs)
      : allDayIndexes.length > 0
        ? Math.min(...allDayIndexes)
        : endDayIndex;

  let activeDays = 0;
  let currentStreakDays = 0;
  let longestStreakDays = 0;
  let runningStreakDays = 0;
  let streakBroken = false;
  let peakDayTokens = 0;

  for (const d of dayTotals.values()) {
    peakDayTokens = Math.max(peakDayTokens, d.totalTokens);
    if (d.totalTokens > 0 && d.turnCount === 0) {
      d.turnCount = 1;
    }
  }

  for (let di = endDayIndex; di >= startDayIndex; di--) {
    const tokens = dayTotals.get(di)?.totalTokens ?? 0;
    if (tokens > 0) {
      activeDays++;
      runningStreakDays++;
      longestStreakDays = Math.max(longestStreakDays, runningStreakDays);
      if (!streakBroken) currentStreakDays++;
    } else if (!streakBroken) {
      streakBroken = true;
      runningStreakDays = 0;
    } else {
      runningStreakDays = 0;
    }
  }

  const weeks: AppUsageHeatmapWeek[] = [];
  let week: Array<AppUsageHeatmapCell | null> = [];
  for (let di = startDayIndex; di <= endDayIndex; di++) {
    const day = dayTotals.get(di);
    week.push({
      date: dayIndexToDate(di),
      level: levelFor(day?.totalTokens ?? 0, peakDayTokens),
      totalTokens: day?.totalTokens ?? 0,
      turnCount: day?.turnCount ?? 0,
      toolCallCount: 0,
    });
    if (week.length === 7) {
      weeks.push({ weekIndex: weeks.length, days: week });
      week = [];
    }
  }
  if (week.length > 0) {
    while (week.length < 7) week.push(null);
    weeks.push({ weekIndex: weeks.length, days: week });
  }

  const dailyModelUsage: AppUsageSnapshot["dailyModelUsage"] = [];
  for (let di = startDayIndex; di <= endDayIndex; di++) {
    const inner = dayModels.get(di);
    dailyModelUsage.push({
      date: dayIndexToDate(di),
      models: inner
        ? [...inner.entries()]
            .sort((a, b) => b[1].totalTokens - a[1].totalTokens)
            .map(([modelId, item]) => ({
              modelId,
              totalTokens: item.totalTokens,
              inputTokens: item.inputTokens,
              outputTokens: item.outputTokens,
              cacheReadTokens: item.cacheReadTokens,
              cacheCreationTokens: item.cacheCreationTokens,
            }))
        : [],
    });
  }

  const sortedModels = [...modelTotals.entries()].sort(
    (a, b) => b[1].totalTokens - a[1].totalTokens,
  );
  const totalModelTokens = sortedModels.reduce((sum, [, item]) => sum + item.totalTokens, 0);
  const models: AppUsageSnapshot["models"] = sortedModels.map(([modelId, item]) => ({
    modelId,
    totalTokens: item.totalTokens,
    inputTokens: item.inputTokens,
    outputTokens: item.outputTokens,
    cacheReadTokens: item.cacheReadTokens,
    cacheCreationTokens: item.cacheCreationTokens,
    requestCount: item.requestCount,
    share: totalModelTokens > 0 ? item.totalTokens / totalModelTokens : 0,
  }));

  const topModel = models[0];
  const favoriteModel = topModel
    ? {
        modelId: topModel.modelId,
        totalTokens: topModel.totalTokens,
        share: topModel.share,
      }
    : null;

  const cacheDenom =
    totals.inputTokens > 0
      ? totals.inputTokens
      : totals.cacheCreationTokens + totals.cacheReadTokens;
  const cacheHitRate = cacheDenom > 0 ? totals.cacheReadTokens / cacheDenom : 0;

  return v4UsageStatsResultSchema.parse({
    range,
    generatedAt: until,
    timeZone,
    source: "agent-db",
    summary: {
      totalTokens: totals.totalTokens,
      inputTokens: totals.inputTokens,
      outputTokens: totals.outputTokens,
      reasoningTokens: totals.reasoningTokens,
      cacheCreationTokens: totals.cacheCreationTokens,
      cacheReadTokens: totals.cacheReadTokens,
      cacheHitRate,
      totalSessions,
      totalTurns,
      toolCallCount: 0,
      toolErrorRate: 0,
      modelErrorRate: 0,
      avgTimeToFirstTokenMs: null,
      avgTurnDurationMs: null,
      activeDays,
      currentStreakDays,
      longestSessionMs,
      longestStreakDays,
      peakDayTokens,
      favoriteModel,
    },
    heatmap: {
      startDate: dayIndexToDate(startDayIndex),
      endDate: dayIndexToDate(endDayIndex),
      maxTokens: peakDayTokens,
      weeks,
    },
    dailyModelUsage,
    models,
    tools: [],
  });
}
