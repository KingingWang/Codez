import assert from "node:assert/strict";
import test from "node:test";
import {
  buildWorktreeRemovalGuardKey,
  useWorktreeRemovalGuardStore,
} from "@/store/worktreeRemovalGuardStore.js";
import { admitRootWorkspaceSelection } from "./rootWorkspaceSelectionAdmission.js";

const REMOVAL_MESSAGE = "worktree removal in flight";

function resetRemovalGuard() {
  useWorktreeRemovalGuardStore.setState({ targets: {} });
}

test("打开 IPC 返回前进入删除窗口时，晚到打开被拒绝且不提交本窗口 UI", async () => {
  resetRemovalGuard();
  let resolveActivation!: (result: { activated: boolean }) => void;
  const activationCalls: string[] = [];
  const committedPaths: string[] = [];
  const operation = admitRootWorkspaceSelection({
    path: "/repo/worktrees/feature",
    removalMessage: REMOVAL_MESSAGE,
    activateOrSetWorkspace: (path) => {
      activationCalls.push(path);
      return new Promise((resolve) => {
        resolveActivation = resolve;
      });
    },
    commit: (path) => {
      committedPaths.push(path);
    },
  });

  await Promise.resolve();
  assert.deepEqual(activationCalls, ["/repo/worktrees/feature"]);
  assert.deepEqual(committedPaths, []);

  useWorktreeRemovalGuardStore
    .getState()
    .markDeleting(buildWorktreeRemovalGuardKey("local", "/repo/worktrees/feature"));
  resolveActivation({ activated: false });

  assert.deepEqual(await operation, { status: "rejected", message: REMOVAL_MESSAGE });
  assert.deepEqual(committedPaths, []);
});

test("入口已处于删除窗口时不发起平台打开，也不提交本窗口 UI", async () => {
  resetRemovalGuard();
  useWorktreeRemovalGuardStore
    .getState()
    .markDeleting(buildWorktreeRemovalGuardKey("local", "/repo/worktrees/feature"));
  const activationCalls: string[] = [];
  const committedPaths: string[] = [];

  assert.deepEqual(
    await admitRootWorkspaceSelection({
      path: "/repo/worktrees/feature/src",
      removalMessage: REMOVAL_MESSAGE,
      activateOrSetWorkspace: (path) => {
        activationCalls.push(path);
        return Promise.resolve({ activated: false });
      },
      commit: (path) => {
        committedPaths.push(path);
      },
    }),
    { status: "rejected", message: REMOVAL_MESSAGE },
  );
  assert.deepEqual(activationCalls, []);
  assert.deepEqual(committedPaths, []);
});

test("正常打开提交一次 tab/草稿；activated=true 保持既有路由且无本地提交", async () => {
  resetRemovalGuard();
  for (const activated of [false, true]) {
    const activationCalls: string[] = [];
    const committedPaths: string[] = [];
    assert.deepEqual(
      await admitRootWorkspaceSelection({
        path: "/repo/worktrees/feature",
        removalMessage: REMOVAL_MESSAGE,
        activateOrSetWorkspace: (path) => {
          activationCalls.push(path);
          return Promise.resolve({ activated });
        },
        commit: (path) => {
          committedPaths.push(path);
        },
      }),
      activated ? { status: "activated" } : { status: "committed" },
    );
    assert.deepEqual(activationCalls, ["/repo/worktrees/feature"]);
    assert.deepEqual(committedPaths, activated ? [] : ["/repo/worktrees/feature"]);
  }
});
