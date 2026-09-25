import { logger } from "@/logger.js";

export interface CodexObservedUsageInput {
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly cacheReadTokens?: number;
  readonly cacheWriteTokens?: number;
}

export interface CodexUsageObservationEntry {
  readonly threadId: string;
  readonly observation: { payload: Readonly<CodexObservedUsageInput> };
  readonly conflict: boolean;
}

export interface CodexUsageObservationsSnapshot {
  readonly threads: readonly CodexUsageObservationEntry[];
  readonly conflict: boolean;
  readonly stale: boolean;
}

function validEntry(
  threadId: unknown,
  state: unknown,
): state is {
  observation: CodexUsageObservationEntry["observation"];
  conflict: boolean;
} {
  if (typeof threadId !== "string" || !state || typeof state !== "object") return false;
  const observation = (state as { observation?: unknown }).observation;
  if (!observation || typeof observation !== "object") return false;
  const payload = (observation as { payload?: unknown }).payload;
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return false;
  return (["inputTokens", "outputTokens", "cacheReadTokens", "cacheWriteTokens"] as const).every(
    (key) => {
      const value = (payload as Record<string, unknown>)[key];
      return value === undefined || (Number.isSafeInteger(value) && (value as number) >= 0);
    },
  );
}

/** Host 的旧 Map 经 JSON 编码后变成 {}；只读可信条目，坏数据绝不交给统计视图。 */
export function normalizeCodexUsageThreads(value: unknown): readonly CodexUsageObservationEntry[] {
  if (Array.isArray(value)) {
    return value.filter(
      (entry): entry is CodexUsageObservationEntry =>
        entry !== null &&
        typeof entry === "object" &&
        validEntry((entry as { threadId?: unknown }).threadId, entry),
    );
  }
  if (value instanceof Map) {
    return [...value.entries()]
      .filter(([threadId, state]) => validEntry(threadId, state))
      .map(([threadId, state]) => ({
        threadId: threadId as string,
        observation: (state as CodexUsageObservationEntry).observation,
        conflict: Boolean((state as CodexUsageObservationEntry).conflict),
      }));
  }
  if (value !== undefined) {
    logger.warn("[codex-usage] 观察快照 threads 形状无法识别，按空列表降级", {
      shape: value === null ? "null" : typeof value,
    });
  }
  return [];
}
