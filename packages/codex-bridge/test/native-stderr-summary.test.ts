import assert from "node:assert/strict";
import test from "node:test";
import { NativeStderrSummarizer } from "../src/native-stderr-summary.js";

test("native stderr summaries are bounded across chunks without a trailing newline", () => {
  const summarizer = new NativeStderrSummarizer();
  summarizer.append(Buffer.from(" INFO codex_core::"));
  summarizer.append(Buffer.from("provider: connection failed /secret "));
  const summary = summarizer.finish();
  assert.equal(summary.lineCount, 1);
  assert.equal(summary.byteCount, 54);
  assert.equal(summary.truncated, false);
  assert.deepEqual(
    { level: summary.level, target: summary.target, categories: summary.categories },
    { level: "info", target: "codex_core::provider", categories: ["connection", "error"] },
  );
});
