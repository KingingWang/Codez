import assert from "node:assert/strict";
import test from "node:test";
import {
  codezSessionCloseResultSchema,
  codezSessionStateSnapshotSchema,
  codezSessionListResultSchema,
} from "@codez/shared";
import { handleLegacySession } from "../src/legacy-sessions.js";
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
