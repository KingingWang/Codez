import assert from "node:assert/strict";
import test from "node:test";
import { attachWorkspaceToModelSelectionInput } from "./useModelSelectionView.js";

test("automation selection reads use the target workspace instead of an empty Codex catalog", () => {
  const input = {
    selection: {
      providerId: "openai",
      modelId: "gpt-5-codex",
      options: { reasoningLevel: "medium" },
    },
  };
  const local = attachWorkspaceToModelSelectionInput(input, "/project/a");
  assert.deepEqual(local, {
    ...input,
    workspace: { workspacePath: "/project/a" },
  });
  assert.deepEqual(attachWorkspaceToModelSelectionInput(input, "/project/b", " remote-b "), {
    ...input,
    workspace: { workspacePath: "/project/b", workspaceIdentity: "remote-b" },
  });
  assert.deepEqual(input, {
    selection: {
      providerId: "openai",
      modelId: "gpt-5-codex",
      options: { reasoningLevel: "medium" },
    },
  });
});

test("callers without selection input keep their legacy view request unchanged", () => {
  assert.equal(attachWorkspaceToModelSelectionInput(undefined, "/project/a"), undefined);
});
