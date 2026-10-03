import assert from "node:assert/strict";
import test from "node:test";
import { INITIAL_PANE_LAYOUT, openSessionInNewPane } from "./paneLayoutStore.js";
import { resolveWorkbenchNewTaskTarget } from "./workbenchNewTaskTarget.js";

test("普通新建继续使用当前 linked worktree，不回到仓库主目录", () => {
  assert.deepEqual(
    resolveWorkbenchNewTaskTarget({
      activeWorkspacePath: "/repo-worktrees/feature",
      activeGroup: null,
      paneLayout: INITIAL_PANE_LAYOUT,
    }),
    { workspacePath: "/repo-worktrees/feature" },
  );
});

test("普通新建保留远端身份与既有分屏焦点解析", () => {
  const scope = {
    workspacePath: "/repo",
    workspaceIdentity: "remote:ssh:other:22:user:/repo",
  };
  const paneLayout = openSessionInNewPane(INITIAL_PANE_LAYOUT, scope, "session");
  assert.deepEqual(
    resolveWorkbenchNewTaskTarget({
      activeWorkspacePath: "/local",
      activeGroup: null,
      paneLayout,
    }),
    scope,
  );
  assert.deepEqual(
    resolveWorkbenchNewTaskTarget({
      activeWorkspacePath: scope.workspacePath,
      activeWorkspaceIdentity: scope.workspaceIdentity,
      activeGroup: null,
      paneLayout: INITIAL_PANE_LAYOUT,
    }),
    scope,
  );
});

test("没有当前工作区时，不因工作树功能猜测默认目录", () => {
  assert.equal(
    resolveWorkbenchNewTaskTarget({
      activeWorkspacePath: null,
      activeGroup: null,
      paneLayout: INITIAL_PANE_LAYOUT,
    }),
    null,
  );
});
