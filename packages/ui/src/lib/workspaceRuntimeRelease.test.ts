import assert from "node:assert/strict";
import test from "node:test";
import {
  closeWorkspaceTabsBeforeRemoval,
  quarantineWorkspaceRemovalTargets,
  releaseWorkspaceRemovalHolds,
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

test("W5a 隔离先于释放，删除结束后成对解除（Windows respawn 竞态回归）", async () => {
  const events: string[] = [];
  const service = {
    async quarantineWorkspaceForRemoval(params: { workspacePath: string }) {
      events.push(`quarantine:${params.workspacePath}`);
    },
    async releaseWorkspacePreparation(params: { workspacePath: string }) {
      events.push(`release:${params.workspacePath}`);
    },
    async releaseWorkspaceRemovalHold(params: { workspacePath: string }) {
      events.push(`unhold:${params.workspacePath}`);
    },
  };
  const targets = [
    { workspacePath: "/repo/tree", workspaceIdentity: null, codezTaskService: service },
    {
      workspacePath: "/repo/tree/child",
      workspaceIdentity: "remote:child",
      codezTaskService: service,
    },
  ];
  await quarantineWorkspaceRemovalTargets(targets);
  await Promise.all(
    targets.map((target) =>
      releaseWorkspaceRuntimeBeforeRemoval({
        tab: {
          workspacePath: target.workspacePath,
          workspaceIdentity: target.workspaceIdentity ?? undefined,
        },
        codezTaskService: service,
      }),
    ),
  );
  await releaseWorkspaceRemovalHolds(targets);
  assert.deepEqual(events, [
    "quarantine:/repo/tree",
    "quarantine:/repo/tree/child",
    "release:/repo/tree",
    "release:/repo/tree/child",
    "unhold:/repo/tree",
    "unhold:/repo/tree/child",
  ]);
});

test("W5a 隔离失败立即中止；解除隔离单个失败不影响其余且不抛出", async () => {
  let quarantineCalls = 0;
  const unholds: string[] = [];
  const failing = {
    async quarantineWorkspaceForRemoval() {
      quarantineCalls += 1;
      throw new Error("quarantine failed");
    },
    async releaseWorkspacePreparation() {},
    async releaseWorkspaceRemovalHold(params: { workspacePath: string }) {
      unholds.push(params.workspacePath);
      throw new Error("unhold failed");
    },
  };
  const ok = {
    async quarantineWorkspaceForRemoval() {
      quarantineCalls += 1;
    },
    async releaseWorkspacePreparation() {},
    async releaseWorkspaceRemovalHold(params: { workspacePath: string }) {
      unholds.push(params.workspacePath);
    },
  };
  await assert.rejects(
    quarantineWorkspaceRemovalTargets([
      { workspacePath: "/repo/a", workspaceIdentity: null, codezTaskService: failing },
      { workspacePath: "/repo/b", workspaceIdentity: null, codezTaskService: ok },
    ]),
    /quarantine failed/,
  );
  assert.equal(quarantineCalls, 2);
  // 解除对未隔离/已隔离目标都是安全的：全部调用且不抛出（best-effort）。
  await releaseWorkspaceRemovalHolds([
    { workspacePath: "/repo/a", workspaceIdentity: null, codezTaskService: failing },
    { workspacePath: "/repo/b", workspaceIdentity: null, codezTaskService: ok },
  ]);
  assert.deepEqual(unholds.sort(), ["/repo/a", "/repo/b"]);
});
