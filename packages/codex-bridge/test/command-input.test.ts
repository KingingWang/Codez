import assert from "node:assert/strict";
import test from "node:test";
import { assertUnchangedInputSettings, turnMode } from "../src/command-input.js";

test("queue/steer cannot silently discard a changed native model or permission intent", () => {
  const thread = {
    model: "m",
    modelProvider: "p",
    reasoningEffort: "high",
    sandboxPolicy: { type: "readOnly" },
    collaborationMode: { mode: "default" },
  };
  assert.doesNotThrow(() =>
    assertUnchangedInputSettings(
      {
        mode: "build",
        planEnabled: false,
        modelSelection: { modelId: "m", providerId: "p", options: { reasoningLevel: "high" } },
      },
      thread,
    ),
  );
  assert.throws(() => assertUnchangedInputSettings({ mode: "yolo" }, thread), /settings/);
  assert.throws(() => assertUnchangedInputSettings({ planEnabled: true }, thread), /settings/);
  assert.throws(
    () =>
      assertUnchangedInputSettings(
        { modelSelection: { modelId: "different", providerId: "p" } },
        thread,
      ),
    /settings/,
  );
});

test("ordinary submissions preserve native read-only/custom policy but leaving full access restores a sandbox", () => {
  assert.equal(
    turnMode("build", "model", false, "high", { type: "readOnly" }).sandboxPolicy,
    undefined,
  );
  const downgrade = turnMode("build", "model", false, "high", { type: "dangerFullAccess" });
  assert.equal(downgrade.approvalPolicy, "on-request");
  assert.equal((downgrade.sandboxPolicy as { type: string }).type, "workspaceWrite");
  assert.equal(
    turnMode("plan", "model", true, "high", { type: "readOnly" }).sandboxPolicy,
    undefined,
  );
});
