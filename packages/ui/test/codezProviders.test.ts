import { describe, expect, it } from "vitest";
import {
  shouldHideCodezSessionForkAction,
  supportsCodezSessionFork,
} from "../src/lib/codezProviders.js";

describe("supportsCodezSessionFork", () => {
  it("所有 provider 都开放 session fork 入口", () => {
    expect(supportsCodezSessionFork("glm")).toBe(true);
    expect(supportsCodezSessionFork("claude")).toBe(true);
    expect(supportsCodezSessionFork("codex")).toBe(true);
    expect(supportsCodezSessionFork("gemini")).toBe(true);
    expect(supportsCodezSessionFork("opencode")).toBe(true);
  });
});

describe("shouldHideCodezSessionForkAction", () => {
  it("所有 provider 都不再隐藏 fork UI 入口", () => {
    expect(shouldHideCodezSessionForkAction("glm")).toBe(false);
    expect(shouldHideCodezSessionForkAction("claude")).toBe(false);
    expect(shouldHideCodezSessionForkAction("codex")).toBe(false);
    expect(shouldHideCodezSessionForkAction("gemini")).toBe(false);
    expect(shouldHideCodezSessionForkAction("opencode")).toBe(false);
  });
});
