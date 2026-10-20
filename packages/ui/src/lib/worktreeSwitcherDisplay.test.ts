import assert from "node:assert/strict";
import test from "node:test";
import type { WorktreeDiscoveryEntry } from "@/lib/projectGrouping.js";
import {
  isWorkspaceInsideTree,
  resolveWorktreeDirName,
  resolveWorktreeSwitcherAction,
  shouldShowWorktreeSwitcher,
} from "@/lib/worktreeSwitcherDisplay.js";

function fakeEntry(overrides: Partial<WorktreeDiscoveryEntry>): WorktreeDiscoveryEntry {
  return {
    path: "/repo-wt",
    branchName: "feature",
    headCommitHash: "abc",
    isMain: false,
    isDetached: false,
    isLocked: false,
    lockReason: null,
    isPrunable: false,
    prunableReason: null,
    isOpen: false,
    ...overrides,
  };
}

test("目录名取路径最后一段；根路径原样返回", () => {
  assert.equal(resolveWorktreeDirName("/home/dev/repo-wt"), "repo-wt");
  assert.equal(resolveWorktreeDirName("/repo-wt feature"), "repo-wt feature");
  assert.equal(resolveWorktreeDirName("/"), "/");
  assert.equal(resolveWorktreeDirName("C:/"), "C:");
  assert.equal(resolveWorktreeDirName("C:/work/repo"), "repo");
});

test("子目录判定：树根本身与树内路径都算在树内", () => {
  assert.equal(isWorkspaceInsideTree("/repo/sub", "/repo"), true);
  assert.equal(isWorkspaceInsideTree("/repo", "/repo"), true);
  assert.equal(isWorkspaceInsideTree("/repo-other", "/repo"), false);
  assert.equal(isWorkspaceInsideTree("/repo", "/repo/sub"), false);
});

test("已打开 → activate（不受 Web 远控限制）", () => {
  assert.equal(
    resolveWorktreeSwitcherAction({
      entry: fakeEntry({ isOpen: true }),
      currentWorkspacePath: "/elsewhere",
      allowOpenWorkspace: false,
    }),
    "activate",
  );
});

test("Web 远控下未打开 → disabled", () => {
  assert.equal(
    resolveWorktreeSwitcherAction({
      entry: fakeEntry({}),
      currentWorkspacePath: "/elsewhere",
      allowOpenWorkspace: false,
    }),
    "disabled",
  );
});

test("当前工作区是该树子目录 → open-root（验收 10：打开仓库根目录）", () => {
  assert.equal(
    resolveWorktreeSwitcherAction({
      entry: fakeEntry({ path: "/repo" }),
      currentWorkspacePath: "/repo/packages/ui",
      allowOpenWorkspace: true,
    }),
    "open-root",
  );
});

test("当前工作区就是树根且未标记打开（本窗口无 tab）→ open，不是 open-root", () => {
  assert.equal(
    resolveWorktreeSwitcherAction({
      entry: fakeEntry({ path: "/repo" }),
      currentWorkspacePath: "/repo",
      allowOpenWorkspace: true,
    }),
    "open",
  );
});

test("其余未打开 → open", () => {
  assert.equal(
    resolveWorktreeSwitcherAction({
      entry: fakeEntry({ path: "/repo-wt" }),
      currentWorkspacePath: "/repo",
      allowOpenWorkspace: true,
    }),
    "open",
  );
});

test("R2：登记工作树达到两个才显示切换器", () => {
  assert.equal(shouldShowWorktreeSwitcher([fakeEntry({})]), false);
  assert.equal(
    shouldShowWorktreeSwitcher([fakeEntry({ path: "/a" }), fakeEntry({ path: "/b" })]),
    true,
  );
});
