import { RefreshCcw } from "lucide-react";
import { Fragment, lazy, useCallback, useEffect, useState } from "react";
import { APP_USAGE_RANGES } from "@codez/shared";
import type { AppUsageRange, AppUsageSnapshot } from "@codez/shared";
import { Button } from "@/components/ui/button.js";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs.js";
import { useCodezIntl } from "@/i18n/IntlProvider.js";
import { useServices } from "@/hooks/useServices.js";
import { useAppUsageStats } from "@/hooks/useUsageStats.js";
import { UsageChartLoadBoundary } from "@/settings/usage-stats/UsageChartLoadBoundary.js";
import { UsageHeatmap } from "@/settings/usage-stats/UsageHeatmap.js";
import { logger } from "@/logger.js";
import {
  normalizeCodexUsageThreads,
  type CodexObservedUsageInput,
  type CodexUsageObservationsSnapshot,
} from "./codexUsageThreads.js";
import { UsageStatsErrorNotice } from "@/settings/usage-stats/UsageStatsErrorNotice.js";
import {
  USAGE_STATS_TABS_LIST_CLASS,
  USAGE_STATS_TABS_TRIGGER_CLASS,
  UsageEmptyState,
  formatCompactNumber,
  formatCompactTokenUsage,
  formatSummaryCompactTokenUsage,
} from "@/settings/usage-stats/usageStatsUiParts.js";

// Recharts 会在模块初始化阶段触发 decimal.js-light 的 LN10 校验，
// 在 Electron Linux 容器里会阻断整个 renderer 启动。图表按需加载后，
// 普通启动和 e2e 首页不会被 Usage 页图表依赖影响，打开 Usage 时也由局部边界隔离。
const AppUsageDailyModelTrendChart = lazy(() =>
  import("@/settings/usage-stats/AppUsageDailyModelTrendChart.js").then((module) => ({
    default: module.AppUsageDailyModelTrendChart,
  })),
);
const AppUsageModelUsagePieChart = lazy(() =>
  import("@/settings/usage-stats/AppUsageModelUsagePieChart.js").then((module) => ({
    default: module.AppUsageModelUsagePieChart,
  })),
);

export const CODEX_APP_USAGE_OBSERVATION_COPY_ID = "settings.usage.appUsage.observationNotice";

