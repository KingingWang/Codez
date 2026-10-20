import assert from "node:assert/strict";
import test from "node:test";
import enUS from "../../i18n/locales/en-US.js";
import zhCN from "../../i18n/locales/zh-CN.js";
import { CONVERSATION_SHARED_CONTEXT_COPY_WARNING_ID } from "./sharedContextContentCopy.js";

test("shared context warning states content copy and no later propagation", () => {
  const english = enUS[CONVERSATION_SHARED_CONTEXT_COPY_WARNING_ID];
  const chinese = zhCN[CONVERSATION_SHARED_CONTEXT_COPY_WARNING_ID];
  assert.ok(english);
  assert.ok(chinese);
  assert.match(english, /text copy/i);
  assert.match(english, /Reference semantics are lost/i);
  assert.match(english, /later changes to the source won't update/i);
  assert.match(chinese, /文本副本/);
  assert.match(chinese, /引用语义会丢失/);
  assert.match(chinese, /后续变化也不会同步/);
});
