import assert from "node:assert/strict";
import test from "node:test";

import { projectCodexCapabilities } from "./codexCapabilities.js";
import {
  bindRuntimeCapabilityRefresh,
  isCodexDesktopFileRewindAvailable,
} from "./useCodexDesktopFileRewindCapability.js";

function availability(state: "supported" | "degraded" | "unsupported" | undefined) {
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
            safeDesktopFileRewind: state,
            legacyWorkflowRuns: "unsupported",
          },
        }
      : {}),
  }).safeDesktopFileRewind;
}

test("desktop rewind is enabled only by an explicit supported bridge capability", () => {
  assert.equal(isCodexDesktopFileRewindAvailable(availability("supported")), true);
  assert.equal(isCodexDesktopFileRewindAvailable(availability("degraded")), false);
  assert.equal(isCodexDesktopFileRewindAvailable(availability("unsupported")), false);
  assert.equal(
    isCodexDesktopFileRewindAvailable(
      projectCodexCapabilities({ available: false }).safeDesktopFileRewind,
    ),
    false,
  );
});

test("rewind capability refresh receives both runtime and transport replacement", () => {
  let restartListener: ((reason?: "runtimeRestart" | "transportReplaced") => void) | undefined;
  let lifecycleListener: ((state: "available" | "unavailable") => void) | undefined;
  const refreshes: Array<string | undefined> = [];
  const unsubscribe = bindRuntimeCapabilityRefresh(
    {
      onRuntimeRestart(listener) {
        restartListener = listener;
        return () => {
          restartListener = undefined;
        };
      },
      onRuntimeLifecycle(listener) {
        lifecycleListener = listener;
        return () => {
          lifecycleListener = undefined;
        };
      },
    },
    () => refreshes.push("refresh"),
  );
  assert.equal(typeof restartListener, "function");
  assert.equal(typeof lifecycleListener, "function");

  // The restart channel carries both a new process and stable Local Host proxy handoff.
  restartListener?.();
  restartListener?.("transportReplaced");
  assert.deepEqual(refreshes, ["refresh", "refresh"]);

  // Lifecycle `available` covers process readiness without implying restart replacement.
  lifecycleListener?.("unavailable");
  lifecycleListener?.("available");
  assert.deepEqual(refreshes, ["refresh", "refresh", "refresh"]);

  unsubscribe();
  assert.equal(restartListener, undefined);
  assert.equal(lifecycleListener, undefined);
});
