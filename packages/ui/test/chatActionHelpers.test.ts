import { describe, expect, it } from "vitest";
import type { CodezConfigOption } from "@codez/shared";
import { readCurrentCodezMode } from "../src/hooks/chatActionHelpers.js";

function createModeOption(currentValue: string | boolean): CodezConfigOption {
  return {
    id: "mode",
    name: "Mode",
    category: "mode",
    type: "select",
    currentValue,
  };
}

describe("chatActionHelpers", () => {
  it("reads yolo from Codez Agent mode config options", () => {
    expect(readCurrentCodezMode([createModeOption("yolo")])).toBe("yolo");
  });

  it("reads edit from Codez Agent mode config options", () => {
    expect(readCurrentCodezMode([createModeOption("edit")])).toBe("edit");
  });

  it("keeps provider-native Codez Agent modes", () => {
    expect(readCurrentCodezMode([createModeOption("bypassPermissions")])).toBe("bypassPermissions");
  });

  it("does not normalize retired provider-native agent mode ids", () => {
    const readMode = readCurrentCodezMode as (
      options: readonly CodezConfigOption[],
      provider?: string,
    ) => unknown;
    expect(readCurrentCodezMode([createModeOption("agent")])).toBeUndefined();
    expect(readMode([createModeOption("agent-full-access")], "gemini")).toBeUndefined();
  });

  it("ignores invalid mode values", () => {
    expect(readCurrentCodezMode([createModeOption("unknown")])).toBeUndefined();
    expect(readCurrentCodezMode([createModeOption(true)])).toBeUndefined();
  });
});
