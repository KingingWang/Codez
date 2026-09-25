import assert from "node:assert/strict";
import test from "node:test";
import { resolveSessionTaskUsage } from "./codexSessionUsage.js";

test("codex sparse context usage never falls back to dense zeros", () => {
  assert.deepEqual(
    resolveSessionTaskUsage({
      contextWindow: null,
      cumulative: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
      codexObserved: { contextWindow: { usedTokens: 12, maxTokens: 100 } },
    }),
    { used: 12, size: 100 },
  );
  assert.equal(
    resolveSessionTaskUsage({
      contextWindow: { usedTokens: 99, maxTokens: 100, autoCompactThresholdTokens: null },
      cumulative: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
      codexObserved: { contextWindow: { usedTokens: 12 } },
    }),
    null,
  );
});

test("legacy dense usage remains available when no codex observation exists", () => {
  assert.deepEqual(
    resolveSessionTaskUsage({
      contextWindow: { usedTokens: 10, maxTokens: 100, autoCompactThresholdTokens: null },
      cumulative: { inputTokens: 1, outputTokens: 2, cacheReadTokens: 3, cacheWriteTokens: 4 },
    }),
    { used: 10, size: 100 },
  );
});
