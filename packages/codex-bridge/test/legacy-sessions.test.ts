import { mkdtemp, mkdir, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import test from "node:test";
import {
  codezSessionCloseResultSchema,
  codezSessionStateSnapshotSchema,
  codezSessionListResultSchema,
} from "@codez/shared";
import { handleLegacySession } from "../src/legacy-sessions.js";
import { SELECTION_SIDE_CHAT_THREAD_SOURCE } from "../src/selection-side-chat.js";
import { ThreadStateStore } from "../src/thread-state.js";
import type { CodexRpcPort } from "../src/contract.js";
import { threadFixture } from "./projection-fixtures.test.js";

test("legacy session close matches the strict desktop response contract", async () => {
  const calls: string[] = [];
  const rpc = {
    async request(method: string) {
      calls.push(method);
      return {};
    },
  } as unknown as CodexRpcPort;
  const store = new ThreadStateStore(rpc, "/workspace");
  store.markStarted({ id: "thread", cwd: "/workspace", turns: [] });
  const result = await handleLegacySession(
    "session/close",
    { sessionId: "thread" },
    rpc,
    store,
    "/workspace",
  );
  assert.deepEqual(codezSessionCloseResultSchema.parse(result), { closed: true });
  assert.deepEqual(calls, ["thread/unsubscribe"]);
});

test("remote read/resume/list retain identity consumed by the task-index writer", async () => {
  const thread = threadFixture();
  const cwd = thread.cwd;
  const rpc = {
    async request(method: string) {
      if (method === "config/read") return { config: {} };
      if (method === "model/list") return { data: [], nextCursor: null };
      if (method === "thread/list") return { data: [thread], nextCursor: null };
      throw new Error(`unexpected ${method}`);
    },
  } as unknown as CodexRpcPort;
  const store = new ThreadStateStore(rpc, cwd);
  store.markStarted(thread);
  for (const workspaceIdentity of [
    "remote:ssh:host-a:22:user:/workspace",
    "remote:ssh:host-b:22:user:/workspace",
  ]) {
    const workspace = { workspacePath: cwd, workspaceIdentity };
    for (const method of ["session/read", "session/resume"]) {
      const snapshot = codezSessionStateSnapshotSchema.parse(
        await handleLegacySession(
          method,
          { workspace, sessionId: thread.id },
          rpc,
          store,
          workspaceIdentity,
        ),
      );
      assert.deepEqual(snapshot.session.workspace, {
        ...workspace,
        workspaceKey: workspaceIdentity,
      });
    }
    const listed = codezSessionListResultSchema.parse(
      await handleLegacySession("session/list", { workspace }, rpc, store, workspaceIdentity),
    );
    assert.deepEqual(listed.sessions[0]?.workspace, {
      ...workspace,
      workspaceKey: workspaceIdentity,
    });
  }
  const local = codezSessionStateSnapshotSchema.parse(
    await handleLegacySession("session/read", { sessionId: thread.id }, rpc, store, cwd),
  );
  assert.deepEqual(local.session.workspace, { workspacePath: cwd, workspaceKey: cwd });
});

test("legacy setModel 回包与后续 read 的 current 以线程级设置为准（不回落全局 config）", async () => {
  // 回归：回包 settings 曾整体改用全局 config/read 视图，session/setModel 生效后
  // current 仍停在旧模型，Bot 状态卡与 task index 回填永远不会变。
  const cwd = "/workspace";
  const catalogEntry = (
    model: string,
    isDefault: boolean,
    efforts: readonly string[],
    defaultEffort: string,
  ) => ({
    id: model,
    model,
    displayName: model,
    description: "",
    hidden: false,
    isDefault,
    inputModalities: ["text"],
    defaultReasoningEffort: defaultEffort,
    supportedReasoningEfforts: efforts.map((effort) => ({
      reasoningEffort: effort,
      description: "",
    })),
  });
  const updates: unknown[] = [];
  const rpc = {
    async request(method: string, params: unknown) {
      if (method === "config/read")
        return {
          config: {
            model: "deepseek-v4-flash",
            model_provider: "openai-o",
            model_reasoning_effort: "high",
          },
        };
      if (method === "model/list")
        return {
          data: [
            catalogEntry("deepseek-v4-flash", true, ["high", "max"], "high"),
            catalogEntry("GLM-5.3", false, ["max"], "max"),
          ],
          nextCursor: null,
        };
      if (method === "thread/settings/update") {
        updates.push(params);
        return {};
      }
      throw new Error(`unexpected ${method}`);
    },
  } as unknown as CodexRpcPort;
  const store = new ThreadStateStore(rpc, cwd);
  const thread = threadFixture();
  store.markStarted({
    ...thread,
    model: "deepseek-v4-flash",
    modelProvider: "openai-o",
    reasoningEffort: "high",
  });
  const changed = codezSessionStateSnapshotSchema.parse(
    await handleLegacySession(
      "session/setModel",
      {
        sessionId: thread.id,
        model: {
          providerId: "ollama1",
          modelId: "GLM-5.3",
          options: { reasoningLevel: "max" },
        },
      },
      rpc,
      store,
      cwd,
    ),
  );
  assert.deepEqual(changed.settings.model.current, {
    providerId: "ollama1",
    modelId: "GLM-5.3",
    options: { reasoningLevel: "max" },
  });
  assert.equal(changed.settings.thoughtLevel.current, "max");
  // 档位目录必须与 current 描述同一线程模型，不能是全局 config 模型的档位表。
  assert.deepEqual(
    changed.settings.thoughtLevel.available.map((level) => level.value),
    ["max"],
  );
  assert.deepEqual(updates, [{ threadId: thread.id, model: "GLM-5.3", effort: "max" }]);
  // 后续 read/resume 保持线程级真值；task facade 据此回填 task index。
  for (const method of ["session/read", "session/resume"]) {
    const reread = codezSessionStateSnapshotSchema.parse(
      await handleLegacySession(method, { sessionId: thread.id }, rpc, store, cwd),
    );
    assert.equal(reread.settings.model.current?.modelId, "GLM-5.3");
    assert.equal(reread.settings.model.current?.providerId, "ollama1");
    assert.equal(reread.settings.thoughtLevel.current, "max");
  }
});

test("legacy 线程尚无模型事实时 settings 保持全局 config 视图", async () => {
  const cwd = "/workspace";
  const rpc = {
    async request(method: string) {
      if (method === "config/read")
        return {
          config: {
            model: "deepseek-v4-flash",
            model_provider: "openai-o",
            model_reasoning_effort: "high",
          },
        };
      if (method === "model/list") return { data: [], nextCursor: null };
      throw new Error(`unexpected ${method}`);
    },
  } as unknown as CodexRpcPort;
  const store = new ThreadStateStore(rpc, cwd);
  const thread = threadFixture();
  store.markStarted({ ...thread, model: "", modelProvider: "", reasoningEffort: undefined });
  const snapshot = codezSessionStateSnapshotSchema.parse(
    await handleLegacySession("session/read", { sessionId: thread.id }, rpc, store, cwd),
  );
  assert.deepEqual(snapshot.settings.model.current, {
    providerId: "openai-o",
    modelId: "deepseek-v4-flash",
    options: { reasoningLevel: "high" },
  });
});

test("targeted session/list reads cached or lock-free thread/read metadata without scanning thread/list", async () => {
  const parent = threadFixture();
  const cwd = parent.cwd;
  const calls: Array<{ method: string; params: unknown }> = [];
  const rpc = {
    async request(method: string, params: unknown) {
      calls.push({ method, params });
      if (method === "thread/list" || method === "thread/resume") {
        throw new Error(`targeted session/list must not call ${method}`);
      }
      if (method === "thread/read") {
        const id = (params as { threadId: string }).threadId;
        if (id === "cold-child") {
          return {
            thread: {
              ...parent,
              id: "cold-child",
              parentThreadId: parent.id,
              cwd: "/isolated/worktree",
              turns: [],
            },
          };
        }
        if (id === "foreign-thread") {
          return {
            thread: {
              ...parent,
              id: "foreign-thread",
              cwd: "/other/workspace",
              turns: [],
            },
          };
        }
        throw new Error("not found");
      }
      throw new Error(`unexpected ${method}`);
    },
  } as unknown as CodexRpcPort;
  const store = new ThreadStateStore(rpc, cwd);
  store.markStarted(parent);

  const workspaceIdentity = "remote:server:host-1:/workspace";
  const workspace = { workspacePath: cwd, workspaceIdentity, workspaceKey: workspaceIdentity };

  // 1. Cached thread resolves with zero native RPCs
  const cachedResult = codezSessionListResultSchema.parse(
    await handleLegacySession(
      "session/list",
      { workspace, sessionIds: [parent.id] },
      rpc,
      store,
      workspaceIdentity,
    ),
  );
  assert.equal(calls.length, 0);
  assert.equal(cachedResult.sessions.length, 1);
  assert.equal(cachedResult.sessions[0]?.sessionId, parent.id);
  assert.equal(cachedResult.sessions[0]?.sessionKind, "interactive");

  // 2. Unloaded subagent child in isolated worktree resolves via lock-free thread/read and parent ownership
  const childResult = codezSessionListResultSchema.parse(
    await handleLegacySession(
      "session/list",
      { workspace, sessionIds: ["cold-child", "foreign-thread", "missing-thread"] },
      rpc,
      store,
      workspaceIdentity,
    ),
  );
  assert.equal(childResult.sessions.length, 1);
  assert.equal(childResult.sessions[0]?.sessionId, "cold-child");
  assert.equal(childResult.sessions[0]?.sessionKind, "subagent_child");
  assert.equal(childResult.sessions[0]?.parentSessionId, parent.id);
  assert.deepEqual(childResult.sessions[0]?.workspace, workspace);
});

test("session/list hides selection_side_chat in full listing but returns it for targeted sessionIds lineage lookup", async () => {
  const parent = threadFixture();
  const cwd = parent.cwd;
  const sideChat = {
    ...parent,
    id: "side-chat-child",
    forkedFromId: parent.id,
    threadSource: SELECTION_SIDE_CHAT_THREAD_SOURCE,
    turns: [],
  };
  const rpc = {
    async request(method: string) {
      if (method === "thread/list") return { data: [parent, sideChat], nextCursor: null };
      throw new Error(`unexpected ${method}`);
    },
  } as unknown as CodexRpcPort;
  const store = new ThreadStateStore(rpc, cwd);
  store.markStarted(parent);
  store.markStarted(sideChat);

  const workspaceIdentity = "remote:server:host-1:/workspace";
  const workspace = { workspacePath: cwd, workspaceIdentity, workspaceKey: workspaceIdentity };

  const fullList = codezSessionListResultSchema.parse(
    await handleLegacySession("session/list", { workspace }, rpc, store, workspaceIdentity),
  );
  assert.deepEqual(
    fullList.sessions.map((session) => session.sessionId),
    [parent.id],
  );

  const targetedList = codezSessionListResultSchema.parse(
    await handleLegacySession(
      "session/list",
      { workspace, sessionIds: [sideChat.id] },
      rpc,
      store,
      workspaceIdentity,
    ),
  );
  assert.equal(targetedList.sessions.length, 1);
  assert.equal(targetedList.sessions[0]?.sessionId, sideChat.id);
  assert.equal(targetedList.sessions[0]?.sessionKind, "selection_side_chat");
  assert.equal(targetedList.sessions[0]?.parentSessionId, parent.id);
  assert.deepEqual(targetedList.sessions[0]?.workspace, workspace);
});

test("session/list and session/read preserve symlinked workspacePath when store.cwd is physical realpath", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "codex-legacy-symlink-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const physicalDir = join(root, "disk", "home", "user", "workspace");
  const symlinkHome = join(root, "home-user");
  await mkdir(physicalDir, { recursive: true });
  await symlink(
    join(root, "disk", "home", "user"),
    symlinkHome,
    process.platform === "win32" ? "junction" : "dir",
  );
  const logicalWorkspacePath = join(symlinkHome, "workspace");
  const physicalCwd = await realpath(physicalDir);
  const thread = { ...threadFixture(), cwd: physicalCwd };
  const rpc = {
    async request(method: string) {
      if (method === "config/read") return { config: {} };
      if (method === "model/list") return { data: [], nextCursor: null };
      if (method === "thread/list") return { data: [thread], nextCursor: null };
      if (method === "thread/read") return { thread };
      throw new Error(`unexpected ${method}`);
    },
  } as unknown as CodexRpcPort;
  const store = new ThreadStateStore(rpc, physicalCwd);
  store.markStarted(thread);

  const remoteIdentity = `remote:server:host-1:${logicalWorkspacePath}`;
  const remoteWorkspace = {
    workspacePath: logicalWorkspacePath,
    workspaceIdentity: remoteIdentity,
    workspaceKey: remoteIdentity,
  };
  // Simulate BridgeRuntime.request where scopeWorkspaceParams normalizes params.workspace.workspacePath to physicalCwd
  const scopedParams = {
    workspace: { ...remoteWorkspace, workspacePath: physicalCwd },
    sessionIds: [thread.id],
  };
  const listed = codezSessionListResultSchema.parse(
    await handleLegacySession(
      "session/list",
      scopedParams,
      rpc,
      store,
      remoteIdentity,
      logicalWorkspacePath,
    ),
  );
  assert.equal(listed.sessions.length, 1);
  assert.deepEqual(listed.sessions[0]?.workspace, remoteWorkspace);

  const localRead = codezSessionStateSnapshotSchema.parse(
    await handleLegacySession(
      "session/read",
      { sessionId: thread.id },
      rpc,
      store,
      logicalWorkspacePath,
    ),
  );
  assert.deepEqual(localRead.session.workspace, {
    workspacePath: logicalWorkspacePath,
    workspaceKey: logicalWorkspacePath,
  });
});
