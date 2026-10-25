import { appendFile, mkdtemp, mkdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it, vi } from "vitest";
import { createCodexGlobalRolloutSyncer } from "../src/project/index.js";
import { TaskIndexRepo } from "../src/session/taskIndexRepo.js";

describe("createCodexGlobalRolloutSyncer", () => {
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
          payload: { meta: { id: sessionId, cwd: workspacePath, source: "cli" } },
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
            item: { type: "UserMessage", content: [{ type: "text", text: "排查远端标题切换" }] },
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
          payload: { meta: { id: sessionId, cwd: workspacePath, source: "appServer" } },
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
});
