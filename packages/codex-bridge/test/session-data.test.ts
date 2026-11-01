// specs/codex-session-data-purge.md 的合同测试。
//
// 锁住的边界：载体 cwd 与会话 cwd 不同也必须能测量与删除（本机全局控制面）；整树只发一次
// thread/delete；活跃/未知/写权冲突一律不删；原生「no rollout found」不等于幂等成功；
// 结果未知不盲重试并保留重试索引；字节只统计真实消失的文件；memory 恒为 0 且不碰用户文件。
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test, { type TestContext } from "node:test";
import type { CodexRpcPort } from "../src/contract.js";
import type { JsonObject } from "../src/json.js";
import { CodexRpcError, CodexTransportError } from "../src/rpc-errors.js";
import { listExistingPaths, readPendingTree } from "../src/session-data-files.js";
import { measureSessionData, purgeSessionData, type SessionDataDeps } from "../src/session-data.js";

const ROOT = "11111111-1111-4111-8111-111111111111";
const CHILD = "22222222-2222-4222-8222-222222222222";
const SCOPE = "b".repeat(64);
/** 载体 bridge 自己的 cwd：故意与目标会话不同，证明不按载体 cwd 过滤。 */
const CARRIER_CWD = "/carrier/management-plane";
const SESSION_CWD = "/workspace/cold-project";

class FakeRpc implements CodexRpcPort {
  readonly calls: Array<{ method: string; params: JsonObject }> = [];
  readonly handlers = new Map<string, (params: JsonObject) => unknown>();
  async request<T>(method: string, params?: unknown): Promise<T> {
    this.calls.push({ method, params: (params ?? {}) as JsonObject });
    const handler = this.handlers.get(method);
    if (!handler) throw new Error(`Unmocked RPC: ${method}`);
    return (await handler((params ?? {}) as JsonObject)) as T;
  }
  async respond(): Promise<void> {}
  async respondError(): Promise<void> {}
  params(method: string): JsonObject[] {
    return this.calls.filter((call) => call.method === method).map((call) => call.params);
  }
}

class FakeStore {
  readonly removed: string[] = [];
  private readonly states = new Map<string, { thread?: JsonObject; readOnly?: string | null }>();
  private readonly activity = new Map<string, boolean>();
  get(id: string) {
    return this.states.get(id);
  }
  observedThreadActive(id: string): boolean | undefined {
    return this.activity.get(id);
  }
  remove(id: string): void {
    this.removed.push(id);
  }
  setState(id: string, state: { thread?: JsonObject; readOnly?: string | null }): void {
    this.states.set(id, state);
  }
  observe(id: string, active: boolean): void {
    this.activity.set(id, active);
  }
}

function threadRow(id: string, overrides: JsonObject = {}): JsonObject {
  return {
    id,
    preview: "",
    modelProvider: "openai",
    createdAt: 100,
    updatedAt: 120,
    cwd: SESSION_CWD,
    status: { type: "notLoaded" },
    turns: [],
    ...overrides,
  };
}

interface Harness {
  deps: SessionDataDeps;
  rpc: FakeRpc;
  store: FakeStore;
  codexHome: string;
  bridgeHome: string;
  pendingRoot: string;
  /** 原生事实：线程行、spawn 边、队列行、已加载线程；flush() 把前三者写回 SQLite。 */
  threads: Map<string, JsonObject>;
  edges: Array<[string, string]>;
  queued: string[];
  loaded: string[];
  rollouts: Map<string, string[]>;
  flush(): void;
  writeRollout(threadId: string, bytes: number, archived?: boolean): Promise<string>;
  writeAttachment(sessionId: string, bytes: number, id?: string): Promise<string>;
  deleteCalls(): JsonObject[];
}

