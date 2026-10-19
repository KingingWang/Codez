import type { CodezProvider } from "@codez/shared";

export const CODEZ_MODE_OPTION_LABEL_IDS: Record<CodezProvider, Record<string, string>> = {
  glm: {
    default: "mode.label.glm.default",
    build: "mode.label.glm.build",
    edit: "mode.label.glm.edit",
    plan: "mode.label.glm.plan",
    yolo: "mode.label.glm.yolo",
    guarded: "mode.label.glm.guarded",
  },
};

export const CODEZ_MODE_OPTION_DESCRIPTION_IDS: Record<CodezProvider, Record<string, string>> = {
  glm: {
    default: "mode.description.glm.default",
    build: "mode.description.glm.build",
    edit: "mode.description.glm.edit",
    plan: "mode.description.glm.plan",
    yolo: "mode.description.glm.yolo",
    guarded: "mode.description.glm.guarded",
  },
};
