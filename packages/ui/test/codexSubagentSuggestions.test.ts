import { describe, expect, it } from "vitest";
import type { CodezAgentRoleSummary } from "@codez/shared";
import { buildCodexSubagentSuggestions } from "../src/lib/codexSubagentSuggestions.js";
import { buildSlashApplyMentionPayload } from "../src/lib/slashApplyMentionPayload.js";

function role(name: string, scope: CodezAgentRoleSummary["scope"] = "user"): CodezAgentRoleSummary {
  return {
    name,
    scope,
    fileName: `${name}.toml`,
    developerInstructions: "PRIVATE_ROLE_INSTRUCTIONS",
    description: `${scope} role`,
    model: "native-model",
  };
}

describe("Codex composer subagent suggestions", () => {
  it("offers all user/project file roles without legacy built-ins or a preview cap", () => {
    const suggestions = buildCodexSubagentSuggestions([
      ...Array.from({ length: 22 }, (_, index) => role(`user-${index}`)),
      role("project-reviewer", "project"),
    ]);
    expect(suggestions).toHaveLength(23);
    expect(suggestions.map((item) => item.value)).toContain("project-reviewer");
    expect(suggestions.map((item) => item.value)).not.toContain("general-purpose");
    expect(suggestions.map((item) => item.value)).not.toContain("Explore");
    expect(suggestions.at(-1)).toMatchObject({
      description: "Workspace · project role",
      data: { scope: "workspace", source: "user", model: "native-model" },
    });
  });

  it("prefers project roles with the exact same name without collapsing case-sensitive names", () => {
    const suggestions = buildCodexSubagentSuggestions([
      role("reviewer"),
      role("Reviewer"),
      role("reviewer", "project"),
    ]);
    expect(suggestions).toHaveLength(2);
    expect(suggestions.find((item) => item.value === "reviewer")?.description).toBe(
      "Workspace · project role",
    );
    expect(suggestions.map((item) => item.value)).toContain("Reviewer");
  });

  it("omits roles ignored by native validation while allowing an absent description", () => {
    expect(
      buildCodexSubagentSuggestions([
        { ...role("missing"), developerInstructions: undefined },
        { ...role("blank"), developerInstructions: "  " },
        { ...role("blank-description"), description: " " },
        { ...role("valid"), description: undefined },
      ]).map((item) => item.value),
    ).toEqual(["valid"]);
  });

  it("preserves the exact canonical role name and never attaches developer instructions", () => {
    const [suggestion] = buildCodexSubagentSuggestions([role("Project-Reviewer", "project")]);
    expect(suggestion?.keywords).toEqual(
      expect.arrayContaining([
        "Project-Reviewer",
        "project",
        "native-model",
        "Project-Reviewer.toml",
      ]),
    );
    const payload = buildSlashApplyMentionPayload(suggestion!);
    expect(payload.markdown).toBe("@Project-Reviewer");
    expect(JSON.stringify(suggestion)).not.toContain("PRIVATE_ROLE_INSTRUCTIONS");
    expect(JSON.stringify(payload)).not.toContain("PRIVATE_ROLE_INSTRUCTIONS");
  });
});
