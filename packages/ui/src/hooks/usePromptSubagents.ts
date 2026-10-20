import { useMemo } from "react";
import type { CodezProvider } from "@codez/shared";
import { useCodexAgents } from "./useCodexAgents.js";
import { useSubagents } from "./useSubagents.js";
import { buildCodexSubagentSuggestions } from "@/lib/codexSubagentSuggestions.js";
import { buildSubagentSuggestions } from "@/slashCommandHelpers.js";

/** 运行时事实来自 Composer；不能按模型供应商推断 Codex，或在读取失败后混用旧角色。 */
export function usePromptSubagents({
  workspacePath,
  workspaceIdentity,
  provider,
  nativeCodex,
  enabled,
}: {
  workspacePath: string;
  workspaceIdentity?: string;
  provider: CodezProvider;
  nativeCodex: boolean;
  enabled: boolean;
}) {
  const native = useCodexAgents({
    workspacePath,
    workspaceIdentity,
    enabled: nativeCodex && enabled,
  });
  const legacy = useSubagents(
    !nativeCodex && enabled ? workspacePath : null,
    provider,
    workspaceIdentity,
  );
  const suggestions = useMemo(() => {
    if (!enabled) return [];
    if (nativeCodex) return native.error ? [] : buildCodexSubagentSuggestions(native.roles);
    return buildSubagentSuggestions(legacy.agents);
  }, [enabled, legacy.agents, native.error, native.roles, nativeCodex]);
  return {
    suggestions,
    loading: enabled && (nativeCodex ? native.loading : legacy.loading),
    error: enabled ? (nativeCodex ? (native.error ?? null) : legacy.error) : null,
  };
}
