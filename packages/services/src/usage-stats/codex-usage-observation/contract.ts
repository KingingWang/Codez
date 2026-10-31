import type { CodexUsageObservationCache } from "../codexUsageObservationCache.js";

export type {
  CodexObservedUsage,
  CodexUsageWorkspaceTarget,
  CodexUsageObservation,
  CodexUsageThreadState,
  CodexUsageThreadEntry,
  CodexUsageCacheSnapshot,
} from "../codexUsageObservationCache.js";

/** 同一个既有 cache owner 的命令/读模型，不实例化第二份 usage 状态。 */
export type CodexUsageObservationPort = Pick<
  CodexUsageObservationCache,
  "observe" | "reconcile" | "markRuntimeUnavailable" | "snapshot"
>;
