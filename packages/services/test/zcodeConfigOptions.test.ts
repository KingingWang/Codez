import { describe, expect, it } from "vitest";
import type { CodezSessionSettingsState } from "@codez/shared";
import {
  getCodezAgentAvailableModes,
  normalizeAvailableCodezMode,
  settingsToConfigOptions,
} from "../src/codez-agent/codezConfigOptions.js";

function settingsWithMode(
  mode: CodezSessionSettingsState["mode"]["current"],
): CodezSessionSettingsState {
  return {
    model: {
      current: { providerId: "glm", modelId: "glm-5" },
      available: [],
    },
    thoughtLevel: {
      enabled: false,
      available: [],
    },
    mode: { current: mode },
  };
}

describe("codezConfigOptions", () => {
  it("keeps persisted edit while the shared menu replaces it with guarded", () => {
    const options = settingsToConfigOptions(settingsWithMode("edit"));
    const modeOption = options.find((option) => option.category === "mode");

    expect(modeOption?.currentValue).toBe("edit");
    expect(modeOption?.options?.map((option) => option.value)).toEqual([
      "build",
      "guarded",
      "plan",
      "yolo",
    ]);
    expect(getCodezAgentAvailableModes().map((mode) => mode.id)).toEqual([
      "build",
      "guarded",
      "plan",
      "yolo",
    ]);
    expect(normalizeAvailableCodezMode("edit")).toBe("edit");
  });
});
