import assert from "node:assert/strict";
import { test } from "node:test";
import { isAutomationEditSubmissionContextReady } from "./automationEditValidation.js";

test("Host-validated custom Codex default absent from discovery and without effort is submit-ready", () => {
  assert.equal(
    isAutomationEditSubmissionContextReady({
      workspaceSelected: true,
      modelViewReady: true,
      selectedModelValue: "ui_qa/ui-qa-offline",
    }),
    true,
  );
});

test("a missing workspace, model, or valid Host view never enables submission", () => {
  const ready = {
    workspaceSelected: true,
    modelViewReady: true,
    selectedModelValue: "ui_qa/gpt-6-astra",
  };
  assert.equal(
    isAutomationEditSubmissionContextReady({ ...ready, workspaceSelected: false }),
    false,
  );
  assert.equal(isAutomationEditSubmissionContextReady({ ...ready, modelViewReady: false }), false);
  assert.equal(isAutomationEditSubmissionContextReady({ ...ready, selectedModelValue: "" }), false);
  assert.equal(
    isAutomationEditSubmissionContextReady({ ...ready, selectionIssue: "model-not-found" }),
    false,
  );
});
