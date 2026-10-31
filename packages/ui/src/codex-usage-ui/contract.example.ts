import type { CodexObservedUsageInput, CodexUsageDisplayTotals } from "./contract.js";

/** 原生只观察到 output 时，未观察到的输入不能成为精确合计。 */
export const sparseObservationExample = {
  outputTokens: 12,
} satisfies CodexObservedUsageInput;

export const sparseTotalsExample = {
  threads: 1,
  inputTokens: null,
  outputTokens: 12,
  cacheReadTokens: null,
  cacheWriteTokens: null,
} satisfies CodexUsageDisplayTotals;
