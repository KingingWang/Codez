import type { ConversationSnapshot, TurnTokenUsage } from "@codez/shared/codez-protocol-v4";

function safeUsageCount(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function safeUsageRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function parseUsageBreakdown(record: Record<string, unknown> | undefined): TurnTokenUsage | undefined {
  if (!record) return undefined;
  const inputTokens = safeUsageCount(record.inputTokens);
  const outputTokens = safeUsageCount(record.outputTokens);
  const totalTokens = safeUsageCount(record.totalTokens);
  const cacheReadTokens = safeUsageCount(record.cachedInputTokens ?? record.cacheReadTokens);
  const cacheWriteTokens = safeUsageCount(record.cacheWriteInputTokens ?? record.cacheWriteTokens);
  const reasoningTokens = safeUsageCount(record.reasoningOutputTokens ?? record.reasoningTokens);
  if (
    inputTokens === undefined &&
    outputTokens === undefined &&
    totalTokens === undefined &&
    cacheReadTokens === undefined &&
    cacheWriteTokens === undefined &&
    reasoningTokens === undefined
  ) {
    return undefined;
  }
  return {
    ...(inputTokens !== undefined ? { inputTokens } : {}),
    ...(outputTokens !== undefined ? { outputTokens } : {}),
    ...(totalTokens !== undefined ? { totalTokens } : {}),
    ...(cacheReadTokens !== undefined ? { cacheReadTokens } : {}),
    ...(cacheWriteTokens !== undefined ? { cacheWriteTokens } : {}),
    ...(reasoningTokens !== undefined ? { reasoningTokens } : {}),
  };
}

const TURN_USAGE_KEYS = [
  "inputTokens",
  "outputTokens",
  "totalTokens",
  "cacheReadTokens",
  "cacheWriteTokens",
  "reasoningTokens",
] as const satisfies readonly (keyof TurnTokenUsage)[];

/**
 * 同一轮 turn 内多次 `thread/tokenUsage/updated` 的累计状态。
 *
 * 修复原因：Codex 原生在每次模型请求（例如每次工具调用往返）结束时都会推送一条
 * `thread/tokenUsage/updated`，其中 `last` 仅代表单次模型请求的 token 统计，`total`
 * 代表线程累计。旧实现直接用最新 `last` 覆盖 `turnTokenUsage`，导致多步 turn 的“本轮用量”
 * 变成最后一次单次请求的统计。
 * 修复依据：按 turnId 锚定本轮首次观察到的线程累计基准 `baseline = total - last`，
 * 后续同轮更新以 `total - baseline` 派生整轮累计（既覆盖多步工具调用累加，又对重复通知天然幂等）；
 * 若稀疏输入未提供 `total`，则退化为按单步 `last` 累加。
 */
export interface NativeTurnUsageAccumulator {
  baselineTotal?: TurnTokenUsage;
  usage: TurnTokenUsage;
}

export function accumulateNativeTurnUsage(
  previous: NativeTurnUsageAccumulator | undefined,
  rawTokenUsage: unknown,
): NativeTurnUsageAccumulator | undefined {
  const usageObj = safeUsageRecord(rawTokenUsage);
  if (!usageObj) return previous;
  const totalBreakdown = parseUsageBreakdown(safeUsageRecord(usageObj.total));
  const lastBreakdown = parseUsageBreakdown(safeUsageRecord(usageObj.last) ?? usageObj);
  if (!totalBreakdown && !lastBreakdown) return previous;

  const nextBaseline: TurnTokenUsage = { ...previous?.baselineTotal };
  const nextUsage: TurnTokenUsage = { ...previous?.usage };

  for (const key of TURN_USAGE_KEYS) {
    const totalVal = totalBreakdown?.[key];
    const lastVal = lastBreakdown?.[key];
    if (totalVal !== undefined) {
      let baseVal = nextBaseline[key];
      if (baseVal === undefined && lastVal !== undefined && totalVal >= lastVal) {
        baseVal = totalVal - lastVal;
        nextBaseline[key] = baseVal;
      }
      if (baseVal !== undefined && totalVal >= baseVal) {
        nextUsage[key] = totalVal - baseVal;
        continue;
      }
    }
    if (lastVal !== undefined) {
      nextUsage[key] = (previous?.usage[key] ?? 0) + lastVal;
    }
  }

  if (TURN_USAGE_KEYS.every((key) => nextUsage[key] === undefined)) {
    return previous;
  }

  return {
    ...(TURN_USAGE_KEYS.some((key) => nextBaseline[key] !== undefined)
      ? { baselineTotal: nextBaseline }
      : {}),
    usage: nextUsage,
  };
}

/** 原生 tokenUsage → 单轮 turnUsage 的稀疏事实投影。 */
export function sparseNativeTurnUsage(value: unknown): TurnTokenUsage | undefined {
  const record = safeUsageRecord(value);
  if (!record) return undefined;
  if ("usage" in record && safeUsageRecord(record.usage)) {
    const accumulated = parseUsageBreakdown(safeUsageRecord(record.usage));
    if (accumulated) return accumulated;
  }
  const last = safeUsageRecord(record.last) ?? record;
  return parseUsageBreakdown(last);
}

/** 原生 tokenUsage → V4 usage 的稀疏事实投影（Batch A/B 边界）。 */
export function sparseNativeUsage(value: unknown): ConversationSnapshot["usage"] | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const usage = value as Record<string, unknown>;
  const total =
    typeof usage.total === "object" && usage.total !== null
      ? (usage.total as Record<string, unknown>)
      : undefined;
  const last =
    typeof usage.last === "object" && usage.last !== null
      ? (usage.last as Record<string, unknown>)
      : undefined;
  const inputTokens = safeUsageCount(total?.inputTokens);
  const outputTokens = safeUsageCount(total?.outputTokens);
  const cacheReadTokens = safeUsageCount(total?.cachedInputTokens);
  const cacheWriteTokens = safeUsageCount(total?.cacheWriteInputTokens);
  const usedTokens = safeUsageCount(last?.totalTokens);
  const maxTokens = safeUsageCount(usage.modelContextWindow);
  if (
    inputTokens === undefined &&
    outputTokens === undefined &&
    cacheReadTokens === undefined &&
    cacheWriteTokens === undefined &&
    usedTokens === undefined &&
    maxTokens === undefined
  ) {
    return undefined;
  }
  const hasContextWindow = usedTokens !== undefined || maxTokens !== undefined;
  const codexObserved: NonNullable<ConversationSnapshot["usage"]["codexObserved"]> = {
    ...(inputTokens !== undefined ? { inputTokens } : {}),
    ...(outputTokens !== undefined ? { outputTokens } : {}),
    ...(cacheReadTokens !== undefined ? { cacheReadTokens } : {}),
    ...(cacheWriteTokens !== undefined ? { cacheWriteTokens } : {}),
    ...(hasContextWindow
      ? {
          contextWindow: {
            ...(usedTokens !== undefined ? { usedTokens } : {}),
            ...(maxTokens !== undefined ? { maxTokens } : {}),
          },
        }
      : {}),
  };
  return {
    // Dense fields are compatibility-only. They are emitted solely when at least one
    // corresponding native fact exists; unavailable sibling fields remain absent from
    // codexObserved and UI must mark them unavailable.
    cumulative: {
      inputTokens: inputTokens ?? 0,
      outputTokens: outputTokens ?? 0,
      cacheReadTokens: cacheReadTokens ?? 0,
      cacheWriteTokens: cacheWriteTokens ?? 0,
    },
    ...(hasContextWindow
      ? {
          contextWindow: {
            usedTokens: usedTokens ?? 0,
            maxTokens: maxTokens ?? 0,
            autoCompactThresholdTokens: null,
          },
        }
      : { contextWindow: null }),
    codexObserved,
  };
}
