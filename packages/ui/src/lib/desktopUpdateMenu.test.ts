import assert from "node:assert/strict";
import test from "node:test";
import { shouldShowDesktopUpdateEntry } from "./desktopUpdateMenu.js";

test("desktop manual update entry follows the product updater policy", () => {
  assert.equal(shouldShowDesktopUpdateEntry("codex"), true);
  assert.equal(shouldShowDesktopUpdateEntry("production"), true);
  assert.equal(shouldShowDesktopUpdateEntry("preview"), false);
});
