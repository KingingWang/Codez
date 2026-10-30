import assert from "node:assert/strict";
import test from "node:test";
import { describeBridgeFailure, formatBridgeStateDiagnostic } from "../src/diagnostics.js";
import { CodexRpcError, CodexTransportError } from "../src/rpc-errors.js";
import { z } from "zod";

test("production failure diagnostics distinguish known failures without logging user data", () => {
  const secret = "secret-token /Users/private/workspace private-message-id";
  for (const [error, category] of [
    [new Error(`Duplicate Codex item ID: ${secret}`), "duplicate-item-id"],
    [new Error(`Duplicate Codex item ID in turn ${secret}: ${secret}`), "duplicate-item-id"],
    [new Error("Duplicate Codex thread ID in sessions index"), "duplicate-thread-id"],
    [new CodexRpcError(-32001, secret), "native-rpc"],
    [new CodexTransportError("PROTOCOL", secret), "native-transport"],
    [new z.ZodError([{ code: "custom", path: [secret], message: secret }]), "schema-validation"],
    [new Error(secret), "adapter-failure"],
  ] as const) {
    error.stack = `Error: ${secret}\n    at ${secret}:1:2`;
    const result = describeBridgeFailure(error, "conversation-projection");
    assert.equal(result.category, category);
    assert.equal(result.origin, "conversation-projection");
    assert.doesNotMatch(JSON.stringify(result), /secret|private|Users/);
  }
});

test("diagnostics expose only safe typed codes, including initialization failures", () => {
  assert.deepEqual(describeBridgeFailure(new CodexTransportError("STARTUP", "hidden"), "startup"), {
    category: "native-transport",
    origin: "startup",
    code: "STARTUP",
  });
  assert.deepEqual(describeBridgeFailure(new CodexRpcError(-32001, "hidden"), "native-event"), {
    category: "native-rpc",
    origin: "native-event",
    code: -32001,
  });
  assert.deepEqual(describeBridgeFailure(Object.assign(new Error("hidden"), { code: "secret" })), {
    category: "adapter-failure",
    origin: "host-protocol",
  });
});

test("state diagnostics whitelist IDs and statuses before writing stderr", () => {
  const line = formatBridgeStateDiagnostic({
    kind: "snapshotPrepared",
    deliveryKind: "initial",
    sessionId: "/private/session",
    subscriptionId: "sub-1",
    logEpoch: "epoch-1",
    seq: 5,
    phase: "running",
    lastTurnId: "token\nsecret",
  });
  assert.equal(
    line,
    "Codex desktop bridge state: snapshotPrepared; deliveryKind=initial; sessionId=none; subscriptionId=sub-1; logEpoch=epoch-1; seq=5; phase=running; lastTurnId=none\n",
  );
  const rejected = formatBridgeStateDiagnostic({
    kind: "continueRejected",
    sessionId: "thread-1",
    commandId: "command-1",
    nativeStatus: "/private",
    latestTurnStatus: "secret",
    selectedRunningTurnId: "turn-1",
    runningTurnCount: 3,
    logEpoch: "epoch-1",
    seq: 2,
    revision: 4,
  });
  assert.match(rejected, /nativeStatus=unknown; latestTurnStatus=unknown/);
  assert.doesNotMatch(line + rejected, /private|token|secret/);
});

test("subagent stop fallback stderr 不包含原生错误正文或非法 ID", () => {
  assert.equal(
    formatBridgeStateDiagnostic({
      kind: "subagentStopFallback",
      sessionId: "parent-1",
      childSessionId: "/private/token\nsecret",
    }),
    "Codex desktop bridge state: subagentStopFallback; sessionId=parent-1; childSessionId=none\n",
  );
});
