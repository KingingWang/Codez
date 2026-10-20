import assert from "node:assert/strict";
import test from "node:test";
import {
  createCodexProviderKeyGate,
  parseBlockedCodexProviderIds,
} from "../src/provider-key-gate.js";
import type { CodexRpcPort } from "../src/contract.js";

function fakeRpc(
  config?: Record<string, unknown>,
): CodexRpcPort & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    async request<T = unknown>(method: string): Promise<T> {
      calls.push(method);
      if (method === "config/read") return { config: config ?? {} } as T;
      throw new Error(`unexpected rpc ${method}`);
    },
    async respond() {},
    async respondError() {},
  };
}

test("parseBlockedCodexProviderIds parses csv and ignores blanks", () => {
  assert.deepEqual([...parseBlockedCodexProviderIds({})], []);
  const parsed = parseBlockedCodexProviderIds({
    CODEZ_CODEX_BLOCKED_PROVIDER_IDS: "a, b ,,c",
  });
  assert.deepEqual([...parsed].sort(), ["a", "b", "c"]);
});

test("blocked provider fails before any model request; others pass", async () => {
  const rpc = fakeRpc();
  const gate = createCodexProviderKeyGate({
    rpc,
    blockedProviderIds: new Set(["acme"]),
  });
  await assert.rejects(gate.assertTurnAllowed("acme"), /acme/);
  await gate.assertTurnAllowed("other");
  // 命中显式 providerId 时不读取配置。
  assert.deepEqual(rpc.calls, []);
});

test("missing explicit provider falls back to config default with caching", async () => {
  const rpc = fakeRpc({ model_provider: "acme" });
  const gate = createCodexProviderKeyGate({
    rpc,
    blockedProviderIds: new Set(["acme"]),
  });
  await assert.rejects(gate.assertTurnAllowed(undefined), /acme/);
  await assert.rejects(gate.assertTurnAllowed(undefined), /acme/);
  assert.deepEqual(rpc.calls, ["config/read"]);
  gate.invalidateConfig();
  await assert.rejects(gate.assertTurnAllowed(undefined), /acme/);
  assert.deepEqual(rpc.calls, ["config/read", "config/read"]);
});

test("empty blocked set never reads config", async () => {
  const rpc = fakeRpc({ model_provider: "acme" });
  const gate = createCodexProviderKeyGate({
    rpc,
    blockedProviderIds: new Set(),
  });
  await gate.assertTurnAllowed(undefined);
  assert.deepEqual(rpc.calls, []);
});

test("config read failure does not invent a block", async () => {
  const rpc = fakeRpc();
  rpc.request = async () => {
    throw new Error("config unavailable");
  };
  const gate = createCodexProviderKeyGate({
    rpc,
    blockedProviderIds: new Set(["acme"]),
  });
  await gate.assertTurnAllowed(undefined);
});
