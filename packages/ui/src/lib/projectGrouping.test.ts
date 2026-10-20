import assert from "node:assert/strict";
import test from "node:test";
import type { GitWorktreeEntry } from "@codez/shared";
import {
  buildProjectGroupKey,
  deriveProjectGroups,
  deriveWorktreeDiscoveryEntries,
  normalizeWorkspacePathForComparison,
  resolveWorkspaceSourceScope,
} from "./projectGrouping.js";

const sshTarget = { kind: "ssh", host: "example.com", port: 22, username: "dev" } as const;

function tree(path: string, overrides: Partial<GitWorktreeEntry> = {}): GitWorktreeEntry {
  return {
    path,
    isMain: false,
    branchName: null,
    headCommitHash: null,
    isDetached: false,
    isLocked: false,
    lockReason: null,
    isPrunable: false,
    prunableReason: null,
    ...overrides,
  };
}

test("本地同仓库多棵工作树归为一组", () => {
  const groups = deriveProjectGroups([
    { source: { workspacePath: "/repo" }, gitCommonDir: "/repo/.git" },
    { source: { workspacePath: "/repo-wt/feature" }, gitCommonDir: "/repo/.git" },
  ]);
  assert.equal(groups.length, 1);
  assert.equal(groups[0]!.members.length, 2);
  assert.equal(groups[0]!.scope, "local");
});

test("同路径不同远端不合组；同远端重连（remoteSessionId 变化）不换组", () => {
  const groups = deriveProjectGroups([
    {
      source: { workspacePath: "/repo", remoteTarget: sshTarget, remoteSessionId: "s1" },
      gitCommonDir: "/repo/.git",
    },
    {
      source: {
        workspacePath: "/repo",
        remoteTarget: { kind: "ssh", host: "other.example.com", port: 22, username: "dev" },
        remoteSessionId: "s2",
      },
      gitCommonDir: "/repo/.git",
    },
    {
      source: { workspacePath: "/repo-wt", remoteTarget: sshTarget, remoteSessionId: "s3" },
      gitCommonDir: "/repo/.git",
    },
  ]);
  assert.equal(groups.length, 2);
  const sameRemote = groups.find((group) => group.scope.includes("example.com:"));
  assert.equal(sameRemote?.members.length, 2);
});

test("只有 identity 的存量 tab 也能合组；身份不足不合组", () => {
  const identity = "remote:ssh:example.com:22:dev:/repo";
  const groups = deriveProjectGroups([
    { source: { workspacePath: "/repo", workspaceIdentity: identity }, gitCommonDir: "/repo/.git" },
    {
      source: { workspacePath: "/repo-wt", remoteTarget: sshTarget, remoteSessionId: "s9" },
      gitCommonDir: "/repo/.git",
    },
  ]);
  assert.equal(groups.length, 1);

  // 有远程会话痕迹但既无 target 又无 identity：不猜测合组。
  const orphan = deriveProjectGroups([
    { source: { workspacePath: "/repo", remoteSessionId: "s-x" }, gitCommonDir: "/repo/.git" },
  ]);
  assert.equal(orphan.length, 0);

  // identity 非法：解析失败，不合组。
  const invalid = deriveProjectGroups([
    {
      source: { workspacePath: "/repo", workspaceIdentity: "remote:bogus" },
      gitCommonDir: "/repo/.git",
    },
  ]);
  assert.equal(invalid.length, 0);
});

test("common dir 缺失（旧服务/非 Git/查询失败）不合组", () => {
  const groups = deriveProjectGroups([
    { source: { workspacePath: "/repo" }, gitCommonDir: null },
    { source: { workspacePath: "/other" } },
    { source: { workspacePath: "/plain" }, gitCommonDir: "" },
  ]);
  assert.equal(groups.length, 0);
});

test("发现条目按树根去重并标注 isOpen；子目录 tab 不算打开树根", () => {
  const worktrees = [
    tree("/repo/", { isMain: true, branchName: "main" }),
    tree("/repo-wt/feature", { branchName: "feature" }),
    tree("/repo-wt/feature", { branchName: "feature" }),
  ];
  const entries = deriveWorktreeDiscoveryEntries({
    worktrees,
    openWorkspacePaths: ["/repo", "/repo-wt/feature/src"],
  });
  assert.equal(entries.length, 2);
  const root = entries.find((entry) => entry.path === "/repo");
  const feature = entries.find((entry) => entry.path === "/repo-wt/feature");
  assert.equal(root?.isOpen, true);
  assert.equal(feature?.isOpen, false, "只打开了子目录，树根不得标记为已打开");
});

test("Windows 风格路径比较归一", () => {
  assert.equal(normalizeWorkspacePathForComparison("C:\\repo\\"), "C:/repo");
  const entries = deriveWorktreeDiscoveryEntries({
    worktrees: [tree("C:/repo")],
    openWorkspacePaths: ["C:\\repo"],
  });
  assert.equal(entries[0]?.isOpen, true);
});

test("分组 key 稳定且与成员顺序无关", () => {
  const key = buildProjectGroupKey("local", "/repo/.git/");
  assert.equal(key, buildProjectGroupKey("local", "/repo/.git"));
  assert.equal(resolveWorkspaceSourceScope({ workspacePath: "/x" }), "local");
});
