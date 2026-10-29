import {
  appendFile,
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { CodezTaskMeta } from "@codez/shared";
import { describe, expect, it, vi, type Mock } from "vitest";
import { createCodexGlobalRolloutSyncer } from "../src/project/index.js";
import type { CodexGlobalRolloutTaskStore } from "../src/project/codexGlobalRolloutSyncer.js";
import { getCodexRolloutScanCachePath } from "../src/paths.js";
import { TaskIndexRepo } from "../src/session/taskIndexRepo.js";
import { parseRolloutCandidate } from "../src/project/codexRolloutFacts.js";
import {
  loadRolloutScanFacts,
  serializeRolloutScanFacts,
} from "../src/project/codexRolloutScanCache.js";

// 本次优化的核心是「无变化时不再遍历目录、不再 stat/解析历史 rollout」，只断言入库结果
// 无法证明扫描量真的收敛。这里把 stat/readdir/open 包一层透传 spy（实现仍是真实文件系统），
// 用来断言目录遍历次数、文件解析次数与 SQLite 写入次数。
const io = vi.hoisted(() => ({
  stat: vi.fn(),
  readdir: vi.fn(),
  open: vi.fn(),
}));
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  io.stat.mockImplementation(actual.stat);
  io.readdir.mockImplementation(actual.readdir);
  io.open.mockImplementation(actual.open);
  return { ...actual, stat: io.stat, readdir: io.readdir, open: io.open };
});

const clearIoCounters = () => {
  io.stat.mockClear();
  io.readdir.mockClear();
  io.open.mockClear();
};

interface FakeTaskStore extends CodexGlobalRolloutTaskStore {
  rows: Map<string, CodezTaskMeta>;
  getTaskMeta: Mock<CodexGlobalRolloutTaskStore["getTaskMeta"]>;
  applyCliFacts: Mock<CodexGlobalRolloutTaskStore["applyCliFacts"]>;
}

/** 内存版 task store：只关心调用次数与调用参数，不引入 SQLite 写事务噪声。 */
function createFakeTaskStore(): FakeTaskStore {
  const rows = new Map<string, CodezTaskMeta>();
  const getTaskMeta = vi.fn<CodexGlobalRolloutTaskStore["getTaskMeta"]>(
    async ({ taskId }) => rows.get(taskId) ?? null,
  );
  const applyCliFacts = vi.fn<CodexGlobalRolloutTaskStore["applyCliFacts"]>(async ({ meta }) => {
    rows.set(meta.taskId, meta);
    return meta;
  });
  return { rows, getTaskMeta, applyCliFacts };
}

const SCAN_CWD = "/remote/rollout-scan";

function rolloutStamp(day: number, seq: number): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `2026-10-${pad(day)}T00-${pad(Math.floor(seq / 60))}-${pad(seq % 60)}`;
}

function rolloutSessionId(index: number): string {
  return `019a0000-0000-7000-8000-${String(index).padStart(12, "0")}`;
}

async function writeRollout(
  dir: string,
  stamp: string,
  sessionId: string,
  title: string,
): Promise<string> {
  const path = join(dir, `rollout-${stamp}-${sessionId}.jsonl`);
  await writeFile(
    path,
    [
      JSON.stringify({
        type: "session_meta",
        payload: { meta: { id: sessionId, cwd: SCAN_CWD, source: "cli" } },
      }),
      JSON.stringify({
        type: "event_msg",
        payload: { type: "user_message", message: title },
      }),
      JSON.stringify({ type: "event_msg", payload: { type: "task_complete" } }),
    ].join("\n") + "\n",
    "utf8",
  );
  return path;
}

/** 并发写入夹具，避免上千次串行 writeFile 把用例时长打穿。 */
async function writeRollouts(
  items: Array<{
    dir: string;
    stamp: string;
    sessionId: string;
    title: string;
  }>,
): Promise<void> {
  const CHUNK = 100;
  for (let index = 0; index < items.length; index += CHUNK) {
    await Promise.all(
      items
        .slice(index, index + CHUNK)
        .map((item) => writeRollout(item.dir, item.stamp, item.sessionId, item.title)),
    );
  }
}

