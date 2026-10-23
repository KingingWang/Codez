import assert from "node:assert/strict";
import test from "node:test";
import {
  parseCodexBridgeOversizedFrameDiagnostic,
  parseCodexBridgeRpcTimeoutDiagnostic,
  parseCodexBridgeTitleDiagnostic,
  parseCodexBridgeNativeStderrSummary,
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
  assert.equal(
    parseCodexBridgeNativeStderrSummary(
      "Codex desktop bridge warn: native stderr summary; exitCode=3221225781; signal=null; lineCount=1; byteCount=13; truncated=false; level=error; target=none; categories=error",
    )?.exitCode,
    3221225781,
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

test("oversized native frame warnings contain only bounded category, method and size", () => {
  assert.deepEqual(
    parseCodexBridgeOversizedFrameDiagnostic(
      "Codex desktop bridge warn: oversized native frame; kind=response; method=thread/resume; observedBytes=33554433",
    ),
    { kind: "response", method: "thread/resume", observedBytes: 33554433 },
  );
  for (const line of [
    "Codex desktop bridge warn: oversized native frame; kind=response; method=thread/resume; observedBytes=0",
    "Codex desktop bridge warn: oversized native frame; kind=response; method=thread/resume; observedBytes=33554433; path=/secret",
    "Codex desktop bridge warn: oversized native frame; kind=response; method=/secret; observedBytes=33554433",
    "Codex desktop bridge warn: oversized native frame; kind=secret; method=thread/read; observedBytes=33554433",
  ])
    assert.equal(parseCodexBridgeOversizedFrameDiagnostic(line), undefined);
});

test("native stderr summaries accept only closed bounded fields", () => {
  assert.deepEqual(
    parseCodexBridgeNativeStderrSummary(
      "Codex desktop bridge warn: native stderr summary; exitCode=7; signal=null; lineCount=3; byteCount=158; truncated=true; level=error; target=codex_core::config::provider; categories=connection,error,tls",
    ),
    {
      exitCode: 7,
      signal: null,
      lineCount: 3,
      byteCount: 158,
      truncated: true,
      level: "error",
      target: "codex_core::config::provider",
      categories: ["connection", "error", "tls"],
    },
  );
  for (const line of [
    "Codex desktop bridge warn: native stderr summary; exitCode=7; signal=null; lineCount=0; byteCount=0; truncated=false; level=unknown; target=none; categories=none",
    "Codex desktop bridge warn: native stderr summary; exitCode=999999; signal=null; lineCount=3; byteCount=1; truncated=false; level=error; target=codex_core; categories=error",
    "Codex desktop bridge warn: native stderr summary; exitCode=4294967296; signal=null; lineCount=3; byteCount=1; truncated=false; level=error; target=codex_core; categories=error",
    "Codex desktop bridge warn: native stderr summary; exitCode=7; signal=null; lineCount=3; byteCount=1; truncated=false; level=error; target=/secret/path; categories=error",
    "Codex desktop bridge warn: native stderr summary; exitCode=7; signal=null; lineCount=3; byteCount=1; truncated=false; level=error; target=codex_core; categories=secret",
    "Codex desktop bridge warn: native stderr summary; exitCode=7; signal=null; lineCount=3; byteCount=1; truncated=false; level=error; target=codex_core; categories=error; message=secret",
    "unrelated stderr line",
  ])
    assert.equal(parseCodexBridgeNativeStderrSummary(line), undefined);
});

test("native stderr summaries stay out of unsafe exit tails", () => {
  const summary = parseCodexBridgeNativeStderrSummary(
    "Codex desktop bridge warn: native stderr summary; exitCode=null; signal=SIGKILL; lineCount=2; byteCount=200; truncated=false; level=warn; target=codex_core::provider; categories=connection",
  );
  assert.deepEqual(summary, {
    exitCode: null,
    signal: "SIGKILL",
    lineCount: 2,
    byteCount: 200,
    truncated: false,
    level: "warn",
    target: "codex_core::provider",
    categories: ["connection"],
  });
});
