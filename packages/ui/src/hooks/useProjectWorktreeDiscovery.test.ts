import assert from "node:assert/strict";
import test from "node:test";
import type { GitWorktreeEntry } from "@codez/shared";
import type { IGitService } from "@codez/services";
import type { WorkspaceTabState } from "@/store/tabStore.js";
import { fetchProjectWorktreeFacts } from "./useProjectWorktreeDiscovery.js";

// 评审 M3 的回归锁：发现链路只读已连接服务、按项目去重查询、失败降级不抛错、
// 身份不足/未连接的 tab 不查询。spec 阶段一验收 2（发现不激活）的数据层证明：
// 本函数没有也不接触任何注册/连接/挂载 API，副作用面由签名封死。

function fakeTab(
  overrides: Partial<WorkspaceTabState> & { workspacePath: string },
): WorkspaceTabState {
  return {
    kind: "workspace",
    id: overrides.workspacePath,
    ...overrides,
  } as WorkspaceTabState;
}

function fakeGitService(impl: {
  commonDir?: string | null;
  worktrees?: GitWorktreeEntry[];
  failRepoInfo?: boolean;
  omitListWorktrees?: boolean;
  calls?: string[];
}): IGitService {
  const calls = impl.calls ?? [];
  const service: Partial<IGitService> = {
    async getWorkspaceRepositoryInfo() {
      calls.push("getWorkspaceRepositoryInfo");
      if (impl.failRepoInfo) {
        throw new Error("rpc method not found");
      }
      return {
        workspacePath: "/x",
        kind: "main-tree",
        isGitAvailable: true,
        gitCommonDir: impl.commonDir ?? null,
      };
    },
  };
  if (!impl.omitListWorktrees) {
    service.listWorktrees = async () => {
      calls.push("listWorktrees");
      return {
        workspacePath: "/x",
        isGitAvailable: true,
        isRepository: true,
        worktrees: impl.worktrees ?? [],
      };
    };
  }
  return service as IGitService;
}

test("同项目两个 tab 只触发一次 worktree 列举（按项目去重查询）", async () => {
  const calls: string[] = [];
  const service = fakeGitService({
    commonDir: "/repo/.git",
    worktrees: [
      {
        path: "/repo",
        isMain: true,
        branchName: "main",
        headCommitHash: "abc",
        isDetached: false,
        isLocked: false,
        lockReason: null,
        isPrunable: false,
        prunableReason: null,
      },
    ],
    calls,
  });
  const tabs = [fakeTab({ workspacePath: "/repo" }), fakeTab({ workspacePath: "/repo-wt" })];
  const result = await fetchProjectWorktreeFacts({
    tabs,
    resolveGitService: () => service,
  });
  assert.equal(calls.filter((c) => c === "getWorkspaceRepositoryInfo").length, 2);
  assert.equal(calls.filter((c) => c === "listWorktrees").length, 1);
  assert.equal(Object.keys(result.treesByProjectKey).length, 1);
});

test("resolver 返回 null 的 tab（remote-waiting/身份不足）不发起任何查询", async () => {
  const calls: string[] = [];
  const service = fakeGitService({ commonDir: "/repo/.git", calls });
  const connected = fakeTab({ workspacePath: "/repo" });
  const waiting = fakeTab({ workspacePath: "/remote/repo", remoteSessionId: "s-1" });
  const result = await fetchProjectWorktreeFacts({
    tabs: [connected, waiting],
    resolveGitService: (tab) => (tab === waiting ? null : service),
  });
  assert.equal(result.factsByWorkspaceKey["/remote/repo"], null);
  // 只有已连接的 tab 被查询
  assert.equal(calls.filter((c) => c === "getWorkspaceRepositoryInfo").length, 1);
});

test("旧远端缺 listWorktrees 方法：降级为空发现且不抛错", async () => {
  const calls: string[] = [];
  const legacyService = fakeGitService({
    commonDir: "/repo/.git",
    omitListWorktrees: true,
    calls,
  });
  const downgrades: string[] = [];
  const result = await fetchProjectWorktreeFacts({
    tabs: [fakeTab({ workspacePath: "/repo" })],
    resolveGitService: () => legacyService,
    onDowngrade: (kind) => downgrades.push(kind),
  });
  assert.deepEqual(result.treesByProjectKey, {});
  assert.ok(downgrades.includes("worktree-list"));
  // 分组事实仍可用（commonDir 拿到了），只是没有树列表
  assert.equal(result.factsByWorkspaceKey["/repo"], "/repo/.git");
});

test("repo-info 查询失败（非 Git/旧远端）：不合组、不报错", async () => {
  const failing = fakeGitService({ failRepoInfo: true });
  const result = await fetchProjectWorktreeFacts({
    tabs: [fakeTab({ workspacePath: "/not-a-repo" })],
    resolveGitService: () => failing,
  });
  assert.equal(result.factsByWorkspaceKey["/not-a-repo"], null);
  assert.deepEqual(result.treesByProjectKey, {});
});

test("effect 取消后不再写台账结果", async () => {
  const service = fakeGitService({ commonDir: "/repo/.git" });
  const result = await fetchProjectWorktreeFacts({
    tabs: [fakeTab({ workspacePath: "/repo" })],
    resolveGitService: () => service,
    isCancelled: () => true,
  });
  assert.deepEqual(result.treesByProjectKey, {});
});
