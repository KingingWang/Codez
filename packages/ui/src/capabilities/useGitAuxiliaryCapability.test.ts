import assert from "node:assert/strict";
import test from "node:test";
import { codexCapabilityGate, projectCodexCapabilities } from "./codexCapabilities.js";

test("Git auxiliary capability stays disabled for missing and unsupported projections", () => {
  const unavailable = projectCodexCapabilities({ available: false });
  const missing = projectCodexCapabilities({ available: true, codex: undefined });
  const unsupported = projectCodexCapabilities({
    available: true,
    codex: { auxiliaryTextGeneration: "unsupported" },
  });
  for (const projection of [unavailable, missing, unsupported]) {
    const gate = codexCapabilityGate(projection.auxiliaryTextGeneration);
    assert.equal(gate.hidden, false);
    assert.equal(gate.disabled, true);
    assert.equal(gate.degraded, false);
    assert.ok(gate.reason);
  }
  assert.equal(
    codexCapabilityGate(unavailable.auxiliaryTextGeneration).reason,
    "codex.capabilities.unavailable",
  );
  assert.equal(
    codexCapabilityGate(missing.auxiliaryTextGeneration).reason,
    "codex.capabilities.auxiliaryTextGeneration.unsupported",
  );
  assert.equal(
    codexCapabilityGate(unsupported.auxiliaryTextGeneration).reason,
    "codex.capabilities.auxiliaryTextGeneration.unsupported",
  );
});
