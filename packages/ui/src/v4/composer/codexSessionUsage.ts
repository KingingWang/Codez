import type { CodezContextCacheUsage, CodezContextUsageBreakdownItem } from "@codez/shared";
import type { SessionUsageState } from "@codez/shared/codez-protocol-v4";

export interface RenderableSessionTaskUsage {
  used: number;
  size: number;
  cache?: CodezContextCacheUsage;
  breakdown?: CodezContextUsageBreakdownItem[];
}

/**
 * Codex sparse usage wins over the legacy dense shape. Once codexObserved exists,
 * an absent context value is unavailable and must never be rendered as zero.
 */
export function resolveSessionTaskUsage(
  usage: SessionUsageState | null | undefined,
): RenderableSessionTaskUsage | null {
  const codexObserved = usage?.codexObserved;
  if (codexObserved) {
    const contextWindow = codexObserved.contextWindow;
    if (contextWindow?.usedTokens === undefined || contextWindow?.maxTokens === undefined) {
      return null;
    }
    return { used: contextWindow.usedTokens, size: contextWindow.maxTokens };
  }
  const contextWindow = usage?.contextWindow;
  if (!contextWindow) return null;
  return {
    used: contextWindow.usedTokens,
    size: contextWindow.maxTokens,
    ...(contextWindow.cache ? { cache: contextWindow.cache } : {}),
    ...(contextWindow.breakdown ? { breakdown: contextWindow.breakdown } : {}),
  };
}
