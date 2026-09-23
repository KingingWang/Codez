import { describe, expect, it } from "vitest";
import {
  consumeZcodeJwtInvalidRestartMarker,
  markZcodeJwtInvalidRestart,
} from "../src/root/codezJwtInvalidRestartMarker.js";

function createStorage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    removeItem: (key: string) => values.delete(key),
    setItem: (key: string, value: string) => values.set(key, value),
  };
}

describe("codez JWT invalid restart marker", () => {
  it("is consumed exactly once after relaunch", () => {
    const storage = createStorage();
    markZcodeJwtInvalidRestart(storage);

    expect(consumeZcodeJwtInvalidRestartMarker(storage)).toBe(true);
    expect(consumeZcodeJwtInvalidRestartMarker(storage)).toBe(false);
  });
});
