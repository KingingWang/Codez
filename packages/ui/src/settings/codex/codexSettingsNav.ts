/**
 * SettingsPage 分区 ↔ Codex 设置内部面板的双向映射（spec: CodexSettings.spec.md
 * 「internal panel tabs」）。内部标签与侧栏分区是同一导航的两个入口：
 * 有对应分区的面板切换要同步外层 activeSection；没有侧栏分区的面板
 * （models/config/history）归属 codex，内部选中态由 SettingsPage 保留。
 */
import type { SettingsSectionId } from "@/lib/settingsNavigation.js";
import type { CodexSettingsPanel } from "./CodexSettingsSection.js";

const SECTION_TO_PANEL: Partial<Record<SettingsSectionId, CodexSettingsPanel>> = {
  skill: "skills",
  subagents: "agents",
  mcp: "mcp",
  plugin: "plugins",
  modelProvider: "providers",
  memory: "memory",
};

const PANEL_TO_SECTION: Partial<Record<CodexSettingsPanel, SettingsSectionId>> = {
  account: "codex",
  providers: "modelProvider",
  skills: "skill",
  agents: "subagents",
  mcp: "mcp",
  plugins: "plugin",
  memory: "memory",
};

/** 未命中映射的分区（含 codex）落到 account 面板，保持既有默认。 */
export function codexSectionToPanel(section: string): CodexSettingsPanel {
  return SECTION_TO_PANEL[section as SettingsSectionId] ?? "account";
}

/** 内部专属面板归属 Codex 侧栏，不能沿用上一个 legacy 分区标题。 */
export function codexPanelToSection(panel: CodexSettingsPanel): SettingsSectionId {
  return PANEL_TO_SECTION[panel] ?? "codex";
}
