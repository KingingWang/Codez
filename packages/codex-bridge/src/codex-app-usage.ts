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
  parseRolloutUsage,
  readThreadsFromStateDb,
  readTurnsFromHistoryDb,
  resolveLatestSqliteFile,
  type ThreadRow,
  type TokenBreakdown,
  type TurnRecord,
  type UsageEventSample,
} from "./codex-app-usage-store.js";

const DAY_MS = 86_400_000;
const ROLLOUT_USAGE_CONCURRENCY = 8;
const RANGE_DAYS: Record<Exclude<AppUsageRange, "all">, number> = {
  "7d": 7,
  "30d": 30,
};

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

/**
 * 聚合 `CODEX_HOME`（默认 `~/.codex`）下的本地持久化记录，生成 `AppUsageSnapshot`。
 */
export async function queryCodexAppUsageStats(
  rawParams: unknown,
  options?: { env?: NodeJS.ProcessEnv; now?: number },
): Promise<AppUsageSnapshot> {
  const params = v4UsageStatsParamsSchema.parse(rawParams ?? {});
  const timeZone = params.timeZone?.trim() || "UTC";
  const until = options?.now ?? Date.now();
  const tzOffsetMs = resolveTzOffsetMs(timeZone, until);
  const since = params.range === "all" ? 0 : until - RANGE_DAYS[params.range] * DAY_MS;
  const codexHome = resolveCodexHomeDir(options?.env ?? process.env);
  const [stateDbPath, historyDbPath] = await Promise.all([
    resolveLatestSqliteFile(codexHome, "state_"),
    resolveLatestSqliteFile(codexHome, "thread_history_"),
  ]);
  const threads: ThreadRow[] = stateDbPath ? readThreadsFromStateDb(stateDbPath) : [];
  const turns: TurnRecord[] = historyDbPath ? readTurnsFromHistoryDb(historyDbPath) : [];

  const allSamples: UsageEventSample[] = [];
  const turnTimestampsByThread = new Map<string, number[]>();
  for (const turn of turns) {
    if (turn.startedAtMs <= 0) continue;
    const list = turnTimestampsByThread.get(turn.threadId) ?? [];
    list.push(turn.startedAtMs);
    turnTimestampsByThread.set(turn.threadId, list);
  }

  // 修复原因：7d/30d 查询过去也无条件串行读取全部历史线程的 rollout 文件，
  // 且 AppUsagePanel 首次挂载会同时请求 all 与 7d/30d。这里先过滤完全早于 since 的旧线程，
  // 并使用有界并发读取 rollout（与 parseRolloutUsage 的 in-flight 合并配合消除重复读盘）。
  const candidateThreads =
    since <= 0
      ? threads
      : threads.filter((thread) => {
          const latestThreadTs = Math.max(thread.updatedAtMs, thread.createdAtMs);
          if (latestThreadTs <= 0 || latestThreadTs >= since) return true;
          const turnTsList = turnTimestampsByThread.get(thread.id);
          return turnTsList ? turnTsList.some((ts) => ts >= since) : false;
        });

  const threadRollouts = await mapBounded(
    candidateThreads,
    ROLLOUT_USAGE_CONCURRENCY,
    async (thread) => ({
      thread,
      rollout: await parseRolloutUsage(
        thread.rolloutPath,
        thread.model,
        thread.updatedAtMs || thread.createdAtMs || until,
      ),
    }),
  );

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
  }

  const filteredSamples = allSamples.filter(
    (s) => s.timestampMs >= since && s.timestampMs <= until && s.totalTokens > 0,
  );

  const totals = emptyBreakdown();
  const dayTotals = new Map<number, { totalTokens: number; turnCount: number }>();
  const dayModels = new Map<number, Map<string | null, TokenBreakdown>>();
  const modelTotals = new Map<string | null, TokenBreakdown>();

  for (const sample of filteredSamples) {
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
    }
  }

  const sessionDurationByThread = new Map<string, number>();
  for (const turn of turns) {
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
    params.range !== "all"
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
    range: params.range,
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
