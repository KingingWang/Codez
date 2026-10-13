import type { ConversationSnapshot } from "@codez/shared/codez-protocol-v4";

function safeUsageCount(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
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