function useCodexUsageObservations(workspace: {
  workspaceIdentity?: string;
  workspacePath?: string;
}) {
  const { usageStatsService } = useServices();
  const [snapshot, setSnapshot] = useState<CodexUsageObservationsSnapshot | null>(null);
  const refresh = useCallback(async () => {
    const workspacePath = workspace.workspacePath?.trim();
    if (!workspacePath) {
      setSnapshot(null);
      return;
    }
    const service = usageStatsService;
    if (typeof service.getCodexUsageObservations !== "function") {
      setSnapshot(null);
      return;
    }
    try {
      const raw = await service.getCodexUsageObservations({
        workspacePath,
        ...(workspace.workspaceIdentity?.trim()
          ? { workspaceIdentity: workspace.workspaceIdentity.trim() }
          : {}),
      });
      setSnapshot({
        threads: normalizeCodexUsageThreads((raw as { threads?: unknown }).threads),
        conflict: Boolean((raw as { conflict?: unknown }).conflict),
        stale: Boolean((raw as { stale?: unknown }).stale),
      });
    } catch (error) {
      logger.warn("[codex-usage] Reading desktop observations failed", {
        error: error instanceof Error ? error.message : String(error),
        workspaceIdentity: workspace.workspaceIdentity ?? null,
        workspacePath,
      });
    }
  }, [usageStatsService, workspace.workspaceIdentity, workspace.workspacePath]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return { snapshot, refresh };
}

function CodexUsageObservationNotice({ intl }: { intl: ReturnType<typeof useCodezIntl>["intl"] }) {
  return (
    <p className="text-ui-sm text-foreground-subtle" data-testid="codex-usage-observation-notice">
      {intl.formatMessage({ id: CODEX_APP_USAGE_OBSERVATION_COPY_ID })}
    </p>
  );
}

export function buildCodexUsageObservationTotals(
  threads: Iterable<{ observation: { payload: CodexObservedUsageInput } }>,
) {
  return [...threads].reduce(
    (totals, thread) => {
      const usage = thread.observation.payload;
      return {
        threads: totals.threads + 1,
        inputTokens: totals.inputTokens + (usage.inputTokens ?? 0),
        outputTokens: totals.outputTokens + (usage.outputTokens ?? 0),
        cacheReadTokens: totals.cacheReadTokens + (usage.cacheReadTokens ?? 0),
        cacheWriteTokens: totals.cacheWriteTokens + (usage.cacheWriteTokens ?? 0),
      };
    },
    {
      threads: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    },
  );
}

export function CodexUsageObservationSummary({
  observations,
  intl,
  locale,
}: {
  observations: CodexUsageObservationsSnapshot | null;
  intl: ReturnType<typeof useCodezIntl>["intl"];
  locale: string;
}) {
  const threads = observations?.threads;
  const totals = buildCodexUsageObservationTotals(threads ?? []);
  const items = [
    ["observedThreads", totals.threads, false],
    ["observedInput", totals.inputTokens, true],
    ["observedOutput", totals.outputTokens, true],
    ["observedCacheRead", totals.cacheReadTokens, true],
    ["observedCacheWrite", totals.cacheWriteTokens, true],
  ] as const;
  return (
    <section
      className="grid grid-cols-2 gap-3 rounded-xl bg-surface p-4 sm:grid-cols-5"
      data-testid="codex-usage-observations"
    >
      {items.map(([key, value, tokens]) => (
        <div key={key} className="min-w-0">
          <div className="truncate text-ui-lg font-medium text-foreground">
            {tokens ? formatCompactTokenUsage(locale, value) : formatCompactNumber(locale, value)}
          </div>
          <div className="mt-1 truncate text-ui-base text-foreground-subtle">
            {intl.formatMessage({ id: `settings.usage.appUsage.${key}` })}
          </div>
        </div>
      ))}
      <div className="col-span-2 flex flex-col justify-center gap-1 sm:col-span-5">
        {threads && threads.length > 0 && observations?.stale ? (
          <div data-testid="codex-usage-observation-stale">
            {intl.formatMessage({ id: "settings.usage.appUsage.observationStale" })}
          </div>
        ) : null}
        {threads && threads.length > 0 && observations?.conflict ? (
          <div data-testid="codex-usage-observation-conflict">
            {intl.formatMessage({ id: "settings.usage.appUsage.observationConflict" })}
          </div>
        ) : null}
      </div>
    </section>
  );
}

export function AppUsagePanel({
  workspaceIdentity,
  workspacePath,
}: {
  workspaceIdentity?: string;
  workspacePath?: string;
}) {
  const { intl, locale } = useCodezIntl();
  const [range, setRange] = useState<AppUsageRange>("7d");
  const codexUsage = useCodexUsageObservations({ workspaceIdentity, workspacePath });
  const { snapshot: lifetimeSnapshot, refresh: refreshLifetime } = useAppUsageStats("all");
  const { snapshot, loading, error, refresh } = useAppUsageStats(range);

  if (loading && !snapshot) {
    return (
      <div className="space-y-5">
        <CodexUsageObservationNotice intl={intl} />
        <CodexUsageObservationSummary
          observations={codexUsage.snapshot}
          intl={intl}
          locale={locale}
        />
        <AppUsageLifetimeSummaryStrip snapshot={lifetimeSnapshot} />
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="text-ui-base font-medium text-foreground">
            {intl.formatMessage({ id: "settings.usage.appUsageRangeTitle" })}
          </div>
          <AppUsageRangeTabs range={range} onRangeChange={setRange} />
        </div>
        {/* App Usage 只聚合本地 session 历史，不能复用 Coding Plan 的 monitor API 加载说明。*/}
        <UsageEmptyState
          title={intl.formatMessage({ id: "settings.usage.loadingTitle" })}
          description={intl.formatMessage({
            id: "settings.usage.appUsageLoadingDescription",
          })}
        />
      </div>
    );
  }

  if (!snapshot) {
    return (
      <div className="space-y-5">
        <CodexUsageObservationNotice intl={intl} />
        <CodexUsageObservationSummary
          observations={codexUsage.snapshot}
          intl={intl}
          locale={locale}
        />
        <AppUsageLifetimeSummaryStrip snapshot={lifetimeSnapshot} />
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="text-ui-base font-medium text-foreground">
            {intl.formatMessage({ id: "settings.usage.appUsageRangeTitle" })}
          </div>
          <AppUsageRangeTabs range={range} onRangeChange={setRange} />
        </div>
        {error ? <UsageStatsErrorNotice error={error} /> : null}
        <UsageEmptyState
          title={intl.formatMessage({ id: "settings.usage.emptyTitle" })}
          description={intl.formatMessage({
            id: "settings.usage.emptyDescription",
          })}
        />
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <CodexUsageObservationNotice intl={intl} />
      <CodexUsageObservationSummary
        observations={codexUsage.snapshot}
        intl={intl}
        locale={locale}
      />
      <AppUsageLifetimeSummaryStrip snapshot={lifetimeSnapshot} />
      {lifetimeSnapshot?.heatmap.weeks.length ? (
        <UsageHeatmap locale={locale} intl={intl} weeks={lifetimeSnapshot.heatmap.weeks} />
      ) : null}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="text-ui-base font-medium text-foreground">
          {intl.formatMessage({ id: "settings.usage.appUsageRangeTitle" })}
        </div>
        <AppUsageRangeTabs range={range} onRangeChange={setRange} />
      </div>
      {error ? <UsageStatsErrorNotice error={error} /> : null}

      <UsageChartLoadBoundary
        scope="settings.usage.app-daily-model-chart"
        resetKeys={[snapshot.range, snapshot.generatedAt]}
        loadingDescription={intl.formatMessage({
          id: "settings.usage.appUsageLoadingDescription",
        })}
      >
        <AppUsageDailyModelTrendChart snapshot={snapshot} />
      </UsageChartLoadBoundary>
      <UsageChartLoadBoundary
        scope="settings.usage.app-model-pie-chart"
        resetKeys={[snapshot.range, snapshot.generatedAt, "model-pie"]}
        loadingDescription={intl.formatMessage({
          id: "settings.usage.appUsageLoadingDescription",
        })}
      >
        <AppUsageModelUsagePieChart snapshot={snapshot} />
      </UsageChartLoadBoundary>

      <div className="flex justify-end">
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="h-8 rounded-md bg-background"
          onClick={() => {
            void Promise.all([refresh(), refreshLifetime(), codexUsage.refresh()]);
          }}
        >
          <RefreshCcw className="size-3.5" />
          {intl.formatMessage({ id: "settings.usage.refresh" })}
        </Button>
      </div>
    </div>
  );
}

function AppUsageLifetimeSummaryStrip({ snapshot }: { snapshot: AppUsageSnapshot | null }) {
  const { intl, locale } = useCodezIntl();
  const items = [
    {
      label: intl.formatMessage({ id: "settings.usage.lifetimeTotalTokens" }),
      value: snapshot ? formatSummaryCompactTokenUsage(locale, snapshot.summary.totalTokens) : "--",
    },
    {
      label: intl.formatMessage({ id: "settings.usage.lifetimePeakTokens" }),
      value: snapshot
        ? formatSummaryCompactTokenUsage(locale, snapshot.summary.peakDayTokens)
        : "--",
    },
    {
      label: intl.formatMessage({ id: "settings.usage.longestSession" }),
      value: snapshot ? formatAppUsageDuration(snapshot.summary.longestSessionMs, intl) : "--",
    },
    {
      label: intl.formatMessage({ id: "settings.usage.currentStreak" }),
      value: snapshot ? formatAppUsageDays(snapshot.summary.currentStreakDays, intl, locale) : "--",
    },
    {
      label: intl.formatMessage({ id: "settings.usage.longestStreak" }),
      value: snapshot ? formatAppUsageDays(snapshot.summary.longestStreakDays, intl, locale) : "--",
    },
  ];

  return (
    <section className="flex flex-col overflow-hidden rounded-xl bg-surface sm:flex-row sm:items-center">
      {items.map((item, index) => (
        <Fragment key={item.label}>
          {index > 0 ? (
            <div aria-hidden="true" className="hidden h-7 w-px bg-border sm:block" />
          ) : null}
          <div className="min-w-0 flex-1 px-4 py-3 text-center">
            <div className="truncate text-ui-lg font-medium text-foreground">{item.value}</div>
            <div className="mt-1 truncate text-ui-base text-foreground-subtle">{item.label}</div>
          </div>
        </Fragment>
      ))}
    </section>
  );
}

function formatAppUsageDays(
  days: number,
  intl: ReturnType<typeof useCodezIntl>["intl"],
  locale: string,
): string {
  return `${formatCompactNumber(locale, days)} ${intl.formatMessage({
    id: "settings.usage.duration.day",
  })}`;
}

export function formatAppUsageDuration(
  durationMs: number,
  intl: ReturnType<typeof useCodezIntl>["intl"],
): string {
  const totalMinutes = Math.max(0, Math.floor(durationMs / 60_000));
  const days = Math.floor(totalMinutes / (24 * 60));
  const hours = Math.floor((totalMinutes % (24 * 60)) / 60);
  const minutes = totalMinutes % 60;
  const parts: string[] = [];
  if (days > 0) {
    parts.push(`${days} ${intl.formatMessage({ id: "settings.usage.duration.day" })}`);
  }
  if (hours > 0) {
    parts.push(`${hours} ${intl.formatMessage({ id: "settings.usage.duration.hour" })}`);
  }
  if (minutes > 0 || parts.length === 0) {
    parts.push(`${minutes} ${intl.formatMessage({ id: "settings.usage.duration.minute" })}`);
  }
  return parts.join(" ");
}

function AppUsageRangeTabs({
  range,
  onRangeChange,
}: {
  range: AppUsageRange;
  onRangeChange: (range: AppUsageRange) => void;
}) {
  const { intl } = useCodezIntl();
  return (
    <Tabs
      value={range}
      onValueChange={(value) => onRangeChange(value as AppUsageRange)}
      className="shrink-0"
    >
      <TabsList className={USAGE_STATS_TABS_LIST_CLASS}>
        {APP_USAGE_RANGES.filter((option) => option !== "all").map((option) => (
          <TabsTrigger key={option} value={option} className={USAGE_STATS_TABS_TRIGGER_CLASS}>
            {intl.formatMessage({ id: `settings.usage.range.${option}` })}
          </TabsTrigger>
        ))}
      </TabsList>
    </Tabs>
  );
}
