import assert from "node:assert/strict";
import test from "node:test";
import { describeBridgeFailure } from "../src/diagnostics.js";
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
