import assert from "node:assert/strict";
import { access } from "node:fs/promises";
import { join } from "node:path";

export async function verifyEmptySessionWorktreeCreation(page) {
  const moduleUrl = `/@fs${join(process.cwd(), "packages/ui/src/store/remoteWorkspaceSessionStore.ts")}`;
  const session = await page.evaluate(async (url) => {
    const { useRemoteWorkspaceSessionStore } = await import(url);
    const services = useRemoteWorkspaceSessionStore.getState().baseServices;
    const workspacePath = window.__codezTabStoreE2E.getState().activeWorkspacePath;
    const task = await services.codezTaskService.createTask({ workspacePath, v4Create: true });
    const store = window.__codezSessionStoreE2E.getState();
    store.upsertOptimisticTaskListItem(workspacePath, task);
    store.setActiveTaskId(workspacePath, task.taskId);
    return { workspacePath, taskId: task.taskId };
  }, moduleUrl);
  await page.getByRole("button", { name: "展开状态", exact: true }).click();
  await page.getByTestId("chat-summary-panel").waitFor();
  await page.getByRole("button", { name: "切换 Git 分支", exact: true }).click();
  await page.getByRole("button", { name: "新建独立工作区（工作树）…", exact: true }).click();
  await page.getByLabel("新分支名", { exact: true }).waitFor();
  await page.getByRole("button", { name: "取消", exact: true }).click();
  await page.getByRole("dialog").waitFor({ state: "hidden" });
  const after = await page.evaluate(
    (path) => ({
      workspacePath: window.__codezTabStoreE2E.getState().activeWorkspacePath,
      taskId: window.__codezSessionStoreE2E.getState().getWorkspaceState(path).activeTaskId,
    }),
    session.workspacePath,
  );
  assert.deepEqual(after, session);
}

/** 在隔离桌面实例中验证实际 hook 的释放失败/重试时序，不启动模型回合。 */
export async function verifyWorktreeRemovalReleaseRetries({ page, dialog, confirm, targetPath }) {
  const registryUrl = `/@fs${join(process.cwd(), "packages/ui/src/store/remoteWorkspaceSessionStore.ts")}`;
  await page.evaluate(
    async ({ url, targetPath }) => {
      const registry = await import(url);
      const original = registry.getRegisteredBaseWorkspaceServices();
      const record = {
        failRelease: true,
        releaseCalls: 0,
        removeCalls: 0,
        restore: () => registry.registerBaseWorkspaceServices(original),
      };
      const taskService = new Proxy(original.codezTaskService, {
        get(service, key) {
          if (key === "releaseWorkspacePreparation") {
            return async (request) => {
              if (request.workspacePath === targetPath) {
                record.releaseCalls += 1;
                if (record.failRelease) throw new Error("qa release failure");
              }
              return service.releaseWorkspacePreparation(request);
            };
          }
          return Reflect.get(service, key, service);
        },
      });
      const gitService = new Proxy(original.gitService, {
        get(service, key) {
          if (key === "removeWorktree") {
            return async (request) => {
              if (request.targetPath === targetPath) record.removeCalls += 1;
              return service.removeWorktree(request);
            };
          }
          return Reflect.get(service, key, service);
        },
      });
      registry.registerBaseWorkspaceServices(
        new Proxy(original, {
          get(services, key) {
            if (key === "codezTaskService") return taskService;
            if (key === "gitService") return gitService;
            return Reflect.get(services, key, services);
          },
        }),
      );
      window.__worktreeRemovalReleaseQA = record;
    },
    { url: registryUrl, targetPath },
  );
  try {
    const assertFailedRelease = async (expectedCalls) => {
      await dialog.getByText(/qa release failure/).waitFor();
      const facts = await page.evaluate(
        (path) => ({
          tabRetained: window.__codezTabStoreE2E
            .getState()
            .tabs.some((tab) => tab.workspacePath === path),
          releaseCalls: window.__worktreeRemovalReleaseQA.releaseCalls,
          removeCalls: window.__worktreeRemovalReleaseQA.removeCalls,
        }),
        targetPath,
      );
      assert.deepEqual(facts, {
        tabRetained: true,
        releaseCalls: expectedCalls,
        removeCalls: 0,
      });
      await access(targetPath);
    };
    await confirm.click();
    await assertFailedRelease(1);
    await dialog.getByRole("button", { name: "重试", exact: true }).click();
    await confirm.click();
    await assertFailedRelease(2);
    await page.evaluate(() => {
      window.__worktreeRemovalReleaseQA.failRelease = false;
    });
    await dialog.getByRole("button", { name: "重试", exact: true }).click();
    await confirm.click();
    await dialog.waitFor({ state: "hidden" });
    assert.deepEqual(
      await page.evaluate(() => ({
        releaseCalls: window.__worktreeRemovalReleaseQA.releaseCalls,
        removeCalls: window.__worktreeRemovalReleaseQA.removeCalls,
      })),
      // W5a 起成功路径对目标路径有两次释放：先无条件释放树根 runtime（无 tab 也释放，
      // 防止释放期间 UI 恢复重新拉起的 agent 残留），再由 closeTabsForRemoval 释放根 tab。
      { releaseCalls: 4, removeCalls: 1 },
    );
  } finally {
    await page.evaluate(() => {
      window.__worktreeRemovalReleaseQA.restore();
      delete window.__worktreeRemovalReleaseQA;
    });
  }
}
