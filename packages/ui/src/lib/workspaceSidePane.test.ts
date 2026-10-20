import assert from "node:assert/strict";
import test from "node:test";
import { NATIVE_BROWSER_CUA_SESSION_ID } from "@codez/shared";
import {
  applyBrowserUseSidePaneEvent,
  getNativeBrowserCuaPopupSource,
  getVisibleSidePaneTabs,
  isNativeBrowserCuaWindowTab,
  isSidePaneTabVisibleForParent,
  openBrowserSidePane,
  resolveBrowserSidePaneGuestScope,
  shouldRevealNativeBrowserCuaPopup,
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

test("native browser popup keeps synthetic ownership while remaining visible for the current task", () => {
  const current: WorkspaceSidePaneState = {
    tabs: [{ ...nativeTab }],
    activeTabId: nativeTab.id,
  };
  const popupSource = getNativeBrowserCuaPopupSource(current, {
    sourceTabId: nativeTab.tabId,
    workspaceKey: nativeTab.workspaceKey,
    sessionId: nativeTab.sessionId,
  });
  assert.equal(popupSource?.id, nativeTab.id);
  assert.equal(shouldRevealNativeBrowserCuaPopup(current, popupSource, true), true);
  assert.equal(shouldRevealNativeBrowserCuaPopup(current, popupSource, false), false);
  assert.equal(
    shouldRevealNativeBrowserCuaPopup({ ...current, activeTabId: "" }, popupSource, true),
    false,
  );

  const opened = openBrowserSidePane(current, {
    initialUrl: "https://example.test/popup",
    ownerTaskId: NATIVE_BROWSER_CUA_SESSION_ID,
    workspaceKey: nativeTab.workspaceKey,
    agentOpened: true,
  });
  const popup = opened.tabs.find((tab) => tab.type === "browser");
  assert.ok(popup);
  assert.equal(isNativeBrowserCuaWindowTab(popup), true);
  assert.equal(popup.workspaceKey, nativeTab.workspaceKey);
  assert.equal(
    getVisibleSidePaneTabs(opened.tabs, {
      workspaceKey: "/workspace/a",
      ownerTaskId: "session-1",
    }).some((tab) => tab.id === popup.id),
    true,
  );
  assert.equal(
    getNativeBrowserCuaPopupSource(opened, {
      sourceTabId: popup.id,
      workspaceKey: nativeTab.workspaceKey,
      sessionId: NATIVE_BROWSER_CUA_SESSION_ID,
    })?.id,
    popup.id,
  );
  const background = openBrowserSidePane(current, {
    initialUrl: "https://example.test/background",
    ownerTaskId: NATIVE_BROWSER_CUA_SESSION_ID,
    workspaceKey: nativeTab.workspaceKey,
    agentOpened: true,
    activate: false,
  });
  assert.equal(background.activeTabId, nativeTab.id);
  assert.equal(
    getVisibleSidePaneTabs(background.tabs, {
      workspaceKey: "/workspace/a",
      ownerTaskId: "session-1",
    }).length,
    2,
  );
  assert.deepEqual(resolveBrowserSidePaneGuestScope(popup, "remote-session-active"), {
    workspaceKey: nativeTab.workspaceKey,
    remoteSessionId: undefined,
  });
});

test("native popup detection rejects stale owners, forged scopes and ordinary browser tabs", () => {
  const current: WorkspaceSidePaneState = {
    tabs: [nativeTab, agentTab],
    activeTabId: nativeTab.id,
  };
  assert.equal(
    getNativeBrowserCuaPopupSource(current, {
      sourceTabId: "missing-tab",
      workspaceKey: nativeTab.workspaceKey,
      sessionId: NATIVE_BROWSER_CUA_SESSION_ID,
    }),
    undefined,
  );
  assert.equal(
    getNativeBrowserCuaPopupSource(current, {
      sourceTabId: nativeTab.tabId,
      workspaceKey: "/workspace/a",
      sessionId: NATIVE_BROWSER_CUA_SESSION_ID,
    }),
    undefined,
  );
  assert.equal(
    getNativeBrowserCuaPopupSource(current, {
      sourceTabId: nativeTab.tabId,
      workspaceKey: nativeTab.workspaceKey,
      sessionId: NATIVE_BROWSER_CUA_SESSION_ID,
      remoteSessionId: "unrelated-remote-session",
    }),
    undefined,
  );
  assert.equal(
    getNativeBrowserCuaPopupSource(current, {
      sourceTabId: agentTab.tabId,
      workspaceKey: agentTab.workspaceKey,
      sessionId: agentTab.sessionId,
    }),
    undefined,
  );
  const ordinary = openBrowserSidePane(current, {
    initialUrl: "https://example.test/ordinary",
    ownerTaskId: "session-1",
    workspaceKey: "/workspace/a",
    agentOpened: true,
  });
  const ordinaryTab = ordinary.tabs.find((tab) => tab.type === "browser");
  assert.ok(ordinaryTab);
  assert.equal(isNativeBrowserCuaWindowTab(ordinaryTab), false);
  assert.deepEqual(resolveBrowserSidePaneGuestScope(ordinaryTab, "remote-session-active"), {
    workspaceKey: undefined,
    remoteSessionId: "remote-session-active",
  });
});
