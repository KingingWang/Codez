import assert from "node:assert/strict";
import test from "node:test";
import type { RemoteTarget } from "@codez/shared";
import type { WorktreeDiscoveryEntry } from "@/lib/projectGrouping.js";
import type { TabStoreState } from "@/store/tabStore.js";
import { resolveWorktreeOpenRoute, resolveAnchorRemoteTarget } from "./worktreeOpenIntent.js";

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

function fakeTab(overrides: Record<string, unknown>): TabStoreState["tabs"][number] {
  return {
    kind: "workspace",
    id: "tab-1",
    workspacePath: "/repo",
    ...overrides,
  } as TabStoreState["tabs"][number];
}

const sshTarget: RemoteTarget = { kind: "ssh", host: "dev.example.com", username: "dev" };
const sshAnchor = { target: sshTarget, workspaceKey: "remote:ssh:dev.example.com:22:dev:/repo" };

test("已打开的树根：激活既有 tab，不走打开流程", () => {
  const route = resolveWorktreeOpenRoute({
    entry: fakeEntry({ isOpen: true, path: "/repo" }),
    tabs: [fakeTab({ id: "tab-1", workspacePath: "/repo" })],
    allowOpenWorkspace: false, // 即使 Web 远控禁用打开，激活已有 tab 仍然允许
    projectMemberKeys: ["/repo"],
    isRemoteScope: false,
    anchor: null,
  });
  assert.deepEqual(route, { kind: "activate", tabId: "tab-1" });
});

test("isOpen 但本窗口无 tab（其他窗口打开）：按未打开处理", () => {
  const route = resolveWorktreeOpenRoute({
    entry: fakeEntry({ isOpen: true, path: "/repo-wt" }),
    tabs: [fakeTab({ id: "tab-1", workspacePath: "/repo" })],
    allowOpenWorkspace: true,
    projectMemberKeys: ["/repo"],
    isRemoteScope: false,
    anchor: null,
  });
  assert.deepEqual(route, { kind: "open-local", workspacePath: "/repo-wt" });
});

test("未打开的本地树：open-local", () => {
  const route = resolveWorktreeOpenRoute({
    entry: fakeEntry({ path: "/repo-wt feature" }),
    tabs: [fakeTab({})],
    allowOpenWorkspace: true,
    projectMemberKeys: ["/repo"],
    isRemoteScope: false,
    anchor: null,
  });
  assert.deepEqual(route, { kind: "open-local", workspacePath: "/repo-wt feature" });
});

test("Web 远控禁用打开：unsupported 且明确原因", () => {
  const route = resolveWorktreeOpenRoute({
    entry: fakeEntry({}),
    tabs: [fakeTab({})],
    allowOpenWorkspace: false,
    projectMemberKeys: ["/repo"],
    isRemoteScope: false,
    anchor: null,
  });
  assert.deepEqual(route, { kind: "unsupported", reason: "allow-open-disabled" });
});

test("远程项目的树：解析为自己的 target + identity + 锚点 key，不沿用来源树身份", () => {
  const route = resolveWorktreeOpenRoute({
    entry: fakeEntry({ path: "/home/dev/repo-wt" }),
    tabs: [fakeTab({})],
    allowOpenWorkspace: true,
    projectMemberKeys: ["remote:ssh:dev.example.com:22:dev:/home/dev/repo"],
    isRemoteScope: true,
    anchor: sshAnchor,
  });
  assert.equal(route.kind, "open-remote");
  if (route.kind !== "open-remote") return;
  assert.equal(route.workspacePath, "/home/dev/repo-wt");
  assert.equal(route.remoteTarget, sshTarget);
  assert.equal(route.workspaceIdentity, "remote:ssh:dev.example.com:22:dev:/home/dev/repo-wt");
  assert.equal(route.anchorWorkspaceKey, "remote:ssh:dev.example.com:22:dev:/repo");
});

test("远程项目但无成员锚点：拒绝按本地路径打开", () => {
  const route = resolveWorktreeOpenRoute({
    entry: fakeEntry({ path: "/home/dev/repo-wt" }),
    tabs: [fakeTab({})],
    allowOpenWorkspace: true,
    projectMemberKeys: ["remote:ssh:dev.example.com:22:dev:/home/dev/repo"],
    isRemoteScope: true,
    anchor: null,
  });
  assert.deepEqual(route, { kind: "unsupported", reason: "remote-identity-missing" });
});

test("锚点解析：同项目成员中带 remoteTarget 的 tab 作为远程锚点", () => {
  const tabs = [
    fakeTab({ id: "t1", workspacePath: "/repo" }),
    fakeTab({
      id: "t2",
      workspacePath: "/home/dev/repo",
      workspaceIdentity: "remote:ssh:dev.example.com:22:dev:/home/dev/repo",
      remoteTarget: sshTarget,
    }),
  ];
  const anchor = resolveAnchorRemoteTarget({
    tabs,
    projectMemberKeys: ["remote:ssh:dev.example.com:22:dev:/home/dev/repo"],
  });
  assert.deepEqual(anchor, {
    target: sshTarget,
    workspaceKey: "remote:ssh:dev.example.com:22:dev:/home/dev/repo",
  });
});

test("锚点解析：项目成员全是本地 tab 时返回 null", () => {
  const anchor = resolveAnchorRemoteTarget({
    tabs: [fakeTab({ id: "t1", workspacePath: "/repo" })],
    projectMemberKeys: ["/repo"],
  });
  assert.equal(anchor, null);
});

test("激活匹配限定项目成员：同路径的其他作用域 tab 不被误激活", () => {
  // 本地 tab 与远程条目路径字符串相同：裸路径全窗口匹配会错误激活本地 tab。
  const route = resolveWorktreeOpenRoute({
    entry: fakeEntry({ isOpen: true, path: "/repo" }),
    tabs: [fakeTab({ id: "local-tab", workspacePath: "/repo" })],
    allowOpenWorkspace: true,
    projectMemberKeys: ["remote:ssh:dev.example.com:22:dev:/repo"],
    isRemoteScope: true,
    anchor: sshAnchor,
  });
  // 成员内没有匹配 tab → 按未打开处理（远程打开流程按身份去重），而不是激活本地 tab。
  assert.equal(route.kind, "open-remote");
});
