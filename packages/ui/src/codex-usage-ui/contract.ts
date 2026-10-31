import type { SessionUsageState } from "@codez/shared/codez-protocol-v4";

/** 复用 native 稀疏观察类型，缺失项不补零。 */
export type CodexObservedUsageInput = Pick<
  NonNullable<SessionUsageState["codexObserved"]>,
  "inputTokens" | "outputTokens" | "cacheReadTokens" | "cacheWriteTokens"
>;

export interface CodexUsageDisplayTotals {
  readonly threads: number;
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly cacheReadTokens: number | null;
  readonly cacheWriteTokens: number | null;
}
