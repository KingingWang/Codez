import assert from "node:assert/strict";
import test from "node:test";
import type { GitWorktreeEntry } from "@codez/shared";
import type { IGitService } from "@codez/services";
import type { WorkspaceTabState } from "@/store/tabStore.js";
import { fetchProjectWorktreeFacts } from "./useProjectWorktreeDiscovery.js";
import { isWorktreeListNulUnsupported } from "./worktreeCreationModel.js";

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
  failListWorktrees?: boolean | { code?: number | string; dataCode?: string };
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
      if (impl.failListWorktrees) {
        const spec = typeof impl.failListWorktrees === "object" ? impl.failListWorktrees : null;
        // 能力码有两种到达形态（specs/git-worktree-projects.md R15a）：本机 Host 直接抛
        // services 本地 typed error（顶层 code 是字符串）；远端 RPC 外层 code 是数字，
        // 能力原因保留在 data.code。两种都必须被识别成永久 unsupported。
        const capability = Boolean(spec?.dataCode) || typeof spec?.code === "string";
        const error = new Error(
          capability
            ? "git worktree list --porcelain -z requires Git 2.36.0 or newer"
            : "connection lost",
        ) as Error & { code?: number | string; data?: { code: string } };
        if (spec?.code !== undefined) error.code = spec.code;
        if (spec?.dataCode) error.data = { code: spec.dataCode };
        throw error;
      }
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
  const waiting = fakeTab({
    workspacePath: "/remote/repo",
    remoteSessionId: "s-1",
  });
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

test("listWorktrees 瞬时失败：项目进入 failedListProjectKeys（不可达 ≠ 已删除）", async () => {
  const failing = fakeGitService({
    commonDir: "/repo/.git",
    failListWorktrees: true,
  });
  const result = await fetchProjectWorktreeFacts({
    tabs: [fakeTab({ workspacePath: "/repo" })],
    resolveGitService: () => failing,
  });
  assert.deepEqual(result.treesByProjectKey, {});
  assert.equal(result.failedListProjectKeys.length, 1);
});

test("listWorktrees 抛 -32601（旧远端不支持）：静默降级，不计入失败列表", async () => {
  const legacy = fakeGitService({
    commonDir: "/repo/.git",
    failListWorktrees: { code: -32601 },
  });
  const result = await fetchProjectWorktreeFacts({
    tabs: [fakeTab({ workspacePath: "/repo" })],
    resolveGitService: () => legacy,
  });
  assert.deepEqual(result.treesByProjectKey, {});
  assert.deepEqual(result.failedListProjectKeys, []);
});

test("Git < 2.36 能力码（本机 Host 顶层 code）：永久 unsupported，不进瞬时失败集合", async () => {
  const calls: string[] = [];
  const oldGit = fakeGitService({
    commonDir: "/repo/.git",
    failListWorktrees: { code: "git_worktree_list_nul_unsupported" },
    calls,
  });
  const downgrades: Array<{ kind: string; key: string }> = [];
  const result = await fetchProjectWorktreeFacts({
    tabs: [fakeTab({ workspacePath: "/repo" })],
    resolveGitService: () => oldGit,
    onDowngrade: (kind, key) => downgrades.push({ kind, key }),
  });

  assert.deepEqual(result.treesByProjectKey, {});
  // 能力缺失不是「暂时不可达」：不得进入重试/状态未知集合，否则旧 Git 主机会永久重试。
  assert.deepEqual(result.failedListProjectKeys, []);
  // 仍上报一次降级事实，UI 有机会呈现「升级 Git」而不是无声消失。
  assert.equal(downgrades.length, 1);
  assert.equal(downgrades[0]?.kind, "worktree-list");
  // 分组事实不受影响：能力缺失只影响树列表，common dir 分组仍可用（普通地板 2.23）。
  assert.equal(result.factsByWorkspaceKey["/repo"], "/repo/.git");
  assert.equal(calls.filter((entry) => entry === "listWorktrees").length, 1);
});

test("Git < 2.36 能力码（远端 RPC 数字 code + data.code）：同样不计入失败列表", async () => {
  const remoteOldGit = fakeGitService({
    commonDir: "/repo/.git",
    failListWorktrees: {
      code: -32603,
      dataCode: "git_worktree_list_nul_unsupported",
    },
  });
  const downgrades: string[] = [];
  const result = await fetchProjectWorktreeFacts({
    tabs: [
      fakeTab({
        workspacePath: "/remote/repo",
        workspaceIdentity: "remote:server:a:/remote/repo",
      }),
    ],
    resolveGitService: () => remoteOldGit,
    onDowngrade: (kind) => downgrades.push(kind),
  });

  assert.deepEqual(result.treesByProjectKey, {});
  assert.deepEqual(result.failedListProjectKeys, []);
  assert.deepEqual(downgrades, ["worktree-list"]);
});

test("能力码分类器：本机顶层 code 与远端 data.code 都识别，且不误判其他 typed 错误", () => {
  const capabilityData = {
    code: "git_worktree_list_nul_unsupported",
    message: "git worktree list --porcelain -z requires Git 2.36.0 or newer",
    minGitVersion: "2.36.0",
    detectedGitVersion: "git version 2.30.0",
  };
  // 本机 Host：services 本地 typed error，顶层 code 就是能力码。
  assert.equal(
    isWorktreeListNulUnsupported(Object.assign(new Error(capabilityData.message), capabilityData)),
    true,
  );
  // 远端 RPC：外层 code 是 JSON-RPC 数字码，能力原因只保留在 data.code
  // （与 worktreeRemovalModel.extractWorktreeRemovalIssue 同一约定）。
  assert.equal(
    isWorktreeListNulUnsupported(
      Object.assign(new Error(capabilityData.message), {
        code: -32603,
        data: capabilityData,
      }),
    ),
    true,
  );
  // 瞬时错误、旧远端方法缺失、以及同一通道上的其他 typed issue 都不能被误判成能力缺失。
  assert.equal(isWorktreeListNulUnsupported(new Error("connection lost")), false);
  assert.equal(
    isWorktreeListNulUnsupported(Object.assign(new Error("x"), { code: -32601 })),
    false,
  );
  assert.equal(
    isWorktreeListNulUnsupported(
      Object.assign(new Error("x"), {
        code: -32603,
        data: { code: "status-changed" },
      }),
    ),
    false,
  );
  // 非对象输入不抛错。
  assert.equal(isWorktreeListNulUnsupported("git_worktree_list_nul_unsupported"), false);
  assert.equal(isWorktreeListNulUnsupported(null), false);
  assert.equal(isWorktreeListNulUnsupported(undefined), false);
});
