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
