import type { CodezAgentRoleSummary } from "@codez/shared";
import type { PromptInputSuggestionItem } from "./promptInputTriggers.js";

/** 原因：旧 Markdown 目录只有两个内建项，不能代替 Codex 的用户/项目 TOML 角色目录。 */
export function buildCodexSubagentSuggestions(
  roles: readonly CodezAgentRoleSummary[],
): PromptInputSuggestionItem[] {
  const byName = new Map<string, CodezAgentRoleSummary>();
  for (const role of roles) {
    if (!role.developerInstructions?.trim()) continue;
    if (role.description !== undefined && !role.description.trim()) continue;
    const current = byName.get(role.name);
    if (!current || (current.scope !== "project" && role.scope === "project")) {
      byName.set(role.name, role);
    }
  }
  return [...byName.values()].map((role) => {
    const sourceLabel = role.scope === "project" ? "Workspace" : "User";
    return {
      id: `subagent:codex:${role.scope}:${role.fileName}`,
      trigger: "/",
      value: role.name,
      label: role.name,
      description: role.description ? `${sourceLabel} · ${role.description}` : sourceLabel,
      keywords: [
        role.name,
        role.description ?? "",
        role.scope,
        sourceLabel,
        role.fileName,
        role.model ?? "",
        "subagent",
        "agent",
      ],
      data: {
        scope: role.scope === "project" ? "workspace" : "user",
        source: "user",
        model: role.model,
      },
    };
  });
}
