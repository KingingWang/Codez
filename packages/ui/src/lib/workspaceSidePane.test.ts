import assert from "node:assert/strict";
import test from "node:test";
import { NATIVE_BROWSER_CUA_SESSION_ID } from "@codez/shared";
import {
  applyBrowserUseSidePaneEvent,
  isSidePaneTabVisibleForParent,
  type BrowserUseSidePaneTab,
  type WorkspaceSidePaneState,
} from "./workspaceSidePane.js";

const nativeTab: BrowserUseSidePaneTab = {
  id: "browser-use:native-tab-1",
  type: "browser-use",
  workspaceKey: "native-browser-cua:dev",
  sessionId: NATIVE_BROWSER_CUA_SESSION_ID,
  tabId: "native-tab-1",
};

const agentTab: BrowserUseSidePaneTab = {
  id: "browser-use:agent-tab-1",
  type: "browser-use",
  workspaceKey: "/workspace/a",
  sessionId: "session-1",
  tabId: "agent-tab-1",
};

test("native browser CUA tab is window-scoped: visible for any workspace and conversation", () => {
  assert.equal(isSidePaneTabVisibleForParent(nativeTab, "session-1"), true);
  assert.equal(isSidePaneTabVisibleForParent(nativeTab, null), true);
  // 非原生 browser-use tab 仍严格按会话归属可见。
  assert.equal(isSidePaneTabVisibleForParent(agentTab, "session-1"), true);
  assert.equal(isSidePaneTabVisibleForParent(agentTab, "session-2"), false);
});

test("native browser CUA ready event reveals a newly created tab despite synthetic scope", () => {
  const current: WorkspaceSidePaneState = { tabs: [], activeTabId: "" };
  const result = applyBrowserUseSidePaneEvent(
    current,
    {
      workspaceKey: "native-browser-cua:dev",
      sessionId: NATIVE_BROWSER_CUA_SESSION_ID,
      tabId: "native-tab-1",
    },
    { workspaceKey: "/workspace/a", ownerTaskId: "session-1" },
  );
  assert.equal(result.shouldReveal, true);
  assert.equal(result.state.activeTabId, "browser-use:native-tab-1");
});

test("replayed native ready event for an existing tab stays in the background", () => {
  const current: WorkspaceSidePaneState = {
    tabs: [{ ...nativeTab }],
    activeTabId: "",
  };
  const result = applyBrowserUseSidePaneEvent(
    current,
    {
      workspaceKey: "native-browser-cua:dev",
      sessionId: NATIVE_BROWSER_CUA_SESSION_ID,
      tabId: "native-tab-1",
    },
    { workspaceKey: "/workspace/a", ownerTaskId: "session-1" },
  );
  assert.equal(result.shouldReveal, false);
  assert.equal(result.state.activeTabId, "");
});

test("non-native browser-use ready event still requires exact scope match to reveal", () => {
  const current: WorkspaceSidePaneState = { tabs: [], activeTabId: "" };
  const mismatched = applyBrowserUseSidePaneEvent(
    current,
    { workspaceKey: "/workspace/a", sessionId: "session-2", tabId: "agent-tab-2" },
    { workspaceKey: "/workspace/a", ownerTaskId: "session-1" },
  );
  assert.equal(mismatched.shouldReveal, false);
  const matched = applyBrowserUseSidePaneEvent(
    current,
    { workspaceKey: "/workspace/a", sessionId: "session-1", tabId: "agent-tab-3" },
    { workspaceKey: "/workspace/a", ownerTaskId: "session-1" },
  );
  assert.equal(matched.shouldReveal, true);
});
