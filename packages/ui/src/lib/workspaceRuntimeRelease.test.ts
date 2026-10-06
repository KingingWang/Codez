import assert from "node:assert/strict";
import test from "node:test";
import {
  closeWorkspaceTabsBeforeRemoval,
  releaseWorkspaceRuntimeBeforeRemoval,
} from "./workspaceRuntimeRelease.js";

const tabs = [
  { tabId: "tree", workspacePath: "/repo/tree", workspaceIdentity: null },
  { tabId: "child", workspacePath: "/repo/tree/child", workspaceIdentity: "remote:child" },
];

test("释放失败后保留全部 tab；重试必须再次释放，全部成功后才关闭并删除", async () => {
  const openTabs = new Map(tabs.map((tab) => [tab.tabId, tab]));
  let releaseCalls = 0;
  let removeCalls = 0;
  let mayRelease = false;
  const remove = async () => {
    await closeWorkspaceTabsBeforeRemoval({
      tabs: [...openTabs.values()],
      resolveTaskService: () => ({
        async releaseWorkspacePreparation() {
          releaseCalls += 1;
          if (!mayRelease) throw new Error("release failed");
        },
      }),
      closeTab: (id) => {
        openTabs.delete(id);
      },
      unavailableMessage: "unavailable",
    });
    removeCalls += 1;
  };

  await assert.rejects(remove(), /release failed/);
  assert.equal(openTabs.size, 2);
  assert.equal(removeCalls, 0);
  await assert.rejects(remove(), /release failed/);
  assert.equal(releaseCalls, 2);
  assert.equal(openTabs.size, 2);
  assert.equal(removeCalls, 0);
  mayRelease = true;
  await remove();
  assert.equal(releaseCalls, 4);
  assert.equal(openTabs.size, 0);
  assert.equal(removeCalls, 1);
});

test("后续 tab 释放失败也不关闭已释放的 tab，服务缺失同样拒绝", async () => {
  const events: string[] = [];
  const close = () =>
    closeWorkspaceTabsBeforeRemoval({
      tabs,
      resolveTaskService: (tab) => {
        events.push(`resolve:${tab.tabId}`);
        return {
          async releaseWorkspacePreparation() {
            events.push(`release:${tab.tabId}`);
            if (tab.tabId === "child") throw new Error("child failed");
          },
        };
      },
      closeTab: (id) => {
        events.push(`close:${id}`);
      },
      unavailableMessage: "unavailable",
    });
  await assert.rejects(close(), /child failed/);
  assert.deepEqual(events, ["resolve:tree", "resolve:child", "release:tree", "release:child"]);
  await assert.rejects(
    closeWorkspaceTabsBeforeRemoval({
      tabs,
      resolveTaskService: () => null,
      closeTab: () => {
        assert.fail("must not close a tab with no release service");
      },
      unavailableMessage: "unavailable",
    }),
    /unavailable/,
  );
});

test("全部服务在关闭前解析，全部释放完成后才开始关闭", async () => {
  const events: string[] = [];
  await closeWorkspaceTabsBeforeRemoval({
    tabs,
    resolveTaskService: (tab) => {
      events.push(`resolve:${tab.tabId}`);
      return {
        async releaseWorkspacePreparation(params) {
          assert.equal(params.workspacePath, tab.workspacePath);
          assert.equal(params.workspaceIdentity, tab.workspaceIdentity ?? undefined);
          events.push(`release:${tab.tabId}`);
        },
      };
    },
    closeTab: (id) => {
      events.push(`close:${id}`);
    },
    unavailableMessage: "unavailable",
  });
  assert.deepEqual(events, [
    "resolve:tree",
    "resolve:child",
    "release:tree",
    "release:child",
    "close:tree",
    "close:child",
  ]);
});

test("释放等待完成并透传错误，空 tab 清单不触发任何副作用", async () => {
  let resolveRelease: () => void = () => {};
  const pendingRelease = new Promise<void>((resolve) => {
    resolveRelease = resolve;
  });
  let completed = false;
  const pending = releaseWorkspaceRuntimeBeforeRemoval({
    tab: { workspacePath: "/repo/tree", workspaceIdentity: " remote:tree " },
    codezTaskService: {
      async releaseWorkspacePreparation(params) {
        assert.equal(params.workspaceIdentity, "remote:tree");
        await pendingRelease;
      },
    },
  }).then(() => {
    completed = true;
  });
  await Promise.resolve();
  assert.equal(completed, false);
  resolveRelease();
  await pending;
  assert.equal(completed, true);
  await assert.rejects(
    releaseWorkspaceRuntimeBeforeRemoval({
      tab: { workspacePath: "/repo/tree" },
      codezTaskService: {
        async releaseWorkspacePreparation() {
          throw new Error("failed");
        },
      },
    }),
    /failed/,
  );
  await closeWorkspaceTabsBeforeRemoval({
    tabs: [],
    resolveTaskService: () => {
      assert.fail("empty list");
    },
    closeTab: () => {
      assert.fail("empty list");
    },
    unavailableMessage: "unavailable",
  });
});
