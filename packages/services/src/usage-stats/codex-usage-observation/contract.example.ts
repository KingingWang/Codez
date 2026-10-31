import type { CodexUsageCacheSnapshot, CodexUsageObservationPort } from "./contract.js";

export const unavailableUsageExample = {
  workspaceKey: "/workspace/example",
  threads: [],
  conflict: false,
  stale: true,
} satisfies CodexUsageCacheSnapshot;

/** 观察后读取同一个 owner；计数保持稀疏，不混入 Coding Plan。 */
export function usageObservationExample(cache: CodexUsageObservationPort) {
  cache.observe("example-thread", { inputTokens: 100, outputTokens: 50 });
  return cache.snapshot();
}
