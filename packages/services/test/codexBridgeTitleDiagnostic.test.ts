import assert from "node:assert/strict";
import test from "node:test";
import { parseCodexBridgeTitleDiagnostic } from "../src/codez-agent/codexBridgeTitleDiagnostic.js";

test("only bounded automatic-title diagnostics can become production warnings", () => {
  assert.deepEqual(
    parseCodexBridgeTitleDiagnostic(
      "Codex desktop bridge warn: automatic title failed; stage=generation; code=-32600",
    ),
    { stage: "generation", code: "-32600" },
  );
  assert.deepEqual(
    parseCodexBridgeTitleDiagnostic(
      "Codex desktop bridge warn: automatic title failed; stage=native-write; code=TIMEOUT",
    ),
    { stage: "native-write", code: "TIMEOUT" },
  );
  for (const line of [
    "Codex desktop bridge warn: automatic title failed; stage=generation; code=-32600; prompt=secret",
    "Codex desktop bridge warn: automatic title failed; stage=generation; code=/workspace",
    "Codex desktop bridge warn: automatic title failed; stage=secret; code=-32600",
    "unrelated stderr line",
  ])
    assert.equal(parseCodexBridgeTitleDiagnostic(line), undefined);
});
