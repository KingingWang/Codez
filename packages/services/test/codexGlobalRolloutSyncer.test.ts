import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createCodexGlobalRolloutSyncer } from "../src/project/index.js";
import { TaskIndexRepo } from "../src/session/taskIndexRepo.js";

describe("createCodexGlobalRolloutSyncer", () => {
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
});
