import assert from "node:assert/strict";
import test from "node:test";
import {
  codexCapabilityGate,
  codexCapabilitySource,
  projectCodexCapabilities,
} from "./codexCapabilities.js";

test("old peers omit every codex feature and resolve to unsupported", () => {
  const projection = projectCodexCapabilities({ available: true, codex: undefined });
  const availability = (feature: keyof typeof projection) => {
    const value = projection[feature];
    assert.ok(value);
    return value;
  };
  assert.equal(Object.keys(projection).length, 9);
  for (const availability of Object.values(projection)) {
    assert.equal(availability.status, "unsupported");
  }
  assert.equal(codexCapabilityGate(availability("legacyWorkflowRuns")).hidden, false);
  assert.equal(codexCapabilityGate(availability("legacyWorkflowRuns")).disabled, true);
});

test("bridge states map to supported, degraded, unsupported, and unavailable UI gates", () => {
  const supported = projectCodexCapabilities({
    available: true,
    codex: {
      auxiliaryTextGeneration: "supported",
      observedSessionUsage: "supported",
      observedAppUsage: "supported",
      sharedContextContentCopy: "degraded",
      scheduledPromptAutomations: "degraded",
      nativeBrowserCuaMcp: "unsupported",
      readOnlyWorkflowHistory: "supported",
      safeDesktopFileRewind: "unsupported",
      legacyWorkflowRuns: "unsupported",
    },
  });
  assert.deepEqual(codexCapabilityGate(supported.auxiliaryTextGeneration), {
    hidden: false,
    disabled: false,
    degraded: false,
    reason: undefined,
  });
  assert.equal(codexCapabilityGate(supported.scheduledPromptAutomations).degraded, true);
  assert.equal(codexCapabilityGate(supported.legacyWorkflowRuns).disabled, true);
  const unavailable = projectCodexCapabilities({ available: false });
  const observedAppUsage = unavailable.observedAppUsage;
  assert.ok(observedAppUsage);
  assert.equal(codexCapabilityGate(observedAppUsage).disabled, true);
  assert.equal(codexCapabilityGate(observedAppUsage).reason, "codex.capabilities.unavailable");
});

test("capability discovery failure is unavailable while old-peer omission is unsupported", () => {
  const failed = projectCodexCapabilities(
    codexCapabilitySource({ capabilities: { codexUnavailable: { reason: "bridge-unavailable" } } }),
  );
  assert.equal(failed.auxiliaryTextGeneration.status, "unavailable");
  assert.equal(failed.observedAppUsage.status, "unavailable");
  assert.equal(failed.observedAppUsage.reason, "codex.capabilities.unavailable");

  const oldPeer = projectCodexCapabilities(codexCapabilitySource({ capabilities: {} }));
  assert.equal(oldPeer.auxiliaryTextGeneration.status, "unsupported");
  assert.equal(
    oldPeer.auxiliaryTextGeneration.reason,
    "codex.capabilities.auxiliaryTextGeneration.unsupported",
  );
});
