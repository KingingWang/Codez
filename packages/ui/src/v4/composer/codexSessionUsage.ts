import type { CodezContextCacheUsage, CodezContextUsageBreakdownItem } from "@codez/shared";
import type { SessionUsageState } from "@codez/shared/codez-protocol-v4";

export interface RenderableSessionCumulativeUsage {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  hitRate?: number | null;
}

export interface RenderableSessionTaskUsage {
  used: number;
  size: number;
  cache?: { hitRate: number | null } & Partial<CodezContextCacheUsage>;
  breakdown?: CodezContextUsageBreakdownItem[];
  cumulative?: RenderableSessionCumulativeUsage;
}

export function resolveSessionCumulativeUsage(
  usage: SessionUsageState | null | undefined,
): RenderableSessionCumulativeUsage | undefined {
  if (!usage) return undefined;
  const codexObserved = usage.codexObserved;
  if (codexObserved) {
    const inputTokens = codexObserved.inputTokens;
    const outputTokens = codexObserved.outputTokens;
    const cacheReadTokens = codexObserved.cacheReadTokens;
    const cacheWriteTokens = codexObserved.cacheWriteTokens;
    if (
      inputTokens === undefined &&
      outputTokens === undefined &&
      cacheReadTokens === undefined &&
      cacheWriteTokens === undefined
    ) {
      return undefined;
    }
    const totalTokens =
      inputTokens !== undefined && outputTokens !== undefined
        ? inputTokens + outputTokens
        : undefined;
    const hitRate =
      inputTokens !== undefined && inputTokens > 0 && cacheReadTokens !== undefined
        ? Math.min(1, Math.max(0, cacheReadTokens / inputTokens))
        : null;
    return {
      ...(inputTokens !== undefined ? { inputTokens } : {}),
      ...(outputTokens !== undefined ? { outputTokens } : {}),
      ...(totalTokens !== undefined ? { totalTokens } : {}),
      ...(cacheReadTokens !== undefined ? { cacheReadTokens } : {}),
      ...(cacheWriteTokens !== undefined ? { cacheWriteTokens } : {}),
      ...(hitRate !== null ? { hitRate } : {}),
    };
  }

  const cumulative = usage.cumulative;
  if (!cumulative) return undefined;
  const { inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens } = cumulative;
  if (
    inputTokens <= 0 &&
    outputTokens <= 0 &&
    cacheReadTokens <= 0 &&
    cacheWriteTokens <= 0
  ) {
    return undefined;
  }
  const totalTokens = inputTokens + outputTokens;
  const explicitHitRate = usage.contextWindow?.cache?.hitRate;
  const hitRate =
    explicitHitRate !== undefined && explicitHitRate !== null && Number.isFinite(explicitHitRate)
      ? explicitHitRate
      : inputTokens > 0
        ? Math.min(1, Math.max(0, cacheReadTokens / inputTokens))
        : null;
  return {
    inputTokens,
    outputTokens,
    totalTokens,
    cacheReadTokens,
    cacheWriteTokens,
    ...(hitRate !== null ? { hitRate } : {}),
  };
}

/**
 * Codex sparse usage wins over the legacy dense shape. Once codexObserved exists,
 * an absent context value is unavailable and must never be rendered as zero.
 */
export function resolveSessionTaskUsage(
  usage: SessionUsageState | null | undefined,
): RenderableSessionTaskUsage | null {
  const codexObserved = usage?.codexObserved;
  const cumulative = resolveSessionCumulativeUsage(usage);
  if (codexObserved) {
    const contextWindow = codexObserved.contextWindow;
    if (contextWindow?.usedTokens === undefined || contextWindow?.maxTokens === undefined) {
      return null;
    }
    return {
      used: contextWindow.usedTokens,
      size: contextWindow.maxTokens,
      ...(cumulative?.hitRate !== undefined && cumulative.hitRate !== null
        ? { cache: { hitRate: cumulative.hitRate } }
        : {}),
      ...(cumulative ? { cumulative } : {}),
    };
  }
  const contextWindow = usage?.contextWindow;
  if (!contextWindow) return null;
  const resolvedCache =
    contextWindow.cache ??
    (cumulative?.hitRate !== undefined && cumulative.hitRate !== null
      ? { hitRate: cumulative.hitRate }
      : undefined);
  return {
    used: contextWindow.usedTokens,
    size: contextWindow.maxTokens,
    ...(resolvedCache ? { cache: resolvedCache } : {}),
    ...(contextWindow.breakdown ? { breakdown: contextWindow.breakdown } : {}),
    ...(cumulative ? { cumulative } : {}),
  };
}
