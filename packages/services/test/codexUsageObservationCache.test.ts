import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createCodezAgentService } from "../src/codez-agent/codezAgentService.js";
import {
  CodexUsageObservationCache,
  codexUsageObservationId,
} from "../src/usage-stats/codexUsageObservationCache.js";

const workspace = { workspacePath: "/workspace", workspaceIdentity: " identity " };
const payloadA = { inputTokens: 10, outputTokens: 5, cacheReadTokens: 2 };
const payloadB = { inputTokens: 12, outputTokens: 6, cacheReadTokens: 4 };
const payloadWithUnavailableFields = {
  inputTokens: 12,
  outputTokens: "bad",
  cacheReadTokens: 4,
  requestCount: 99,
  contextWindow: { usedTokens: 8, maxTokens: "bad" },
};

test("observation identity is canonical, sparse, deterministic and independent of update ids", () => {
  const id = codexUsageObservationId("identity", "thread", {
    cacheWriteTokens: 1,
    contextWindow: { maxTokens: 100, usedTokens: 20 },
    ...payloadA,
  });
  const expected = createHash("sha256")
    .update(
      JSON.stringify({
        contextWindow: { maxTokens: 100, usedTokens: 20 },
        inputTokens: 10,
        outputTokens: 5,
        cacheReadTokens: 2,
        cacheWriteTokens: 1,
        workspaceKey: "identity",
        threadId: "thread",
      }),
      "utf8",
    )
    .digest("hex");
  assert.equal(id, expected);
  assert.equal(
    id,
    codexUsageObservationId("identity", "thread", {
      ...payloadA,
      cacheWriteTokens: 1,
      contextWindow: { usedTokens: 20, maxTokens: 100 },
    }),
  );
  const sparse = codexUsageObservationId("identity", "thread", payloadWithUnavailableFields);
  assert.equal(
    sparse,
    codexUsageObservationId("identity", "thread", {
      inputTokens: 12,
      cacheReadTokens: 4,
      contextWindow: { usedTokens: 8 },
    }),
  );
});

test("duplicate delivery is a no-op; newest wins and regression becomes latest plus conflict", () => {
  const cache = new CodexUsageObservationCache(workspace);
  assert.equal(cache.observe("thread", payloadA), true);
  assert.equal(cache.observe("thread", payloadA), false);
  assert.equal(cache.observe("thread", payloadB), true);
  assert.equal(cache.observe("thread", payloadA), true);
  const state = cache.snapshot().threads.get("thread");
  assert.deepEqual(state?.observation.payload, payloadA);
  assert.equal(state?.conflict, true);
  assert.equal(cache.snapshot().conflict, true);
});

test("authoritative replacement is outside normal delivery and scopes conflict to its thread", () => {
  const cache = new CodexUsageObservationCache(workspace);
  cache.observe("a", payloadA);
  cache.observe("b", payloadA);
  cache.observe("a", payloadB);
  cache.observe("a", payloadA); // regression
  cache.reconcile("a", payloadA);
  assert.equal(cache.snapshot().threads.get("a")?.conflict, false);
  assert.equal(cache.snapshot().threads.get("b")?.conflict, false);

  cache.observe("a", payloadB);
  cache.reconcile("a", payloadA);
  assert.equal(cache.snapshot().threads.get("a")?.conflict, true);
  assert.equal(cache.snapshot().conflict, true);

  cache.observe("b", payloadB);
  cache.observe("b", payloadA); // unrelated regression
  cache.reconcile("a", payloadA);
  assert.equal(cache.snapshot().threads.get("a")?.conflict, false);
  assert.equal(cache.snapshot().threads.get("b")?.conflict, true);
  assert.equal(cache.snapshot().conflict, true);
});

test("workspace cache key uses trimmed identity with local path fallback", () => {
  assert.equal(new CodexUsageObservationCache(workspace).workspaceKey, "identity");
  assert.equal(
    new CodexUsageObservationCache({ workspacePath: "/workspace", workspaceIdentity: "   " })
      .workspaceKey,
    "/workspace",
  );
});

test("runtime unavailable retains facts as stale until a new validated observation arrives", () => {
  const cache = new CodexUsageObservationCache(workspace);
  cache.observe("thread", payloadA);
  assert.equal(cache.snapshot().stale, false);
  cache.markRuntimeUnavailable();
  const retained = cache.snapshot();
  assert.equal(retained.stale, true);
  assert.deepEqual(retained.threads.get("thread")?.observation.payload, payloadA);

  assert.equal(cache.observe("thread", payloadA), false);
  assert.equal(cache.snapshot().stale, false);

  cache.markRuntimeUnavailable();
  cache.reconcile("thread", payloadA);
  assert.equal(cache.snapshot().stale, false);
});

test("runtime unavailable marks the service-owned cache stale by workspace", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "codez-usage-runtime-"));
  const bridge = join(cwd, "packages/codex-bridge/dist/bridge.cjs");
  const native = join(cwd, "packages/codex-bridge/dist/codex");
  const service = createCodezAgentService({
    presentationSurface: "desktop",
    commandResolver: (target) => ({
      command: process.execPath,
      args: [bridge],
      cwd: target.workspacePath,
      env: { CODEZ_CODEX_COMMAND: native },
    }),
  });
  try {
    await mkdir(dirname(bridge), { recursive: true });
    await writeFile(native, "");
    await writeFile(
      bridge,
      `const { createInterface } = require("node:readline");
      createInterface({ input: process.stdin }).on("line", (line) => {
        const request = JSON.parse(line);
        process.stdout.write(JSON.stringify({ id: request.id, result: {} }) + "\\n");
      });
    `,
    );
    const client = await service.codexRequest({
      workspacePath: cwd,
      workspaceIdentity: "usage-identity",
      request: { method: "account/read" },
    });
    assert.deepEqual(client, {});
    const before = await service.getCodexUsageObservations({
      workspacePath: cwd,
      workspaceIdentity: "usage-identity",
    });
    assert.equal(before.stale, false);
    await service.disposeWorkspace({ workspacePath: cwd, workspaceIdentity: "usage-identity" });
    const after = await service.getCodexUsageObservations({
      workspacePath: cwd,
      workspaceIdentity: "usage-identity",
    });
    assert.equal(after.stale, true);
  } finally {
    await service.disposeAllAndWait();
    await rm(cwd, { recursive: true, force: true });
  }
});
