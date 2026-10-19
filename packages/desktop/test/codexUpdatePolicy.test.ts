import assert from "node:assert/strict";
import test from "node:test";
import { resolveDesktopUpdatePolicy } from "../src/main/desktopProductRuntime.js";

// codex flavor 已接入 GitHub releases 自动更新：策略必须启用 automatic，且不再
// 携带 manualReleasePage 手动网页回退（见 specs/codex-desktop-distribution.md）。
test("codex flavor enables automatic updates; only preview stays disabled", () => {
  assert.deepEqual(resolveDesktopUpdatePolicy("codex"), { automatic: true });
  assert.deepEqual(resolveDesktopUpdatePolicy("production"), { automatic: true });
  assert.deepEqual(resolveDesktopUpdatePolicy("preview"), { automatic: false });
});
