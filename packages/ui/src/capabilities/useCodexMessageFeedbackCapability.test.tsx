import assert from "node:assert/strict";
import test from "node:test";

import { projectCodexCapabilities } from "./codexCapabilities.js";
import { isCodexMessageFeedbackAvailable } from "./useCodexMessageFeedbackCapability.js";

function feedbackAvailability(state: "supported" | "degraded" | "unsupported" | undefined) {
  return projectCodexCapabilities({
    available: state !== undefined,
    ...(state !== undefined
      ? {
          codex: {
            auxiliaryTextGeneration: "unsupported",
            observedSessionUsage: "unsupported",
            observedAppUsage: "unsupported",
            sharedContextContentCopy: "unsupported",
            scheduledPromptAutomations: "unsupported",
            nativeBrowserCuaMcp: "unsupported",
            readOnlyWorkflowHistory: "unsupported",
            safeDesktopFileRewind: "unsupported",
            legacyWorkflowRuns: "unsupported",
            messageFeedback: state,
          },
        }
      : {}),
  }).messageFeedback;
}

test("message feedback renders only on an explicit supported capability", () => {
  assert.equal(isCodexMessageFeedbackAvailable(feedbackAvailability("supported")), true);
  assert.equal(isCodexMessageFeedbackAvailable(feedbackAvailability("degraded")), false);
  assert.equal(isCodexMessageFeedbackAvailable(feedbackAvailability("unsupported")), false);
  // 旧 peer 缺省字段 / hello 缺失 capabilities：一律 fail-closed 隐藏。
  assert.equal(isCodexMessageFeedbackAvailable(feedbackAvailability(undefined)), false);
  assert.equal(
    isCodexMessageFeedbackAvailable(projectCodexCapabilities({ available: false }).messageFeedback),
    false,
  );
});

test("Codex feedback gating does not remove Web/legacy feedback handlers", () => {
  for (const state of ["supported", "degraded", "unsupported", undefined] as const) {
    assert.equal(isCodexMessageFeedbackAvailable(feedbackAvailability(state), false), true);
  }
  const legacyHello = projectCodexCapabilities({ available: true }).messageFeedback;
  assert.equal(isCodexMessageFeedbackAvailable(legacyHello, false), true);
  assert.equal(isCodexMessageFeedbackAvailable(legacyHello, true), false);
});
