import assert from "node:assert/strict";
import test from "node:test";
import { isSelectionSideChatMissingError } from "./selectionSideChatRuntime.js";

test("legacy codez-cli 的 sessionNotFound 判定为 child 已消失", () => {
  assert.equal(isSelectionSideChatMissingError(new Error("sessionNotFound")), true);
  assert.equal(
    isSelectionSideChatMissingError(new Error("readSession failed: sessionNotFound abc")),
    true,
  );
  assert.equal(isSelectionSideChatMissingError("sessionNotFound"), true);
});

test("codex-bridge DeletedThreadError 判定为 child 已消失", () => {
  assert.equal(
    isSelectionSideChatMissingError(new Error("Thread was deleted; refresh the session list")),
    true,
  );
});

test("原生 thread-not-found 错误（大小写不敏感）判定为 child 已消失", () => {
  assert.equal(isSelectionSideChatMissingError(new Error("thread abc not found")), true);
  assert.equal(isSelectionSideChatMissingError(new Error("Thread abc NOT FOUND")), true);
  assert.equal(
    isSelectionSideChatMissingError(new Error("no such thread, thread not found: abc")),
    true,
  );
});

test("其他错误不误判为 child 已消失", () => {
  assert.equal(isSelectionSideChatMissingError(new Error("network timeout")), false);
  assert.equal(isSelectionSideChatMissingError(new Error("permission denied")), false);
  assert.equal(isSelectionSideChatMissingError(new Error("session read failed")), false);
  assert.equal(isSelectionSideChatMissingError(undefined), false);
});
