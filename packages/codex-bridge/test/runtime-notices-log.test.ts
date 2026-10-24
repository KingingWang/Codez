import assert from "node:assert/strict";
import test from "node:test";
import { isRuntimeNoticeMethod, readRuntimeNotice } from "../src/runtime-notices.js";

test("runtime notices become bounded log records without config paths", () => {
  assert.deepEqual(
    readRuntimeNotice({
      method: "configWarning",
      params: {
        summary: "config summary",
        details: "session-flags: token_budget is ignored",
        path: "/private/config.toml",
        range: { start: { line: 2, column: 3 } },
      },
    }),
    {
      kind: "configWarning",
      message: "config summary",
      detail: "session-flags: token_budget is ignored",
    },
  );
  assert.deepEqual(
    readRuntimeNotice({ method: "warning", params: { threadId: null, message: "global" } }),
    { kind: "warning", message: "global" },
  );
  assert.deepEqual(
    readRuntimeNotice({ method: "warning", params: { threadId: "t1", message: "targeted" } }),
    { kind: "warning", message: "targeted", threadId: "t1" },
  );
  assert.deepEqual(
    readRuntimeNotice({
      method: "modelProvider/authRecoveryCompleted",
      params: {
        threadId: "t1",
        turnId: "turn-1",
        provider: "openai",
        message: "recovered",
      },
    }),
    {
      kind: "authRecovery",
      message: "recovered",
      threadId: "t1",
      turnId: "turn-1",
      provider: "openai",
      phase: "completed",
    },
  );
});

test("runtime notice parsing ignores malformed input and bounds diagnostic text", () => {
  for (const event of [
    { method: "warning", params: undefined },
    { method: "warning", params: { threadId: 1, message: "bad id" } },
    { method: "warning", params: { threadId: "t1", message: "   " } },
    { method: "guardianWarning", params: { message: "missing" } },
    { method: "modelProvider/authRecoveryStarted", params: { threadId: "t1" } },
  ]) {
    assert.equal(readRuntimeNotice(event), undefined);
    assert.equal(isRuntimeNoticeMethod(event.method), true);
  }
  assert.equal(isRuntimeNoticeMethod("futureWarning"), false);
  assert.equal(
    readRuntimeNotice({
      method: "deprecationNotice",
      params: { summary: "deprecated", details: "d".repeat(20_000) },
    })?.detail?.length,
    16_384,
  );
  assert.equal(
    readRuntimeNotice({
      method: "warning",
      params: { threadId: null, message: "x".repeat(5_000) },
    })?.message.length,
    4_096,
  );
});
