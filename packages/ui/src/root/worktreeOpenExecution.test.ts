import assert from "node:assert/strict";
import test from "node:test";
import { executeWorktreeOpenRoute } from "./worktreeOpenExecution.js";

test("切回只激活；只有明确新建会话才重置到草稿", async () => {
  const calls: string[] = [];
  const actions = {
    activate: (id: string) => {
      calls.push(`activate:${id}`);
    },
    startDraft: (id: string) => {
      calls.push(`draft:${id}`);
    },
    openLocal: async () => {
      calls.push("local");
    },
    openRemote: async () => {
      calls.push("remote");
    },
  };
  await executeWorktreeOpenRoute({
    route: { kind: "activate", tabId: "tree" },
    actions,
    inflight: new Map(),
  });
  assert.deepEqual(calls, ["activate:tree"]);
  await executeWorktreeOpenRoute({
    route: { kind: "activate", tabId: "tree" },
    intent: "new-session",
    actions,
    inflight: new Map(),
  });
  assert.deepEqual(calls, ["activate:tree", "activate:tree", "draft:tree"]);
});

test("重复打开共享同一在途操作，失败向创建表单传播且允许仅重试打开", async () => {
  const inflight = new Map<string, Promise<void>>();
  let calls = 0;
  let reject!: (error: Error) => void;
  const actions = {
    activate: () => {},
    startDraft: () => {},
    openLocal: () => {
      calls++;
      return new Promise<void>((_resolve, fail) => {
        reject = fail;
      });
    },
    openRemote: async () => {},
  };
  const params = {
    route: { kind: "open-local" as const, workspacePath: "/new tree" },
    actions,
    inflight,
  };
  const first = executeWorktreeOpenRoute(params);
  const second = executeWorktreeOpenRoute(params);
  // admission 在 microtask 中执行，先让命令进入在途。
  await Promise.resolve();
  assert.equal(calls, 1);
  reject(new Error("open failed"));
  await assert.rejects(first, /open failed/);
  await assert.rejects(second, /open failed/);
  assert.equal(inflight.size, 0);
  await executeWorktreeOpenRoute({
    ...params,
    actions: {
      ...actions,
      openLocal: async () => {
        calls++;
      },
    },
  });
  assert.equal(calls, 2);
});

test("能力不足不运行任何写入；远端打开使用目标自己的身份与锚点", async () => {
  const calls: unknown[] = [];
  const actions = {
    activate: () => {
      throw new Error("unexpected");
    },
    startDraft: () => {
      throw new Error("unexpected");
    },
    openLocal: async () => {
      throw new Error("unexpected");
    },
    openRemote: async (route: unknown) => {
      calls.push(route);
    },
  };
  await assert.rejects(
    executeWorktreeOpenRoute({
      route: { kind: "unsupported", reason: "allow-open-disabled" },
      actions,
      inflight: new Map(),
    }),
    /unsupported/,
  );
  const route = {
    kind: "open-remote" as const,
    workspacePath: "/repo-tree",
    workspaceIdentity: "remote:ssh:host:22:user:/repo-tree",
    remoteTarget: { kind: "ssh" as const, host: "host", username: "user" },
    anchorWorkspaceKey: "remote:ssh:host:22:user:/repo",
  };
  await executeWorktreeOpenRoute({ route, actions, inflight: new Map() });
  assert.deepEqual(calls, [route]);
});
