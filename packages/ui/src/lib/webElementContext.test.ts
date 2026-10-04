import assert from "node:assert/strict";
import test from "node:test";
import {
  NATIVE_BROWSER_CUA_SESSION_ID,
  NATIVE_BROWSER_CUA_WORKSPACE_KEY_PREFIX,
} from "@codez/shared";
import {
  getWebElementContextWorkspaceKey,
  resolveWebElementContextWorkspaceIdentity,
} from "./webElementContext.js";

const syntheticKey = `${NATIVE_BROWSER_CUA_WORKSPACE_KEY_PREFIX}test-window`;

test("native browser selection targets the currently displayed local chat, not the guest owner", () => {
  const contextIdentity = resolveWebElementContextWorkspaceIdentity({
    browserWorkspaceKey: syntheticKey,
    browserSessionId: NATIVE_BROWSER_CUA_SESSION_ID,
  });
  assert.equal(contextIdentity, undefined);
  assert.equal(getWebElementContextWorkspaceKey("/workspace/a", contextIdentity), "/workspace/a");
});

test("native browser selection targets the currently displayed remote workspace identity", () => {
  assert.equal(
    resolveWebElementContextWorkspaceIdentity({
      browserWorkspaceKey: syntheticKey,
      browserSessionId: NATIVE_BROWSER_CUA_SESSION_ID,
      workspaceIdentity: "remote-workspace-a",
    }),
    "remote-workspace-a",
  );
});

test("regular Browser Use selections preserve their frozen owner even if ambient workspace changes", () => {
  assert.equal(
    resolveWebElementContextWorkspaceIdentity({
      browserWorkspaceKey: "agent-workspace-a",
      browserSessionId: "agent-session-a",
      workspaceIdentity: "currently-visible-workspace-b",
    }),
    "agent-workspace-a",
  );
  assert.equal(
    resolveWebElementContextWorkspaceIdentity({
      browserWorkspaceKey: syntheticKey,
      browserSessionId: "agent-session-a",
      workspaceIdentity: "currently-visible-workspace-b",
    }),
    syntheticKey,
  );
});
