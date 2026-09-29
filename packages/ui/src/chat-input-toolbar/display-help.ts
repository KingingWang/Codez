import type { CodezProvider } from "@codez/shared";

export const CODEZ_MODE_OPTION_LABEL_IDS: Record<CodezProvider, Record<string, string>> = {
  glm: {
    build: "mode.label.glm.build",
    edit: "mode.label.glm.edit",
    plan: "mode.label.glm.plan",
    yolo: "mode.label.glm.yolo",
  },
};

export const CODEZ_MODE_OPTION_DESCRIPTION_IDS: Record<CodezProvider, Record<string, string>> = {
  glm: {
    build: "mode.description.glm.build",
    edit: "mode.description.glm.edit",
    plan: "mode.description.glm.plan",
    yolo: "mode.description.glm.yolo",
  },
};

// Codex 会话权限档位使用独立 i18n 键，不复用 glm/codez 文案
// （specs/codex-permission-modes.md：标签/说明与原生权限菜单一一对应）。
export const CODEX_MODE_OPTION_LABEL_IDS: Record<string, string> = {
  build: "mode.codex.build",
  edit: "mode.codex.edit",
  yolo: "mode.codex.yolo",
  custom: "mode.codex.custom",
};

export const CODEX_MODE_OPTION_DESCRIPTION_IDS: Record<string, string> = {
  build: "mode.codex.build.description",
  edit: "mode.codex.edit.description",
  yolo: "mode.codex.yolo.description",
  custom: "mode.codex.custom.description",
  plan: "mode.codex.plan.description",
};
