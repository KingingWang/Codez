import assert from "node:assert/strict";
import test from "node:test";
import { codexFeatureCapabilitiesSchema } from "@codez/shared";
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
  // 根因：硬编码能力数量遗漏了新增 messageFeedback；以公开协议字段为准，
  // 既验证旧 peer 全部 fail-closed，也防止以后新增字段时投影漏项。
  assert.deepEqual(
    Object.keys(projection).sort(),
    Object.keys(codexFeatureCapabilitiesSchema.shape).sort(),
  );
  for (const availability of Object.values(projection)) {
    assert.equal(availability.status, "unsupported");
  }
  assert.equal(codexCapabilityGate(availability("legacyWorkflowRuns")).hidden, false);
  assert.equal(codexCapabilityGate(availability("legacyWorkflowRuns")).disabled, true);
  // 旧 peer 缺省 autoReviewApprovals → unsupported（composer 隐藏"帮我审批"档）。
  assert.equal(availability("autoReviewApprovals").status, "unsupported");
  assert.equal(codexCapabilityGate(availability("autoReviewApprovals")).disabled, true);
  assert.equal(availability("messageFeedback").status, "unsupported");
});

test("autoReviewApprovals only surfaces as supported when the bridge probed it", () => {
  const supported = projectCodexCapabilities({
    available: true,
    codex: {
      auxiliaryTextGeneration: "unsupported",
      observedSessionUsage: "supported",
      observedAppUsage: "supported",
      sharedContextContentCopy: "unsupported",
      scheduledPromptAutomations: "supported",
      nativeBrowserCuaMcp: "unsupported",
      readOnlyWorkflowHistory: "supported",
      safeDesktopFileRewind: "supported",
      legacyWorkflowRuns: "unsupported",
      autoReviewApprovals: "supported",
    },
  });
  assert.equal(codexCapabilityGate(supported.autoReviewApprovals).disabled, false);
  const denied = projectCodexCapabilities({
    available: true,
    codex: { autoReviewApprovals: "unsupported" },
  });
  assert.equal(codexCapabilityGate(denied.autoReviewApprovals).disabled, true);
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
