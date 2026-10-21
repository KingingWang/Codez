import assert from "node:assert/strict";
import test from "node:test";
import {
  parseCodexBridgeRpcTimeoutDiagnostic,
  parseCodexBridgeTitleDiagnostic,
} from "../src/codez-agent/codexBridgeTitleDiagnostic.js";

test("only bounded automatic-title diagnostics can become production warnings", () => {
  assert.deepEqual(
    parseCodexBridgeTitleDiagnostic(
      "Codex desktop bridge warn: automatic title failed; stage=generation; code=-32600",
    ),
    { kind: "failed", stage: "generation", code: "-32600" },
  );
  assert.deepEqual(
    parseCodexBridgeTitleDiagnostic(
      "Codex desktop bridge warn: automatic title failed; stage=native-write; code=TIMEOUT",
    ),
    { kind: "failed", stage: "native-write", code: "TIMEOUT" },
  );
  for (const line of [
    "Codex desktop bridge warn: automatic title failed; stage=generation; code=-32600; prompt=secret",
    "Codex desktop bridge warn: automatic title failed; stage=generation; code=/workspace",
    "Codex desktop bridge warn: automatic title failed; stage=secret; code=-32600",
    "unrelated stderr line",
  ])
    assert.equal(parseCodexBridgeTitleDiagnostic(line), undefined);
});

test("bounded skip reasons become production warnings, everything else stays dropped", () => {
  // 跳过分支此前完全静默：导出日志里看不到任何线索，用户只能报告“自动命名不生效”。
  assert.deepEqual(
    parseCodexBridgeTitleDiagnostic(
      "Codex desktop bridge warn: automatic title skipped; stage=arm; reason=missing-selection",
    ),
    { kind: "skipped", stage: "arm", reason: "missing-selection" },
  );
  assert.deepEqual(
    parseCodexBridgeTitleDiagnostic(
      "Codex desktop bridge warn: automatic title skipped; stage=availability; reason=unavailable",
    ),
    { kind: "skipped", stage: "availability", reason: "unavailable" },
  );
  for (const reason of ["short-input", "invalid-title", "renamed", "first-item-mismatch"] as const)
    assert.equal(
      parseCodexBridgeTitleDiagnostic(
        `Codex desktop bridge warn: automatic title skipped; stage=generation; reason=${reason}`,
      )?.kind,
      "skipped",
    );
  for (const line of [
    // 词汇外的原因/阶段一律按不可信 stderr 丢弃。
    "Codex desktop bridge warn: automatic title skipped; stage=generation; reason=secret-path",
    "Codex desktop bridge warn: automatic title skipped; stage=native-write; reason=renamed",
    "Codex desktop bridge warn: automatic title skipped; stage=arm; reason=missing-selection; prompt=x",
    "Codex desktop bridge warn: automatic title skipped; stage=arm; code=-32600",
  ])
    assert.equal(parseCodexBridgeTitleDiagnostic(line), undefined);
});

test("only bounded native rpc timeout diagnostics can become production warnings", () => {
  assert.deepEqual(
    parseCodexBridgeRpcTimeoutDiagnostic(
      "Codex desktop bridge warn: native rpc timed out; method=thread/list; durationMs=30000; pending=2",
    ),
    { method: "thread/list", durationMs: 30000, pending: 2 },
  );
  assert.deepEqual(
    parseCodexBridgeRpcTimeoutDiagnostic(
      "Codex desktop bridge warn: native rpc timed out; method=thread/turns/list; durationMs=30000; pending=0",
    ),
    { method: "thread/turns/list", durationMs: 30000, pending: 0 },
  );
  for (const line of [
    "Codex desktop bridge warn: native rpc timed out; method=thread/list; durationMs=0; pending=0",
    "Codex desktop bridge warn: native rpc timed out; method=thread/list; durationMs=30000; pending=10000",
    "Codex desktop bridge warn: native rpc timed out; method=thread/list; durationMs=30000; pending=0; cwd=/secret",
    "Codex desktop bridge warn: native rpc timed out; method=thread list; durationMs=30000; pending=0",
  ])
    assert.equal(parseCodexBridgeRpcTimeoutDiagnostic(line), undefined);
});