async function setup(t: TestContext): Promise<Harness> {
  const root = await mkdtemp(join(tmpdir(), "codez-session-data-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const codexHome = join(root, "codex-home");
  const bridgeHome = join(root, "bridge");
  await mkdir(codexHome, { recursive: true });

  const rpc = new FakeRpc();
  const store = new FakeStore();
  const threads = new Map<string, JsonObject>();
  const edges: Array<[string, string]> = [];
  const queued: string[] = [];
  const loaded: string[] = [];
  const rollouts = new Map<string, string[]>();
  const pendingRoot = join(bridgeHome, "session-data-pending");

  // pinned ref 的库名与表结构（codex-rs/state/src/sqlite.rs:37-38、migrations/0001_threads.sql、
  // migrations/0021_thread_spawn_edges.sql、queue_migrations/0001_queued_items.sql）：
  // 预检 SQL 只引用这些列，夹具因此能真实验证严格只读读取路径。
  function flush(): void {
    const statePath = join(codexHome, "state_5.sqlite");
    const queuePath = join(codexHome, "queue_1.sqlite");
    rmSync(statePath, { force: true });
    rmSync(queuePath, { force: true });
    const state = new DatabaseSync(statePath);
    try {
      state.exec(`
        CREATE TABLE threads (
          id TEXT PRIMARY KEY,
          rollout_path TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          source TEXT NOT NULL,
          model_provider TEXT NOT NULL,
          cwd TEXT NOT NULL,
          title TEXT NOT NULL,
          sandbox_policy TEXT NOT NULL,
          approval_mode TEXT NOT NULL
        );
        CREATE TABLE thread_spawn_edges (
          parent_thread_id TEXT NOT NULL,
          child_thread_id TEXT NOT NULL PRIMARY KEY,
          status TEXT NOT NULL
        );
      `);
      const insertThread = state.prepare(
        `INSERT INTO threads (id, rollout_path, created_at, updated_at, source, model_provider, cwd, title, sandbox_policy, approval_mode)
         VALUES (?, ?, 100, 120, 'cli', 'openai', ?, '', 'read-only', 'on-request')`,
      );
      for (const [id, thread] of threads)
        insertThread.run(id, String(thread.rolloutPath ?? ""), String(thread.cwd ?? ""));
      const insertEdge = state.prepare(
        `INSERT INTO thread_spawn_edges (parent_thread_id, child_thread_id, status) VALUES (?, ?, 'open')`,
      );
      for (const [parent, child] of edges) insertEdge.run(parent, child);
    } finally {
      state.close();
    }
    const queue = new DatabaseSync(queuePath);
    try {
      queue.exec(`
        CREATE TABLE queued_items (
          id TEXT PRIMARY KEY NOT NULL,
          thread_id TEXT NOT NULL,
          payload_json TEXT NOT NULL,
          queue_order INTEGER NOT NULL,
          created_at_ms INTEGER NOT NULL,
          updated_at_ms INTEGER NOT NULL
        );
      `);
      const insert = queue.prepare(
        `INSERT INTO queued_items (id, thread_id, payload_json, queue_order, created_at_ms, updated_at_ms)
         VALUES (?, ?, '{}', 0, 1, 1)`,
      );
      queued.forEach((threadId, index) => insert.run(`queued-${index}`, threadId));
    } finally {
      queue.close();
    }
  }

  async function writeRollout(threadId: string, bytes: number, archived = false): Promise<string> {
    const dir = join(codexHome, archived ? "archived_sessions" : "sessions", "2026", "11", "01");
    await mkdir(dir, { recursive: true });
    const path = join(dir, `rollout-2026-11-01T10-00-00-${threadId}.jsonl`);
    await writeFile(path, Buffer.alloc(bytes));
    rollouts.set(threadId, [...(rollouts.get(threadId) ?? []), path]);
    return path;
  }

  async function writeAttachment(
    sessionId: string,
    bytes: number,
    id = "44444444-4444-4444-8444-444444444444",
  ): Promise<string> {
    const objects = join(bridgeHome, SCOPE, "attachments", "objects");
    await mkdir(objects, { recursive: true });
    await writeFile(join(objects, `${id}.data`), Buffer.alloc(bytes));
    await writeFile(
      join(objects, `${id}.json`),
      JSON.stringify({
        version: 1,
        workspace: SCOPE,
        id,
        upload: {
          connectionId: "test",
          uploadId: id,
          sessionId,
          fileName: "image.png",
          mime: "image/png",
          totalBytes: bytes,
          totalChunks: 1,
          checksum: "sha256:test",
        },
      }),
    );
    return join(objects, `${id}.data`);
  }

  rpc.handlers.set("thread/read", (params) => {
    const id = String(params.threadId);
    const thread = threads.get(id);
    if (!thread) throw new CodexRpcError(-32600, `thread not loaded: ${id}`);
    return { thread };
  });
  rpc.handlers.set("thread/list", (params) => {
    const ancestor = String(params.ancestorThreadId ?? "");
    const archived = params.archived === true;
    const data = edges
      .filter(([parent]) => parent === ancestor)
      .map(([, child]) => threads.get(child))
      .filter((thread) => thread !== undefined && Boolean(thread.archived) === archived);
    return { data, nextCursor: null };
  });
  rpc.handlers.set("thread/loaded/list", () => ({ data: [...loaded], nextCursor: null }));
  rpc.handlers.set("thread/queue/list", (params) => {
    const id = String(params.threadId);
    const data = queued
      .filter((threadId) => threadId === id)
      .map((_, index) => ({ id: `queued-${index}` }));
    return { data, nextCursor: null };
  });
  // 原生 thread/delete 的语义（pinned ref thread_delete.rs:39-62）：整棵 spawn 子树、子先父后、
  // 删 rollout 文件与 state db 行；夹具照此模拟，供删后复查与字节计量验证。
  rpc.handlers.set("thread/delete", async (params) => {
    const rootId = String(params.threadId);
    const ids = [
      rootId,
      ...edges.filter(([parent]) => parent === rootId).map(([, child]) => child),
    ];
    for (const id of ids) {
      // 原生按 payload 归属删除 replacement rollout：夹具用 threads.rollout_path 表达这条事实。
      const recorded = String(threads.get(id)?.rolloutPath ?? "");
      threads.delete(id);
      for (const path of rollouts.get(id) ?? []) await rm(path, { force: true });
      if (recorded) await rm(recorded, { force: true });
      rollouts.delete(id);
    }
    for (let index = edges.length - 1; index >= 0; index -= 1) {
      const [parent, child] = edges[index]!;
      if (ids.includes(parent) || ids.includes(child)) edges.splice(index, 1);
    }
    flush();
    return {};
  });

  const deps: SessionDataDeps = {
    rpc,
    store,
    carrier: { cwd: CARRIER_CWD, workspaceId: CARRIER_CWD, stateRoot: join(bridgeHome, SCOPE) },
    codexHome,
    bridgeHome,
  };
  return {
    deps,
    rpc,
    store,
    codexHome,
    bridgeHome,
    pendingRoot,
    threads,
    edges,
    queued,
    loaded,
    rollouts,
    flush,
    writeRollout,
    writeAttachment,
    deleteCalls: () => rpc.params("thread/delete"),
  };
}

/** 一棵「根 + 一个跨 cwd 子代理」的冷项目树：载体 cwd 与会话 cwd 不同。 */
async function coldTree(harness: Harness): Promise<void> {
  harness.threads.set(ROOT, threadRow(ROOT));
  harness.threads.set(CHILD, threadRow(CHILD, { parentThreadId: ROOT, cwd: "/worktree/isolated" }));
  harness.edges.push([ROOT, CHILD]);
  await harness.writeRollout(ROOT, 11);
  await harness.writeRollout(CHILD, 5);
  harness.flush();
}

test("measure 覆盖后代与附件，且不受载体 cwd 影响（SD-CODEX-01/13）", async (t) => {
  const h = await setup(t);
  await coldTree(h);
  await h.writeAttachment(ROOT, 7);

  const result = await measureSessionData(
    { sessionIds: [ROOT], directories: [{ workspacePath: SESSION_CWD }] },
    h.deps,
  );
  assert.deepEqual(result.sessions, [{ sessionId: ROOT, bytes: 11 + 5 + 7 }]);
  assert.deepEqual(result.memory, [{ workspacePath: SESSION_CWD, bytes: 0 }]);
  assert.deepEqual(h.deleteCalls(), [], "measure 绝不删除");
  assert.equal(h.rpc.params("thread/resume").length, 0, "measure 绝不 resume");
});

test("purge 整棵树只发一次 thread/delete，字节只算真实消失的文件（SD-CODEX-02）", async (t) => {
  const h = await setup(t);
  await coldTree(h);
  await h.writeAttachment(CHILD, 7);

  const result = await purgeSessionData({ sessionIds: [ROOT], directories: [] }, h.deps);
  assert.deepEqual(result.deleted, [{ sessionId: ROOT, bytes: 11 + 5 + 7 }]);
  assert.deepEqual(result.kept, []);
  assert.deepEqual(result.failed, []);
  assert.deepEqual(h.deleteCalls(), [{ threadId: ROOT }], "整树级联由原生负责，只调一次");
  assert.deepEqual([...h.store.removed].sort(), [CHILD, ROOT].sort(), "成功后才写 tombstone");
  assert.equal(await readPendingTree(h.pendingRoot, ROOT), undefined, "成功后清掉重试索引");
});

test("树内任一成员活跃或有排队输入 → 整棵保留，绝不删除（SD-CODEX-03）", async (t) => {
  const h = await setup(t);
  await coldTree(h);
  // 原生 active 状态必带 activeFlags（v2/ThreadStatus.ts）：夹具必须与 pinned 形状一致，
  // 否则 zod 判别联合解析失败，会被当成「无法证明空闲」而不是「运行中」。
  h.threads.set(
    CHILD,
    threadRow(CHILD, { parentThreadId: ROOT, status: { type: "active", activeFlags: [] } }),
  );
  h.flush();

  const running = await purgeSessionData({ sessionIds: [ROOT], directories: [] }, h.deps);
  assert.deepEqual(running.kept, [{ sessionId: ROOT, reason: "running" }]);
  assert.deepEqual(running.deleted, []);
  assert.deepEqual(h.deleteCalls(), []);

  h.threads.set(CHILD, threadRow(CHILD, { parentThreadId: ROOT }));
  h.queued.push(ROOT);
  h.flush();
  const queued = await purgeSessionData({ sessionIds: [ROOT], directories: [] }, h.deps);
  assert.deepEqual(queued.kept, [{ sessionId: ROOT, reason: "running" }], "排队输入等价 busy");
  assert.deepEqual(h.deleteCalls(), []);
});

test("无法证明整树空闲 → failed，不删也不 tombstone（SD-CODEX-04/11/12/14）", async (t) => {
  // 子线程只剩 spawn 边、原生读又抛非缺失错误：无法定性 → fail-closed。
  const h = await setup(t);
  await coldTree(h);
  h.threads.delete(CHILD);
  h.flush();
  h.rpc.handlers.set("thread/read", (params) => {
    const id = String(params.threadId);
    if (id === CHILD) throw new CodexRpcError(-32603, "internal error");
    const thread = h.threads.get(id);
    if (!thread) throw new CodexRpcError(-32600, `thread not loaded: ${id}`);
    return { thread };
  });
  const unknown = await purgeSessionData({ sessionIds: [ROOT], directories: [] }, h.deps);
  assert.deepEqual(unknown.failed, [{ sessionId: ROOT, code: "native-read-failed" }]);
  assert.deepEqual(h.deleteCalls(), []);
  assert.deepEqual(h.store.removed, []);

  // 写权冲突：另一个进程/连接持有该线程。
  const conflict = await setup(t);
  await coldTree(conflict);
  conflict.store.setState(ROOT, { readOnly: "writer-conflict" });
  const conflicted = await purgeSessionData({ sessionIds: [ROOT], directories: [] }, conflict.deps);
  assert.deepEqual(conflicted.failed, [{ sessionId: ROOT, code: "writer-conflict" }]);
  assert.deepEqual(conflict.deleteCalls(), []);

  // 根其实是子线程：Host 的整树记账会错位。
  const child = await setup(t);
  child.threads.set(CHILD, threadRow(CHILD, { parentThreadId: ROOT }));
  child.flush();
  const rejected = await purgeSessionData({ sessionIds: [CHILD], directories: [] }, child.deps);
  assert.deepEqual(rejected.failed, [{ sessionId: CHILD, code: "not-a-root-thread" }]);

  // state db 缺失：无法证明整树 → 不降级成只删根。
  const noDb = await setup(t);
  await coldTree(noDb);
  rmSync(join(noDb.codexHome, "state_5.sqlite"));
  const blocked = await purgeSessionData({ sessionIds: [ROOT], directories: [] }, noDb.deps);
  assert.deepEqual(blocked.failed, [{ sessionId: ROOT, code: "state-db-unavailable" }]);
  assert.deepEqual(noDb.deleteCalls(), []);
  await assert.rejects(
    measureSessionData({ sessionIds: [ROOT], directories: [] }, noDb.deps),
    /state db is missing/,
    "measure 没有 failed 通道，只能整条失败让 Host 隐藏选项",
  );
});

test("原生 no rollout found 不是幂等成功：行还在就失败，行不在才算已删（SD-CODEX-05/06）", async (t) => {
  const h = await setup(t);
  await coldTree(h);
  await h.writeAttachment(ROOT, 7);
  // 真实场景：rollout 文件已经丢了，但 state db 行还在 —— 原生在删任何行之前就报错返回。
  for (const paths of h.rollouts.values())
    for (const path of paths) await rm(path, { force: true });
  h.rpc.handlers.set("thread/delete", () => {
    throw new CodexRpcError(-32600, `no rollout found for thread id ${ROOT}`);
  });

  const withRows = await purgeSessionData({ sessionIds: [ROOT], directories: [] }, h.deps);
  assert.deepEqual(withRows.failed, [{ sessionId: ROOT, code: "rollout-missing-rows-remain" }]);
  assert.deepEqual(withRows.deleted, [], "state db 行与后代都还在，不能报 deleted");
  assert.deepEqual(h.store.removed, []);
  const pending = await readPendingTree(h.pendingRoot, ROOT);
  assert.deepEqual([...(pending?.threadIds ?? [])].sort(), [CHILD, ROOT].sort());

  // 行也不在了 → 按已删除处理，附件仍然清理（幂等）。
  h.threads.clear();
  h.edges.length = 0;
  h.flush();
  const withoutRows = await purgeSessionData({ sessionIds: [ROOT], directories: [] }, h.deps);
  assert.deepEqual(withoutRows.deleted, [{ sessionId: ROOT, bytes: 7 }]);
  assert.deepEqual(withoutRows.failed, []);
});

test("fork 历史仍引用 → kept(referenced)，一个文件都不动（SD-CODEX-07）", async (t) => {
  const h = await setup(t);
  await coldTree(h);
  h.rpc.handlers.set("thread/delete", () => {
    throw new CodexRpcError(
      -32600,
      `cannot delete thread ${ROOT}: forked history still references it`,
    );
  });

  const result = await purgeSessionData({ sessionIds: [ROOT], directories: [] }, h.deps);
  assert.deepEqual(result.kept, [{ sessionId: ROOT, reason: "referenced" }]);
  assert.deepEqual(result.deleted, []);
  assert.deepEqual(h.store.removed, []);
  const measured = await measureSessionData({ sessionIds: [ROOT], directories: [] }, h.deps);
  assert.equal(measured.sessions[0]!.bytes, 16, "被引用的树一个字节都没少");
});

test("删除结果未知 → 不盲重试、不 tombstone、保留重试索引（SD-CODEX-08）", async (t) => {
  const h = await setup(t);
  await coldTree(h);
  h.rpc.handlers.set("thread/delete", () => {
    throw new CodexTransportError("TIMEOUT", "Codex request timed out");
  });

  const result = await purgeSessionData({ sessionIds: [ROOT], directories: [] }, h.deps);
  assert.deepEqual(result.failed, [{ sessionId: ROOT, code: "delete-result-unknown" }]);
  assert.deepEqual(result.deleted, []);
  assert.deepEqual(h.store.removed, []);
  assert.equal(h.deleteCalls().length, 1, "同一次调用内绝不重发删除");
  const pending = await readPendingTree(h.pendingRoot, ROOT);
  assert.deepEqual([...(pending?.threadIds ?? [])].sort(), [CHILD, ROOT].sort());
});

test("重复 purge 幂等：第二次按 0 字节成功（SD-CODEX-09）", async (t) => {
  const h = await setup(t);
  await coldTree(h);
  const first = await purgeSessionData({ sessionIds: [ROOT], directories: [] }, h.deps);
  assert.equal(first.deleted[0]!.bytes, 16);

  const second = await purgeSessionData({ sessionIds: [ROOT], directories: [] }, h.deps);
  assert.deepEqual(second.deleted, [{ sessionId: ROOT, bytes: 0 }]);
  assert.deepEqual(second.failed, []);
  assert.deepEqual(second.kept, []);
});

test("删除前门禁复检抓住预检之后才启动的 turn（TOCTOU）", async (t) => {
  const h = await setup(t);
  await coldTree(h);
  h.loaded.push(ROOT);
  let reads = 0;
  h.rpc.handlers.set("thread/read", (params) => {
    const id = String(params.threadId);
    const thread = h.threads.get(id);
    if (!thread) throw new CodexRpcError(-32600, `thread not loaded: ${id}`);
    // 预检时空闲；门禁复检时用户已经发出新一轮 —— 原生会强杀活跃线程，必须保留。
    if (id === ROOT && ++reads >= 2)
      return { thread: { ...thread, status: { type: "active", activeFlags: [] } } };
    return { thread };
  });

  const result = await purgeSessionData({ sessionIds: [ROOT], directories: [] }, h.deps);
  assert.deepEqual(result.kept, [{ sessionId: ROOT, reason: "running" }]);
  assert.deepEqual(h.deleteCalls(), [], "复检发现活跃就绝不发出 thread/delete");
});

test("附件 manifest 读不出 → 无法证明归属，fail-closed 不删", async (t) => {
  const h = await setup(t);
  await coldTree(h);
  const objects = join(h.bridgeHome, SCOPE, "attachments", "objects");
  await mkdir(objects, { recursive: true });
  await writeFile(join(objects, "55555555-5555-4555-8555-555555555555.json"), "{ half");

  const result = await purgeSessionData({ sessionIds: [ROOT], directories: [] }, h.deps);
  assert.deepEqual(result.failed, [{ sessionId: ROOT, code: "attachment-manifest-unreadable" }]);
  assert.deepEqual(h.deleteCalls(), [], "证明不了归属就不启动破坏性步骤");
  await assert.rejects(
    measureSessionData({ sessionIds: [ROOT], directories: [] }, h.deps),
    /cannot prove attachment ownership/,
  );
});

test("memory 恒为 0，$CODEX_HOME/memories 与用户文件不被触碰（SD-CODEX-13）", async (t) => {
  const h = await setup(t);
  await coldTree(h);
  const globalMemory = join(h.codexHome, "memories", "memory_summary.md");
  await mkdir(join(h.codexHome, "memories"), { recursive: true });
  await writeFile(globalMemory, "global memory");

  const result = await purgeSessionData(
    { sessionIds: [ROOT], directories: [{ workspacePath: SESSION_CWD }] },
    h.deps,
  );
  assert.deepEqual(result.memory, [{ workspacePath: SESSION_CWD, bytes: 0 }]);
  assert.equal(result.deleted.length, 1);
  assert.equal(await readFile(globalMemory, "utf8"), "global memory");
});

test("观测到活跃与非法 id 也 fail-closed（SD-CODEX-12）", async (t) => {
  const h = await setup(t);
  await coldTree(h);
  h.store.observe(CHILD, true);
  const observed = await purgeSessionData({ sessionIds: [ROOT], directories: [] }, h.deps);
  assert.deepEqual(observed.kept, [{ sessionId: ROOT, reason: "running" }]);
  assert.deepEqual(h.deleteCalls(), []);

  const invalid = await purgeSessionData(
    { sessionIds: ["../../etc/passwd"], directories: [] },
    h.deps,
  );
  assert.deepEqual(invalid.failed, [{ sessionId: "../../etc/passwd", code: "invalid-session-id" }]);
  assert.deepEqual(h.deleteCalls(), []);
});

test("state db 记录的 replacement rollout 计入字节并在删后复查（payload 归属）", async (t) => {
  const h = await setup(t);
  await coldTree(h);
  // 回退产生的 replacement：文件名里的 UUID 与线程无关，归属只写在 payload / state db 里
  // （pinned delete_thread.rs 测试 delete_thread_rejects_reference_to_reverted_rollout）。
  const replacement = join(
    h.codexHome,
    "sessions",
    "2026",
    "11",
    "02",
    "rollout-2026-11-02T09-00-00-99999999-9999-4999-8999-999999999999.jsonl",
  );
  await mkdir(dirname(replacement), { recursive: true });
  await writeFile(replacement, Buffer.alloc(13));
  h.threads.set(ROOT, { ...h.threads.get(ROOT)!, rolloutPath: replacement });
  h.flush();

  const measured = await measureSessionData({ sessionIds: [ROOT], directories: [] }, h.deps);
  assert.equal(
    measured.sessions[0]!.bytes,
    11 + 5 + 13,
    "文件名不匹配的 rollout 也要按库里的路径计量",
  );

  const result = await purgeSessionData({ sessionIds: [ROOT], directories: [] }, h.deps);
  assert.deepEqual(result.deleted, [{ sessionId: ROOT, bytes: 11 + 5 + 13 }]);
  assert.deepEqual(await listExistingPaths([replacement]), [], "计量过的文件必须确认真的消失");
});

test("原生删除后仍有 threads 行 → failed(native-rows-remain)，后代附件一个不动", async (t) => {
  const h = await setup(t);
  await coldTree(h);
  const blob = await h.writeAttachment(CHILD, 7);
  // 原生只删掉根就返回成功（例如中途失败）：后代行还在，既不能报成功也不能清它的附件。
  h.rpc.handlers.set("thread/delete", async (params) => {
    const rootId = String(params.threadId);
    for (const path of h.rollouts.get(rootId) ?? []) await rm(path, { force: true });
    h.rollouts.delete(rootId);
    h.threads.delete(rootId);
    h.flush();
    return {};
  });

  const result = await purgeSessionData({ sessionIds: [ROOT], directories: [] }, h.deps);
  assert.deepEqual(result.failed, [{ sessionId: ROOT, code: "native-rows-remain" }]);
  assert.deepEqual(result.deleted, []);
  assert.deepEqual(h.store.removed, []);
  assert.deepEqual(await listExistingPaths([blob]), [blob], "后代还活着就不能删它的附件");
  assert.ok(await readPendingTree(h.pendingRoot, ROOT), "失败保留重试索引");
});

test("重试索引形状不符 → fail-closed，不删也不清附件", async (t) => {
  const h = await setup(t);
  await coldTree(h);
  await mkdir(h.pendingRoot, { recursive: true });
  const index = join(h.pendingRoot, `${ROOT.toLowerCase()}.json`);
  await writeFile(index, JSON.stringify({ version: 2, rootId: ROOT, threadIds: [ROOT] }));

  const result = await purgeSessionData({ sessionIds: [ROOT], directories: [] }, h.deps);
  assert.deepEqual(result.failed, [{ sessionId: ROOT, code: "pending-index-unreadable" }]);
  assert.deepEqual(h.deleteCalls(), [], "读不懂索引就不启动破坏性步骤");
  assert.deepEqual(
    await readFile(index, "utf8"),
    JSON.stringify({ version: 2, rootId: ROOT, threadIds: [ROOT] }),
  );
});

test("会话 id 的大写拼写不会让后代与附件静默漏删", async (t) => {
  const h = await setup(t);
  await coldTree(h);
  await h.writeAttachment(CHILD, 7);

  const result = await purgeSessionData(
    { sessionIds: [ROOT.toUpperCase()], directories: [] },
    h.deps,
  );
  // 结果里的 sessionId 保持调用方拼写；原生调用与磁盘归属一律用规范化后的小写 UUID。
  assert.deepEqual(result.deleted, [{ sessionId: ROOT.toUpperCase(), bytes: 11 + 5 + 7 }]);
  assert.deepEqual(h.deleteCalls(), [{ threadId: ROOT }]);
  assert.deepEqual([...h.store.removed].sort(), [CHILD, ROOT].sort());
});
