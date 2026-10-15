import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const archivedSectionSource = readFileSync(
  resolve(process.cwd(), "packages/ui/src/WorkspaceArchivedTasksFlatSection.tsx"),
  "utf8",
);
const englishLocaleSource = readFileSync(
  resolve(process.cwd(), "packages/ui/src/i18n/locales/en-US.ts"),
  "utf8",
);

describe("WorkspaceArchivedTasksFlatSection action tooltips", () => {
  it("为取消归档和删除 action 使用共享 tooltip", () => {
    expect(archivedSectionSource).toMatch(
      /<ControlHintTooltip title=\{unarchiveLabel\}[\s\S]*?aria-label=\{unarchiveLabel\}/,
    );
    expect(archivedSectionSource).toMatch(
      /<ControlHintTooltip title=\{deleteLabel\}[\s\S]*?aria-label=\{deleteLabel\}/,
    );
  });

  it("使用完整的 task action 英文文案", () => {
    expect(englishLocaleSource).toContain('"taskList.unarchive": "Unarchive task"');
    expect(englishLocaleSource).toContain('"taskList.delete": "Delete task"');
  });

  it("取消归档与单条删除均推进 membershipVersion 并刷新归档列表", () => {
    expect(archivedSectionSource).toMatch(
      /\.unarchiveTask\([\s\S]*?bumpTaskListMembershipVersion\(\)[\s\S]*?void refresh\(\)/,
    );
    expect(archivedSectionSource).toMatch(
      /deleteArchivedTask\(deleteParams\)[\s\S]*?removeTaskFromTaskCaches\([\s\S]*?bumpTaskListMembershipVersion\(\)[\s\S]*?void refresh\(\)/,
    );
  });
});