describe("createCodexGlobalRolloutSyncer", () => {
  it("keeps SQLite activity unchanged for metadata writes and only advances for real activity", async () => {
    const dir = await mkdtemp(join(tmpdir(), "codez-rollout-sqlite-activity-"));
    const codexHome = join(dir, ".codex");
    const day = join(codexHome, "sessions", "2026", "10", "01");
    await mkdir(day, { recursive: true });
    const taskId = rolloutSessionId(9);
    const path = await writeRollout(day, "2026-10-01T00-00-00", taskId, "activity SQL");
    const at = Date.parse("2026-10-01T01:00:00Z");
    const workspaceIdentity = `remote:server:activity:${SCAN_CWD}`;
    const databasePath = join(dir, "tasks-index.sqlite");
    const repo = new TaskIndexRepo(undefined, "remote:server:activity", databasePath);
    const syncer = createCodexGlobalRolloutSyncer({
      taskIndexRepo: repo,
      env: { CODEX_HOME: codexHome },
      resolveWorkspaceIdentity: async () => workspaceIdentity,
    });
    const target = { taskId, workspacePath: SCAN_CWD, workspaceIdentity };
    const append = async (type: string, timestamp: number) =>
      appendFile(
        path,
        JSON.stringify({
          type: "event_msg",
          timestamp: new Date(timestamp).toISOString(),
          payload: { type },
        }) + "\n",
      );
    try {
      await append("task_complete", at);
      await syncer.syncNow();
      expect((await repo.getTaskMeta(target))?.updatedAt).toBe(at);
      await append("token_count", at + 10000);
      await append("thread_goal_updated", at + 20000);
      await syncer.syncNow();
      expect((await repo.getTaskMeta(target))?.updatedAt).toBe(at);
      await append("task_complete", at + 30000);
      await syncer.syncNow();
      expect((await repo.getTaskMeta(target))?.updatedAt).toBe(at + 30000);
      const meta = (await repo.getTaskMeta(target))!;
      await repo.applyCliFacts({ meta: { ...meta, updatedAt: at + 50000 } });
      await append("token_count", at + 60000);
      await syncer.syncNow();
      expect((await repo.getTaskMeta(target))?.updatedAt).toBe(
        at + 50000,
        "不迁移或回拨既有错误时间",
      );
      const database = new DatabaseSync(databasePath, { readOnly: true });
      try {
        expect(
          database.prepare("select cli_updated_at from tasks where task_id=?").get(taskId),
        ).toMatchObject({ cli_updated_at: at + 50000 });
      } finally {
        database.close();
      }
    } finally {
      syncer.dispose();
      repo.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("uses timed conversation activity, not file mtime or settings/goal/token/context appends", async () => {
    const dir = await mkdtemp(join(tmpdir(), "codez-rollout-activity-"));
    const name = `rollout-2026-10-01T00-00-00-${rolloutSessionId(1)}.jsonl`;
    const path = join(dir, name);
    const createdAt = Date.parse("2026-10-01T00:00:00Z");
    const activityAt = createdAt + 10000;
    const records = [
      { type: "session_meta", payload: { id: rolloutSessionId(1), cwd: SCAN_CWD, source: "cli" } },
      {
        type: "event_msg",
        timestamp: new Date(activityAt).toISOString(),
        payload: { type: "user_message", message: "real prompt" },
      },
    ];
    try {
      await writeFile(path, records.map((record) => JSON.stringify(record)).join("\n") + "\n");
      const first = await parseRolloutCandidate(path, name, createdAt + 999999);
      expect(first.candidate?.updatedAt).toBe(activityAt);
      await appendFile(
        path,
        [
          { type: "turn_context", payload: { model: "changed" } },
          {
            type: "event_msg",
            payload: { type: "thread_goal_updated", goal: { objective: "goal" } },
          },
          { type: "event_msg", payload: { type: "token_count" } },
          {
            type: "response_item",
            payload: {
              type: "message",
              role: "user",
              content: [{ text: "<environment_context><cwd>/work</cwd></environment_context>" }],
            },
          },
        ]
          .map((record) =>
            JSON.stringify({ ...record, timestamp: new Date(activityAt + 50000).toISOString() }),
          )
          .join("\n") + "\n",
      );
      expect(
        (await parseRolloutCandidate(path, name, createdAt + 1999999)).candidate?.updatedAt,
      ).toBe(activityAt);
      await appendFile(
        path,
        JSON.stringify({
          type: "event_msg",
          timestamp: new Date(activityAt + 60000).toISOString(),
          payload: { type: "task_complete" },
        }) + "\n",
      );
      expect(
        (await parseRolloutCandidate(path, name, createdAt + 2999999)).candidate?.updatedAt,
      ).toBe(activityAt + 60000);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("falls back to stable creation time and invalidates version 1 parse facts", async () => {
    const dir = await mkdtemp(join(tmpdir(), "codez-rollout-old-clock-cache-"));
    try {
      const path = await writeRollout(
        dir,
        "2026-10-01T00-00-00",
        rolloutSessionId(1),
        "untimed history",
      );
      const parsed = await parseRolloutCandidate(path, path.split("/").at(-1)!, Date.now());
      expect(parsed.candidate?.updatedAt).toBe(parsed.candidate?.createdAt);
      const content = serializeRolloutScanFacts(dir, [
        [
          path,
          {
            mtimeMs: 1,
            size: 1,
            candidate: parsed.candidate,
            settled: false,
          },
        ],
      ])!;
      expect(JSON.parse(content).version).toBe(2);
      const cachePath = join(dir, "cache.json");
      await writeFile(cachePath, JSON.stringify({ ...JSON.parse(content), version: 1 }));
      expect((await loadRolloutScanFacts(cachePath, dir)).size).toBe(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("prefers valid native turn/item times and includes real tool/reasoning records", async () => {
    const dir = await mkdtemp(join(tmpdir(), "codez-rollout-native-times-"));
    const name = `rollout-2026-10-01T00-00-00-${rolloutSessionId(2)}.jsonl`;
    const path = join(dir, name);
    const createdAt = Date.parse("2026-10-01T00:00:00Z");
    try {
      const records = [
        {
          type: "session_meta",
          payload: { id: rolloutSessionId(2), cwd: SCAN_CWD, source: "cli" },
        },
        { type: "event_msg", payload: { type: "user_message", message: "real user" } },
        { type: "event_msg", payload: { type: "task_started", started_at: createdAt / 1000 + 10 } },
        {
          type: "event_msg",
          payload: {
            type: "item_completed",
            completed_at_ms: createdAt + 20123,
            item: { type: "Reasoning", id: "reason" },
          },
        },
        {
          type: "response_item",
          timestamp: new Date(createdAt + 30000).toISOString(),
          payload: { type: "function_call", call_id: "call", name: "read", arguments: "{}" },
        },
        {
          type: "event_msg",
          timestamp: new Date(createdAt + 999999).toISOString(),
          payload: { type: "turn_complete", completed_at: createdAt / 1000 + 40 },
        },
      ];
      await writeFile(path, records.map((record) => JSON.stringify(record)).join("\n") + "\n");
      expect((await parseRolloutCandidate(path, name, Date.now())).candidate?.updatedAt).toBe(
        createdAt + 40000,
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
  it("waits for a real user item after injected context and repairs an old title", async () => {
    const dir = await mkdtemp(join(tmpdir(), "codez-global-rollout-context-"));
    const codexHome = join(dir, ".codex");
    const dayDir = join(codexHome, "sessions", "2026", "10", "22");
    await mkdir(dayDir, { recursive: true });
    const sessionId = "019a0000-0000-7000-8000-000000000456";
    const workspacePath = "/remote/codex-project";
    const workspaceIdentity = `remote:ssh:host:22:dev:${workspacePath}`;
    const rolloutPath = join(dayDir, `rollout-2026-10-22T08-00-00-${sessionId}.jsonl`);
    const environment =
      "<environment_context><cwd>/remote/codex-project</cwd></environment_context>";
    await writeFile(
      rolloutPath,
      [
        {
          type: "session_meta",
          payload: {
            meta: { id: sessionId, cwd: workspacePath, source: "cli" },
          },
        },
        {
          type: "response_item",
          payload: {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: environment }],
          },
        },
      ]
        .map((line) => JSON.stringify(line))
        .join("\n") + "\n",
    );
    const databasePath = join(dir, "tasks-index.sqlite");
    const repo = new TaskIndexRepo(undefined, "remote:server:srv-1", databasePath);
    const target = { workspacePath, workspaceIdentity, taskId: sessionId };
    const createSyncer = () =>
      createCodexGlobalRolloutSyncer({
        taskIndexRepo: repo,
        resolveWorkspaceIdentity: async () => workspaceIdentity,
        env: { CODEX_HOME: codexHome },
      });
    const syncer = createSyncer();
    try {
      expect(await syncer.syncNow()).toBe(false);
      expect(await repo.getTaskMeta(target)).toBeNull();

      await appendFile(
        rolloutPath,
        `${JSON.stringify({
          type: "response_item",
          payload: {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: "旧版用户输入" }],
          },
        })}\n`,
      );
      expect(await syncer.syncNow()).toBe(true);
      expect((await repo.getTaskMeta(target))?.title).toBe("旧版用户输入");

      await appendFile(
        rolloutPath,
        `${JSON.stringify({
          type: "event_msg",
          payload: {
            type: "item_completed",
            item: {
              type: "UserMessage",
              content: [{ type: "text", text: "排查远端标题切换" }],
            },
          },
        })}\n`,
      );
      expect(await syncer.syncNow()).toBe(true);
      expect((await repo.getTaskMeta(target))?.title).toBe("排查远端标题切换");

      const legacyDatabase = new DatabaseSync(databasePath);
      try {
        legacyDatabase
          .prepare(
            "UPDATE tasks SET title = ?, cli_title = ?, cli_title_source = 'default' WHERE task_id = ?",
          )
          .run(environment, environment, sessionId);
      } finally {
        legacyDatabase.close();
      }
      syncer.dispose();
      const restarted = createSyncer();
      try {
        expect(await restarted.syncNow()).toBe(true);
        expect((await repo.getTaskMeta(target))?.title).toBe("排查远端标题切换");
      } finally {
        restarted.dispose();
      }
    } finally {
      syncer.dispose();
      repo.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("ignores the injected AGENTS.md instructions fragment and repairs a polluted title", async () => {
    const dir = await mkdtemp(join(tmpdir(), "codez-global-rollout-agents-md-"));
    const codexHome = join(dir, ".codex");
    const dayDir = join(codexHome, "sessions", "2026", "10", "23");
    await mkdir(dayDir, { recursive: true });
    const sessionId = "019a0000-0000-7000-8000-000000000789";
    const workspacePath = "/remote/new-api";
    const workspaceIdentity = `remote:ssh:debian:22:dev:${workspacePath}`;
    const rolloutPath = join(dayDir, `rollout-2026-10-23T01-00-00-${sessionId}.jsonl`);
    // 生产 rollout 的真实落盘顺序：AGENTS.md 注入块与环境块都带 user 角色，
    // 且没有 `## My request for Codex:` 分隔符，真实用户消息随后才落盘。
    const agentsInstructions =
      "# AGENTS.md instructions for /remote/new-api\n\n<INSTRUCTIONS>\n规则\n</INSTRUCTIONS>";
    await writeFile(
      rolloutPath,
      [
        {
          type: "session_meta",
          payload: {
            meta: { id: sessionId, cwd: workspacePath, source: "appServer" },
          },
        },
        {
          type: "response_item",
          payload: {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: agentsInstructions }],
          },
        },
        {
          type: "response_item",
          payload: {
            type: "message",
            role: "user",
            content: [
              {
                type: "input_text",
                text: "<environment_context><cwd>/remote/new-api</cwd></environment_context>",
              },
            ],
          },
        },
      ]
        .map((line) => JSON.stringify(line))
        .join("\n") + "\n",
    );
    const databasePath = join(dir, "tasks-index.sqlite");
    const repo = new TaskIndexRepo(undefined, "remote:server:srv-1", databasePath);
    const target = { workspacePath, workspaceIdentity, taskId: sessionId };
    const createSyncer = () =>
      createCodexGlobalRolloutSyncer({
        taskIndexRepo: repo,
        resolveWorkspaceIdentity: async () => workspaceIdentity,
        env: { CODEX_HOME: codexHome },
      });
    const syncer = createSyncer();
    try {
      expect(await syncer.syncNow()).toBe(false);
      expect(await repo.getTaskMeta(target)).toBeNull();

      await appendFile(
        rolloutPath,
        `${JSON.stringify({
          type: "event_msg",
          payload: {
            type: "item_completed",
            item: {
              type: "UserMessage",
              content: [{ type: "text", text: "看看为啥远程workflow构建失败了" }],
            },
          },
        })}\n`,
      );
      expect(await syncer.syncNow()).toBe(true);
      expect((await repo.getTaskMeta(target))?.title).toBe("看看为啥远程workflow构建失败了");

      // 已污染的旧索引（"# AGENTS.md instructions…" 标题）在重扫时必须被同一任务 id 修复。
      const legacyDatabase = new DatabaseSync(databasePath);
      try {
        legacyDatabase
          .prepare(
            "UPDATE tasks SET title = ?, cli_title = ?, cli_title_source = 'default' WHERE task_id = ?",
          )
          .run(agentsInstructions, agentsInstructions, sessionId);
      } finally {
        legacyDatabase.close();
      }
      syncer.dispose();
      const restarted = createSyncer();
      try {
        expect(await restarted.syncNow()).toBe(true);
        expect((await repo.getTaskMeta(target))?.title).toBe("看看为啥远程workflow构建失败了");
      } finally {
        restarted.dispose();
      }
    } finally {
      syncer.dispose();
      repo.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("indexes external CLI rollouts from any directory (including unadded projects) and notifies afterChange", async () => {
    const dir = await mkdtemp(join(tmpdir(), "codez-global-rollout-"));
    const codexHome = join(dir, ".codex");
    const dayDir = join(codexHome, "sessions", "2026", "10", "22");
    await mkdir(dayDir, { recursive: true });

    const sessionId = "019a0000-0000-7000-8000-000000000123";
    const rolloutPath = join(dayDir, `rollout-2026-10-22T08-00-00-${sessionId}.jsonl`);
    await writeFile(
      rolloutPath,
      [
        JSON.stringify({
          timestamp: "2026-10-22T08:00:00Z",
          type: "session_meta",
          payload: {
            meta: {
              id: sessionId,
              timestamp: "2026-10-22T08:00:00Z",
              cwd: "/remote/unadded-project",
              source: "cli",
              cli_version: "0.1.0",
            },
          },
        }),
        JSON.stringify({
          timestamp: "2026-10-22T08:00:01Z",
          type: "event_msg",
          payload: {
            type: "user_message",
            message: "你好",
          },
        }),
        JSON.stringify({
          timestamp: "2026-10-22T08:00:02Z",
          type: "event_msg",
          payload: {
            type: "task_complete",
          },
        }),
      ].join("\n") + "\n",
      "utf8",
    );

    const repo = new TaskIndexRepo(
      undefined,
      "remote:server:srv-1",
      join(dir, "tasks-index.sqlite"),
    );
    const afterChange = vi.fn();
    const syncer = createCodexGlobalRolloutSyncer({
      taskIndexRepo: repo,
      resolveWorkspaceIdentity: async (workspacePath) => `remote:ssh:host:22:dev:${workspacePath}`,
      afterChange,
      env: { CODEX_HOME: codexHome },
    });

    try {
      const changed = await syncer.syncNow();
      expect(changed).toBe(true);

      const projectRepo = await repo.getProjectRepository();
      const tree = projectRepo.readTree();
      expect(tree.tasks).toHaveLength(1);
      expect(tree.tasks[0]).toMatchObject({
        taskId: sessionId,
        title: "你好",
        workspacePath: "/remote/unadded-project",
        workspaceIdentity: "remote:ssh:host:22:dev:/remote/unadded-project",
        hostId: "remote:server:srv-1",
        projectId: null,
      });

      // Repeated sync without rollout change is a no-op
      expect(await syncer.syncNow()).toBe(false);
    } finally {
      syncer.dispose();
      repo.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("converges symlinked project roots and physical rollout cwds in both directions without UNIQUE conflicts", async () => {
    const dir = await mkdtemp(join(tmpdir(), "codez-global-rollout-symlink-"));
    const codexHome = join(dir, ".codex");
    const dayDir = join(codexHome, "sessions", "2026", "10", "22");
    const realDiskHome = join(dir, "back", "disk", "home", "jingjin");
    const realProjectDir = join(realDiskHome, "workspace", "hypervisor", "osx-ca");
    const linkHomeParent = join(dir, "home");
    const linkHome = join(linkHomeParent, "jingjin");
    const linkProjectDir = join(linkHome, "workspace", "hypervisor", "osx-ca");
    await mkdir(dayDir, { recursive: true });
    await mkdir(realProjectDir, { recursive: true });
    await mkdir(linkHomeParent, { recursive: true });
    await symlink(realDiskHome, linkHome);

    const physicalCwd = await realpath(realProjectDir);
    const sessionBeforeProject = "019a0000-0000-7000-8000-000000000201";
    const sessionAfterProject = "019a0000-0000-7000-8000-000000000202";
    const writeRollout = async (sessionId: string, text: string) => {
      const rolloutPath = join(dayDir, `rollout-2026-10-22T09-00-00-${sessionId}.jsonl`);
      await writeFile(
        rolloutPath,
        [
          JSON.stringify({
            timestamp: "2026-10-22T09:00:00Z",
            type: "session_meta",
            payload: {
              meta: {
                id: sessionId,
                timestamp: "2026-10-22T09:00:00Z",
                cwd: physicalCwd,
                source: "cli",
                cli_version: "0.1.0",
              },
            },
          }),
          JSON.stringify({
            timestamp: "2026-10-22T09:00:01Z",
            type: "event_msg",
            payload: {
              type: "user_message",
              message: text,
            },
          }),
          JSON.stringify({
            timestamp: "2026-10-22T09:00:02Z",
            type: "event_msg",
            payload: {
              type: "task_complete",
            },
          }),
        ].join("\n") + "\n",
        "utf8",
      );
    };

    await writeRollout(sessionBeforeProject, "先有物理路径 rollout");

    const hostId = "remote:server:moga";
    const repo = new TaskIndexRepo(undefined, hostId, join(dir, "tasks-index.sqlite"));
    const syncer = createCodexGlobalRolloutSyncer({
      taskIndexRepo: repo,
      resolveWorkspaceIdentity: async (workspacePath) =>
        `remote:ssh:moga:22:jingjin:${workspacePath}`,
      env: { CODEX_HOME: codexHome },
    });

    try {
      // 1) 启动时先扫描进物理路径 rollout（此时尚未创建软链接项目）
      await syncer.syncNow();
      const projectRepo = await repo.getProjectRepository();

      // 2) 用户通过软链接路径新建远端单目录项目
      const savedProject = projectRepo.saveProject({ roots: [linkProjectDir] });
      expect(savedProject.roots).toEqual([
        {
          rootPath: linkProjectDir,
          physicalPath: physicalCwd,
          position: 0,
          isPrimary: true,
        },
      ]);

      // 3) 桥发现路径随后用软链接路径拼写上报同一 sessionId：不应抛 UNIQUE 约束冲突，且保留原行身份并更新事实
      const updated = await repo.applyCliFacts({
        meta: {
          taskId: sessionBeforeProject,
          traceId: `trace-${sessionBeforeProject}`,
          title: "先有物理路径 rollout（桥刷新）",
          workspacePath: linkProjectDir,
          workspaceIdentity: `remote:ssh:moga:22:jingjin:${linkProjectDir}`,
          createdAt: 100,
          updatedAt: 200,
          mode: "default",
          provider: "glm",
          status: "completed",
        },
        titleSource: "default",
        lastOutcome: "completed",
      });
      expect(updated.workspacePath).toBe(physicalCwd);

      // 4) 项目已存在后，新增的物理路径 rollout 通过 uniqueRootProject 物理路径匹配自动归属到软链接项目
      await writeRollout(sessionAfterProject, "后有物理路径 rollout");
      await syncer.syncNow();

      const tree = projectRepo.readTree();
      const beforeTask = tree.tasks.find((t) => t.taskId === sessionBeforeProject);
      const afterTask = tree.tasks.find((t) => t.taskId === sessionAfterProject);
      expect(beforeTask).toMatchObject({
        taskId: sessionBeforeProject,
        workspacePath: physicalCwd,
        workspacePhysicalPath: physicalCwd,
        projectId: null,
      });
      expect(afterTask).toMatchObject({
        taskId: sessionAfterProject,
        workspacePath: physicalCwd,
        workspacePhysicalPath: physicalCwd,
        projectId: savedProject.id,
      });

      // 5) 远端打开这两个任务（无论 project_id=NULL 还是已归属到软链接项目）均不报错
      expect(
        projectRepo.resolveSessionDirectories({
          taskId: sessionBeforeProject,
          workspacePath: physicalCwd,
          workspaceIdentity: `remote:ssh:moga:22:jingjin:${physicalCwd}`,
        }),
      ).toEqual({
        workspacePath: physicalCwd,
        projectId: null,
        additionalDirectories: [],
      });
      expect(
        projectRepo.resolveSessionDirectories({
          taskId: sessionAfterProject,
          workspacePath: physicalCwd,
          workspaceIdentity: `remote:ssh:moga:22:jingjin:${physicalCwd}`,
        }),
      ).toEqual({
        workspacePath: physicalCwd,
        projectId: savedProject.id,
        additionalDirectories: [],
      });
    } finally {
      syncer.dispose();
      repo.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("reuses cached session_index.jsonl thread names across unchanged syncs and updates when index changes", async () => {
    const dir = await mkdtemp(join(tmpdir(), "codez-global-rollout-index-cache-"));
    const codexHome = join(dir, ".codex");
    const dayDir = join(codexHome, "sessions", "2026", "10", "24");
    await mkdir(dayDir, { recursive: true });

    const sessionId = "019a0000-0000-7000-8000-000000000999";
    const rolloutPath = join(dayDir, `rollout-2026-10-24T10-00-00-${sessionId}.jsonl`);
    const sessionIndexPath = join(codexHome, "session_index.jsonl");
    await writeFile(
      rolloutPath,
      [
        JSON.stringify({
          timestamp: "2026-10-24T10:00:00Z",
          type: "session_meta",
          payload: {
            meta: {
              id: sessionId,
              timestamp: "2026-10-24T10:00:00Z",
              cwd: "/remote/index-cache-project",
              source: "cli",
            },
          },
        }),
        JSON.stringify({
          timestamp: "2026-10-24T10:00:01Z",
          type: "event_msg",
          payload: { type: "user_message", message: "初始提问" },
        }),
      ].join("\n") + "\n",
      "utf8",
    );
    await writeFile(
      sessionIndexPath,
      `${JSON.stringify({ id: sessionId, thread_name: "命名一" })}\n`,
      "utf8",
    );

    const repo = new TaskIndexRepo(
      undefined,
      "remote:server:srv-1",
      join(dir, "tasks-index.sqlite"),
    );
    const target = {
      workspacePath: "/remote/index-cache-project",
      workspaceIdentity: "remote:ssh:host:22:dev:/remote/index-cache-project",
      taskId: sessionId,
    };
    const syncer = createCodexGlobalRolloutSyncer({
      taskIndexRepo: repo,
      resolveWorkspaceIdentity: async (workspacePath) => `remote:ssh:host:22:dev:${workspacePath}`,
      env: { CODEX_HOME: codexHome },
    });

    try {
      expect(await syncer.syncNow()).toBe(true);
      expect((await repo.getTaskMeta(target))?.title).toBe("命名一");

      // 无文件变化时再次 syncNow 为 no-op
      expect(await syncer.syncNow()).toBe(false);

      // 修改 session_index.jsonl（长度与 mtime 改变），即使 rollout 本身未变也应更新标题
      await writeFile(
        sessionIndexPath,
        `${JSON.stringify({ id: sessionId, thread_name: "更新后的命名二" })}\n`,
        "utf8",
      );
      expect(await syncer.syncNow()).toBe(true);
      expect((await repo.getTaskMeta(target))?.title).toBe("更新后的命名二");
    } finally {
      syncer.dispose();
      repo.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("reads head metadata and tail outcome from a rollout larger than 128 KiB without losing terminal status", async () => {
    const dir = await mkdtemp(join(tmpdir(), "codez-global-rollout-large-"));
    const codexHome = join(dir, ".codex");
    const dayDir = join(codexHome, "sessions", "2026", "10", "25");
    await mkdir(dayDir, { recursive: true });

    const sessionId = "019a0000-0000-7000-8000-000000001111";
    const rolloutPath = join(dayDir, `rollout-2026-10-25T10-00-00-${sessionId}.jsonl`);
    const fillerLine = JSON.stringify({
      timestamp: "2026-10-25T10:00:02Z",
      type: "response_item",
      payload: {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "x".repeat(4096) }],
      },
    });
    const lines = [
      JSON.stringify({
        timestamp: "2026-10-25T10:00:00Z",
        type: "session_meta",
        payload: {
          meta: {
            id: sessionId,
            timestamp: "2026-10-25T10:00:00Z",
            cwd: "/remote/large-rollout-project",
            source: "cli",
          },
        },
      }),
      JSON.stringify({
        timestamp: "2026-10-25T10:00:01Z",
        type: "event_msg",
        payload: { type: "user_message", message: "超长会话标题验证" },
      }),
      // 填充 > 200 KiB 的中间正文，确保尾部事件落在 128 KiB head 窗口之外
      ...Array.from({ length: 55 }, () => fillerLine),
      JSON.stringify({
        timestamp: "2026-10-25T10:05:00Z",
        type: "event_msg",
        payload: { type: "error" },
      }),
    ];
    await writeFile(rolloutPath, `${lines.join("\n")}\n`, "utf8");

    const repo = new TaskIndexRepo(
      undefined,
      "remote:server:srv-1",
      join(dir, "tasks-index.sqlite"),
    );
    const target = {
      workspacePath: "/remote/large-rollout-project",
      workspaceIdentity: "remote:ssh:host:22:dev:/remote/large-rollout-project",
      taskId: sessionId,
    };
    const syncer = createCodexGlobalRolloutSyncer({
      taskIndexRepo: repo,
      resolveWorkspaceIdentity: async (workspacePath) => `remote:ssh:host:22:dev:${workspacePath}`,
      env: { CODEX_HOME: codexHome },
    });

    try {
      expect(await syncer.syncNow()).toBe(true);
      const meta = await repo.getTaskMeta(target);
      expect(meta?.title).toBe("超长会话标题验证");
      expect(meta?.status).toBe("error");
    } finally {
      syncer.dispose();
      repo.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("keeps an unchanged re-sync off the historical rollout tree", async () => {
    const dir = await mkdtemp(join(tmpdir(), "codez-global-rollout-idle-"));
    const codexHome = join(dir, ".codex");
    const DAY_COUNT = 3;
    const HISTORY_COUNT = 60;
    const dayDirs = Array.from({ length: DAY_COUNT }, (_, index) =>
      join(codexHome, "sessions", "2026", "10", String(index + 1).padStart(2, "0")),
    );
    await Promise.all(dayDirs.map((path) => mkdir(path, { recursive: true })));
    await writeRollouts(
      Array.from({ length: HISTORY_COUNT }, (_, index) => ({
        dir: dayDirs[index % DAY_COUNT]!,
        stamp: rolloutStamp((index % DAY_COUNT) + 1, index),
        sessionId: rolloutSessionId(index),
        title: `历史会话 ${index}`,
      })),
    );
    const store = createFakeTaskStore();
    const syncer = createCodexGlobalRolloutSyncer({
      taskIndexRepo: store,
      env: { CODEX_HOME: codexHome },
    });
    try {
      expect(await syncer.syncNow()).toBe(true);
      expect(store.applyCliFacts).toHaveBeenCalledTimes(HISTORY_COUNT);

      store.applyCliFacts.mockClear();
      store.getTaskMeta.mockClear();
      clearIoCounters();

      // 无变化时的重复同步（等价于 readTree/readProjects 的 catch-up）：
      // 目录 mtime 未变 → 不再 readdir 任何历史日期目录，也不再解析任何历史 rollout。
      expect(await syncer.syncNow()).toBe(false);
      expect(io.readdir).not.toHaveBeenCalled();
      expect(io.open).not.toHaveBeenCalled();
      expect(store.applyCliFacts).not.toHaveBeenCalled();
      expect(store.getTaskMeta).not.toHaveBeenCalled();
      // stat 只覆盖目录（1 root + 1 年 + 1 月 + 3 天 = 6）、session_index.jsonl（1）
      // 与活跃尾部窗口（≤ 8），远小于历史文件数。
      expect(io.stat.mock.calls.length).toBeLessThanOrEqual(6 + 1 + 8);
      expect(io.stat.mock.calls.length).toBeLessThan(HISTORY_COUNT);
    } finally {
      syncer.dispose();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("syncs only the single new session among thousands of historical rollouts", async () => {
    const dir = await mkdtemp(join(tmpdir(), "codez-global-rollout-scale-"));
    const codexHome = join(dir, ".codex");
    const DAY_COUNT = 20;
    const PER_DAY = 100;
    const HISTORY_COUNT = DAY_COUNT * PER_DAY;
    const dayDirs = Array.from({ length: DAY_COUNT }, (_, index) =>
      join(codexHome, "sessions", "2026", "10", String(index + 1).padStart(2, "0")),
    );
    await Promise.all(dayDirs.map((path) => mkdir(path, { recursive: true })));
    await writeRollouts(
      Array.from({ length: HISTORY_COUNT }, (_, index) => {
        const day = Math.floor(index / PER_DAY);
        return {
          dir: dayDirs[day]!,
          stamp: rolloutStamp(day + 1, index % PER_DAY),
          sessionId: rolloutSessionId(index),
          title: `历史会话 ${index}`,
        };
      }),
    );
    const store = createFakeTaskStore();
    const syncer = createCodexGlobalRolloutSyncer({
      taskIndexRepo: store,
      env: { CODEX_HOME: codexHome },
    });
    try {
      expect(await syncer.syncNow()).toBe(true);
      expect(store.applyCliFacts).toHaveBeenCalledTimes(HISTORY_COUNT);

      store.applyCliFacts.mockClear();
      store.getTaskMeta.mockClear();
      clearIoCounters();

      // 2000 个历史 rollout 中只新增 1 个 session（落在已存在的日期目录里）。
      const newSessionId = rolloutSessionId(HISTORY_COUNT);
      await writeRollout(
        dayDirs[DAY_COUNT - 1]!,
        rolloutStamp(DAY_COUNT, PER_DAY),
        newSessionId,
        "唯一新增的会话",
      );

      expect(await syncer.syncNow()).toBe(true);
      // 处理量接近单个 session：只写这一个任务，历史 2000 个会话既不读也不写。
      expect(store.applyCliFacts).toHaveBeenCalledTimes(1);
      expect(store.applyCliFacts.mock.calls[0]?.[0].meta.taskId).toBe(newSessionId);
      expect(store.getTaskMeta).toHaveBeenCalledTimes(1);
      // 只解析新增文件；只有它所在日期目录的 mtime 变化，因此只 readdir 这一个目录。
      expect(io.open).toHaveBeenCalledTimes(1);
      expect(io.readdir).toHaveBeenCalledTimes(1);
      // stat = 目录（1 root + 1 年 + 1 月 + 20 天）+ index（1）+ 新增文件（1）+ 活跃尾部（≤8）
      expect(io.stat.mock.calls.length).toBeLessThanOrEqual(23 + 1 + 1 + 8);
      expect(io.stat.mock.calls.length).toBeLessThan(HISTORY_COUNT);
    } finally {
      syncer.dispose();
      await rm(dir, { recursive: true, force: true });
    }
  }, 60_000);

  it("updates only the renamed session when session_index.jsonl changes one title", async () => {
    const dir = await mkdtemp(join(tmpdir(), "codez-global-rollout-rename-"));
    const codexHome = join(dir, ".codex");
    const DAY_COUNT = 2;
    const PER_DAY = 15;
    const HISTORY_COUNT = DAY_COUNT * PER_DAY;
    const dayDirs = Array.from({ length: DAY_COUNT }, (_, index) =>
      join(codexHome, "sessions", "2026", "10", String(index + 1).padStart(2, "0")),
    );
    await Promise.all(dayDirs.map((path) => mkdir(path, { recursive: true })));
    await writeRollouts(
      Array.from({ length: HISTORY_COUNT }, (_, index) => {
        const day = Math.floor(index / PER_DAY);
        return {
          dir: dayDirs[day]!,
          stamp: rolloutStamp(day + 1, index % PER_DAY),
          sessionId: rolloutSessionId(index),
          title: `历史会话 ${index}`,
        };
      }),
    );
    const sessionIndexPath = join(codexHome, "session_index.jsonl");
    const renderIndex = (names: string[]) =>
      names
        .map((name, index) => JSON.stringify({ id: rolloutSessionId(index), thread_name: name }))
        .join("\n") + "\n";
    const baseNames = Array.from({ length: HISTORY_COUNT }, (_, index) => `命名 ${index}`);
    await writeFile(sessionIndexPath, renderIndex(baseNames), "utf8");

    const store = createFakeTaskStore();
    const syncer = createCodexGlobalRolloutSyncer({
      taskIndexRepo: store,
      env: { CODEX_HOME: codexHome },
    });
    try {
      expect(await syncer.syncNow()).toBe(true);
      expect(store.applyCliFacts).toHaveBeenCalledTimes(HISTORY_COUNT);

      store.applyCliFacts.mockClear();
      store.getTaskMeta.mockClear();
      clearIoCounters();

      // 只改 1 个 thread_name：index 变化不再触发全量扫描，也不再放大成全部任务的写事务。
      const renamedIndex = 7;
      const renamedSessionId = rolloutSessionId(renamedIndex);
      await writeFile(
        sessionIndexPath,
        renderIndex(
          baseNames.map((name, index) => (index === renamedIndex ? "改名后的命名" : name)),
        ),
        "utf8",
      );

      expect(await syncer.syncNow()).toBe(true);
      expect(store.applyCliFacts).toHaveBeenCalledTimes(1);
      expect(store.applyCliFacts.mock.calls[0]?.[0].meta.taskId).toBe(renamedSessionId);
      expect(store.applyCliFacts.mock.calls[0]?.[0].meta.title).toBe("改名后的命名");
      expect(store.getTaskMeta).toHaveBeenCalledTimes(1);
      // 改名不需要重新解析任何 rollout，也不需要重新遍历 sessions 目录。
      expect(io.open).not.toHaveBeenCalled();
      expect(io.readdir).not.toHaveBeenCalled();
    } finally {
      syncer.dispose();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("skips the sessions tree walk entirely while the recursive watcher is healthy", async () => {
    const dir = await mkdtemp(join(tmpdir(), "codez-global-rollout-watcher-"));
    const codexHome = join(dir, ".codex");
    const dayDir = join(codexHome, "sessions", "2026", "10", "01");
    await mkdir(dayDir, { recursive: true });
    const HISTORY_COUNT = 12;
    await writeRollouts(
      Array.from({ length: HISTORY_COUNT }, (_, index) => ({
        dir: dayDir,
        stamp: rolloutStamp(1, index),
        sessionId: rolloutSessionId(index),
        title: `历史会话 ${index}`,
      })),
    );
    const store = createFakeTaskStore();
    const syncer = createCodexGlobalRolloutSyncer({
      taskIndexRepo: store,
      env: { CODEX_HOME: codexHome },
    });
    try {
      syncer.start();
      // start() 内部先建立 watcher 再跑基线扫描，这里等它落定。
      await syncer.syncNow();
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(store.applyCliFacts).toHaveBeenCalledTimes(HISTORY_COUNT);

      store.applyCliFacts.mockClear();
      store.getTaskMeta.mockClear();
      clearIoCounters();

      // watcher 健康且没有 pending 事件时，普通读取只需 stat 一次 session_index.jsonl。
      expect(await syncer.syncNow()).toBe(false);
      expect(io.readdir).not.toHaveBeenCalled();
      expect(io.open).not.toHaveBeenCalled();
      expect(io.stat.mock.calls.length).toBeLessThanOrEqual(2);
      expect(store.applyCliFacts).not.toHaveBeenCalled();
    } finally {
      syncer.dispose();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("prunes deleted rollout directories from the incremental cache", async () => {
    const dir = await mkdtemp(join(tmpdir(), "codez-global-rollout-watcher-"));
    const codexHome = join(dir, ".codex");
    const DAY_COUNT = 2;
    const PER_DAY = 3;
    const HISTORY_COUNT = DAY_COUNT * PER_DAY;
    const dayDirs = Array.from({ length: DAY_COUNT }, (_, index) =>
      join(codexHome, "sessions", "2026", "10", String(index + 1).padStart(2, "0")),
    );
    await Promise.all(dayDirs.map((path) => mkdir(path, { recursive: true })));
    await writeRollouts(
      Array.from({ length: HISTORY_COUNT }, (_, index) => {
        const day = Math.floor(index / PER_DAY);
        return {
          dir: dayDirs[day]!,
          stamp: rolloutStamp(day + 1, index % PER_DAY),
          sessionId: rolloutSessionId(index),
          title: `历史会话 ${index}`,
        };
      }),
    );
    const store = createFakeTaskStore();
    const syncer = createCodexGlobalRolloutSyncer({
      taskIndexRepo: store,
      env: { CODEX_HOME: codexHome },
    });
    try {
      expect(await syncer.syncNow()).toBe(true);
      expect(store.applyCliFacts).toHaveBeenCalledTimes(HISTORY_COUNT);

      store.applyCliFacts.mockClear();
      store.getTaskMeta.mockClear();
      clearIoCounters();

      // 整个日期目录被删除：父目录 mtime 变化，只需重读父目录并清理该子树的缓存，
      // 不能因此把存活会话当成新事实重复写库。
      await rm(dayDirs[DAY_COUNT - 1]!, { recursive: true, force: true });
      expect(await syncer.syncNow()).toBe(false);
      expect(store.applyCliFacts).not.toHaveBeenCalled();
      expect(io.readdir.mock.calls.length).toBeLessThanOrEqual(2);

      store.applyCliFacts.mockClear();
      store.getTaskMeta.mockClear();
      clearIoCounters();

      // 清理后存活目录仍可增量发现新会话，且只解析这一个文件。
      const newSessionId = rolloutSessionId(HISTORY_COUNT);
      await writeRollout(dayDirs[0]!, rolloutStamp(1, PER_DAY), newSessionId, "删除后新增的会话");
      expect(await syncer.syncNow()).toBe(true);
      expect(store.applyCliFacts).toHaveBeenCalledTimes(1);
      expect(store.applyCliFacts.mock.calls[0]?.[0].meta.taskId).toBe(newSessionId);
      expect(io.open).toHaveBeenCalledTimes(1);
    } finally {
      syncer.dispose();
      await rm(dir, { recursive: true, force: true });
    }
  });
});

/**
 * 持久化解析事实缓存（`codexRolloutScanCache`）的回归边界。
 *
 * 核心不变量有两条，缺一不可：
 * 1. 未变化的历史 rollout 跨进程不再被 open/解析（否则启动成本仍随历史线性增长）；
 * 2. 缓存绝不携带「是否已入库」，入库状态每次启动都重新与 tasks-index 对账
 *    （否则缓存与库不一致时会话会永久从侧栏消失，即 issue #19/#24 的故障类）。
 */
describe("createCodexGlobalRolloutSyncer durable scan cache", () => {
  const HISTORY_COUNT = 6;

  async function seedRollouts(codexHome: string, count: number, offset = 0): Promise<string[]> {
    const dayDirs = [
      join(codexHome, "sessions", "2026", "10", "21"),
      join(codexHome, "sessions", "2026", "10", "22"),
    ];
    await Promise.all(dayDirs.map((path) => mkdir(path, { recursive: true })));
    const paths: string[] = [];
    await writeRollouts(
      Array.from({ length: count }, (_, index) => {
        const sequence = offset + index;
        const path = join(
          dayDirs[index % dayDirs.length]!,
          `rollout-${rolloutStamp((index % 2) + 21, sequence)}-${rolloutSessionId(sequence)}.jsonl`,
        );
        paths.push(path);
        return {
          dir: dayDirs[index % dayDirs.length]!,
          stamp: rolloutStamp((index % 2) + 21, sequence),
          sessionId: rolloutSessionId(sequence),
          title: `缓存会话 ${sequence}`,
        };
      }),
    );
    return paths;
  }

  function createSyncer(store: CodexGlobalRolloutTaskStore, codexHome: string, cachePath?: string) {
    return createCodexGlobalRolloutSyncer({
      taskIndexRepo: store,
      env: { CODEX_HOME: codexHome },
      ...(cachePath ? { scanCacheFilePath: cachePath } : {}),
    });
  }

  it("makes a fresh process stat-only while still reconciling every session against the index", async () => {
    const dir = await mkdtemp(join(tmpdir(), "codez-rollout-cache-warm-"));
    const codexHome = join(dir, ".codex");
    const cachePath = join(dir, "codex-rollout-scan-cache.json");
    await seedRollouts(codexHome, HISTORY_COUNT);
    const store = createFakeTaskStore();
    const cold = createSyncer(store, codexHome, cachePath);
    try {
      expect(await cold.syncNow()).toBe(true);
      expect(store.applyCliFacts).toHaveBeenCalledTimes(HISTORY_COUNT);
      // 冷启动逐个解析历史 rollout；落盘缓存还会额外打开一次文件锁，故用下界断言。
      expect(io.open.mock.calls.length).toBeGreaterThanOrEqual(HISTORY_COUNT);
    } finally {
      cold.dispose();
    }

    // 等价于进程重启：新实例、内存缓存为空，只有磁盘上的解析事实可复用。
    store.applyCliFacts.mockClear();
    store.getTaskMeta.mockClear();
    clearIoCounters();
    const warm = createSyncer(store, codexHome, cachePath);
    try {
      expect(await warm.syncNow()).toBe(false);
      // 未变化的历史 rollout 一次都不 open，即零次 head/tail 解析。
      expect(io.open).not.toHaveBeenCalled();
      // 整树遍历与逐文件 stat 仍然发生：基线扫描没有被跳过，只是不再解析。
      expect(io.stat.mock.calls.length).toBeGreaterThanOrEqual(HISTORY_COUNT);
      // 自愈兜底完整保留：每个会话仍逐个与 tasks-index 对账，只是事实一致因而不写。
      expect(store.getTaskMeta).toHaveBeenCalledTimes(HISTORY_COUNT);
      expect(store.applyCliFacts).not.toHaveBeenCalled();
      expect(store.rows.size).toBe(HISTORY_COUNT);
    } finally {
      warm.dispose();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("never trusts a persisted synced flag, so a rebuilt index still gets every session", async () => {
    const dir = await mkdtemp(join(tmpdir(), "codez-rollout-cache-synced-"));
    const codexHome = join(dir, ".codex");
    const cachePath = join(dir, "codex-rollout-scan-cache.json");
    await seedRollouts(codexHome, 4);
    const seedingStore = createFakeTaskStore();
    const seeding = createSyncer(seedingStore, codexHome, cachePath);
    try {
      expect(await seeding.syncNow()).toBe(true);
    } finally {
      seeding.dispose();
    }

    // 人为把缓存里每条都标成已入库：模拟未来误加该字段、旧版本文件或缓存被篡改。
    const raw = JSON.parse(await readFile(cachePath, "utf8")) as {
      entries: Array<Record<string, unknown>>;
    };
    expect(raw.entries.length).toBe(4);
    for (const entry of raw.entries) entry.synced = true;
    await writeFile(cachePath, JSON.stringify(raw), "utf8");

    // 全新的空库：若缓存里的 synced 被采信，consider() 会永久跳过这些文件，
    // 会话再也不会出现在侧栏（issue #19/#24）。
    const store = createFakeTaskStore();
    clearIoCounters();
    const warm = createSyncer(store, codexHome, cachePath);
    try {
      expect(await warm.syncNow()).toBe(true);
      expect(io.open).not.toHaveBeenCalled();
      expect(store.applyCliFacts).toHaveBeenCalledTimes(4);
      expect([...store.rows.keys()].sort()).toEqual([0, 1, 2, 3].map(rolloutSessionId).sort());
    } finally {
      warm.dispose();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("fails open to a full parse when the cache file is corrupt", async () => {
    const dir = await mkdtemp(join(tmpdir(), "codez-rollout-cache-corrupt-"));
    const codexHome = join(dir, ".codex");
    const cachePath = join(dir, "codex-rollout-scan-cache.json");
    await seedRollouts(codexHome, 4);
    await writeFile(cachePath, '{"version":1,"codexHome":"截断的半份内容', "utf8");
    const store = createFakeTaskStore();
    const syncer = createSyncer(store, codexHome, cachePath);
    try {
      expect(await syncer.syncNow()).toBe(true);
      const parsedRollouts = io.open.mock.calls
        .map((call) => call[0])
        .filter(
          (target): target is string => typeof target === "string" && target.endsWith(".jsonl"),
        );
      expect(parsedRollouts.length).toBe(4);
      expect(store.applyCliFacts).toHaveBeenCalledTimes(4);
    } finally {
      syncer.dispose();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("ignores a cache written for a different CODEX_HOME", async () => {
    const dir = await mkdtemp(join(tmpdir(), "codez-rollout-cache-scope-"));
    const homeA = join(dir, ".codex-a");
    const homeB = join(dir, ".codex-b");
    const cachePath = join(dir, "codex-rollout-scan-cache.json");
    await seedRollouts(homeA, 3, 0);
    await seedRollouts(homeB, 2, 100);
    const storeA = createFakeTaskStore();
    const syncerA = createSyncer(storeA, homeA, cachePath);
    try {
      expect(await syncerA.syncNow()).toBe(true);
    } finally {
      syncerA.dispose();
    }

    // 换 $CODEX_HOME（含 CI / native smoke 每次覆盖）后必须整份忽略：
    // 缓存里的绝对路径属于另一个 profile，采信就会把别的会话写进当前 Host 的库。
    const storeB = createFakeTaskStore();
    clearIoCounters();
    const syncerB = createSyncer(storeB, homeB, cachePath);
    try {
      expect(await syncerB.syncNow()).toBe(true);
      const parsedRollouts = io.open.mock.calls
        .map((call) => call[0])
        .filter(
          (target): target is string => typeof target === "string" && target.endsWith(".jsonl"),
        );
      expect(parsedRollouts.length).toBe(2);
      expect(parsedRollouts.every((path) => path.startsWith(homeB))).toBe(true);
      expect(storeB.applyCliFacts).toHaveBeenCalledTimes(2);
      for (const index of [0, 1, 2]) expect(storeB.rows.has(rolloutSessionId(index))).toBe(false);
      for (const index of [100, 101]) expect(storeB.rows.has(rolloutSessionId(index))).toBe(true);
    } finally {
      syncerB.dispose();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("re-parses only the rollout that changed while the app was closed", async () => {
    const dir = await mkdtemp(join(tmpdir(), "codez-rollout-cache-append-"));
    const codexHome = join(dir, ".codex");
    const cachePath = join(dir, "codex-rollout-scan-cache.json");
    const paths = await seedRollouts(codexHome, 4);
    const store = createFakeTaskStore();
    const cold = createSyncer(store, codexHome, cachePath);
    try {
      expect(await cold.syncNow()).toBe(true);
    } finally {
      cold.dispose();
    }

    // CLI 在应用关闭期间继续追加：size/mtime 变化必须让这一个文件重新解析，
    // 其余历史文件仍然零解析（这正是不能只按「库里有行」跳过的原因）。
    const appended = paths[1]!;
    await appendFile(
      appended,
      `${JSON.stringify({ type: "event_msg", payload: { type: "error" } })}\n`,
      "utf8",
    );
    store.applyCliFacts.mockClear();
    clearIoCounters();
    const warm = createSyncer(store, codexHome, cachePath);
    try {
      expect(await warm.syncNow()).toBe(true);
      // 只统计 rollout 解析：缓存落盘还会打开一次文件锁，不能混进解析次数。
      const parsedRollouts = io.open.mock.calls
        .map((call) => call[0])
        .filter(
          (target): target is string => typeof target === "string" && target.endsWith(".jsonl"),
        );
      expect(parsedRollouts).toEqual([appended]);
      expect(store.applyCliFacts).toHaveBeenCalledTimes(1);
      const call = store.applyCliFacts.mock.calls[0]?.[0];
      expect(call?.meta.taskId).toBe(rolloutSessionId(1));
      expect(call?.lastOutcome).toBe("error");
    } finally {
      warm.dispose();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("prunes a rollout deleted while the app was closed out of the durable cache", async () => {
    const dir = await mkdtemp(join(tmpdir(), "codez-rollout-cache-delete-"));
    const codexHome = join(dir, ".codex");
    const cachePath = join(dir, "codex-rollout-scan-cache.json");
    const paths = await seedRollouts(codexHome, 3);
    const store = createFakeTaskStore();
    const cold = createSyncer(store, codexHome, cachePath);
    try {
      expect(await cold.syncNow()).toBe(true);
    } finally {
      cold.dispose();
    }

    await rm(paths[0]!, { force: true });
    clearIoCounters();
    const warm = createSyncer(store, codexHome, cachePath);
    try {
      await warm.syncNow();
      const raw = JSON.parse(await readFile(cachePath, "utf8")) as {
        entries: Array<{ path: string }>;
      };
      // 基线遍历覆盖整棵树，已消失的路径必须被摘除，否则缓存会随时间无界增长。
      expect(raw.entries.map((entry) => entry.path)).not.toContain(paths[0]);
      expect(raw.entries.length).toBe(2);
      expect(store.rows.size).toBe(3);
    } finally {
      warm.dispose();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("does not rewrite the cache file when nothing changed", async () => {
    const dir = await mkdtemp(join(tmpdir(), "codez-rollout-cache-idle-"));
    const codexHome = join(dir, ".codex");
    const cachePath = join(dir, "codex-rollout-scan-cache.json");
    await seedRollouts(codexHome, 3);
    const store = createFakeTaskStore();
    const syncer = createSyncer(store, codexHome, cachePath);
    try {
      expect(await syncer.syncNow()).toBe(true);
      expect(await readFile(cachePath, "utf8")).toContain("缓存会话 0");
      await rm(cachePath, { force: true });
      // 无变化的重复同步（readTree/readProjects 的 catch-up）不得重新落盘整份缓存，
      // 否则活跃追加期间会把「启动少解析」换成「每轮重写数百 KB」。
      expect(await syncer.syncNow()).toBe(false);
      await expect(readFile(cachePath, "utf8")).rejects.toThrow();
    } finally {
      syncer.dispose();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("keeps the cache inside the Codez data root and never inside CODEX_HOME", async () => {
    const dir = await mkdtemp(join(tmpdir(), "codez-rollout-cache-location-"));
    const codexHome = join(dir, ".codex");
    const cachePath = join(dir, "codex-rollout-scan-cache.json");
    await seedRollouts(codexHome, 2);
    // 生产路径由 paths.ts 统一给出，必须落在 Codez 数据目录下。
    expect(getCodexRolloutScanCachePath()).toContain(".codez");
    expect(getCodexRolloutScanCachePath().endsWith("codex-rollout-scan-cache.json")).toBe(true);
    const store = createFakeTaskStore();
    const syncer = createSyncer(store, codexHome, cachePath);
    try {
      expect(await syncer.syncNow()).toBe(true);
      // 原生历史与配置只读：$CODEX_HOME 下除 sessions 与 session_index.jsonl 外不得多出任何文件。
      const entries = (await readdir(codexHome)).sort();
      expect(
        entries.filter((name) => name !== "sessions" && name !== "session_index.jsonl"),
      ).toEqual([]);
    } finally {
      syncer.dispose();
      await rm(dir, { recursive: true, force: true });
    }
  });
});
