import type { CodezProvider } from "@codez/shared";

type SkillSourceType = "glm" | "unknown";

export function resolveSkillSourceType(skillPath: string): SkillSourceType {
  const normalized = skillPath.replaceAll("\\", "/").toLowerCase();
  if (normalized.includes("/.codez/skills/")) {
    return "glm";
  }
  if (normalized.includes("/.codez/cli/plugins/cache/")) {
    return "glm";
  }
  return "unknown";
}

const SKILL_ID_PROVIDER_RE = /^glm:/;

function isCodexSkillPath(skillPath: string): boolean {
  const normalized = skillPath.replaceAll("\\", "/").toLowerCase();
  return (
    normalized.includes("/.codex/skills/") ||
    normalized.includes("/.codex/plugins/") ||
    normalized.includes("/.agents/skills/")
  );
}

function isZcodeSkill(skill: { id?: string; path: string; scope?: string }): boolean {
  return (
    // plugin skill 的真实路径在 CLI plugin cache 下，不在 `.codez/skills`。
    // 服务层已用 scope 标记来源，前端过滤时要放行，否则 `/` 和 `$` 面板会漏掉插件技能。
    // 同时放行 Codex 原生技能目录（.codex/skills、.codex/plugins、.agents/skills），
    // 避免桌面端 `/` 与 `$` 面板把 `skills/referenceCatalog` 返回的 Codex 技能全部过滤掉。
    skill.scope === "plugin" ||
    (typeof skill.id === "string" && SKILL_ID_PROVIDER_RE.test(skill.id)) ||
    isCodexSkillPath(skill.path) ||
    resolveSkillSourceType(skill.path) === "glm"
  );
}

export function filterSkillsForProvider<T extends { path: string; id?: string; scope?: string }>(
  skills: T[],
  _legacyProvider: CodezProvider,
): T[] {
  return skills.filter(isZcodeSkill);
}
