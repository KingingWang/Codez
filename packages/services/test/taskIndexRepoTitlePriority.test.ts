import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { TaskIndexRepo } from "../src/session/taskIndexRepo.js";

describe("TaskIndexRepo title priority", () => {
  it("keeps a real title when a later non-custom placeholder arrives", async () => {
    const dir = await mkdtemp(join(tmpdir(), "codez-task-title-priority-"));
    const repo = new TaskIndexRepo(undefined, undefined, join(dir, "tasks-index.sqlite"));
    const meta = {
      taskId: "title-priority",
      traceId: "title-priority",
      title: "真实问题",
      workspacePath: "/project",
      createdAt: 1,
      updatedAt: 2,
      mode: "default",
      provider: "glm",
    };
    try {
      await repo.applyCliFacts({ meta, titleSource: "default" });
      for (const [title, updatedAt] of [
        ["", 3],
        ["New session", 4],
        ["<environment_context><cwd>/project</cwd></environment_context>", 5],
        ["# AGENTS.md instructions for /project\n\n<INSTRUCTIONS>\n规则\n</INSTRUCTIONS>", 6],
      ] as const) {
        await repo.applyCliFacts({
          meta: { ...meta, title, updatedAt },
          titleSource: "default",
        });
        expect(await repo.getTaskMeta(meta)).toMatchObject({
          title: "真实问题",
          updatedAt,
        });
      }
      await repo.applyCliFacts({
        meta: { ...meta, title: "生成标题", updatedAt: 7 },
        titleSource: "generated",
      });
      expect((await repo.getTaskMeta(meta))?.title).toBe("生成标题");

      await repo.applyCliFacts({
        meta: { ...meta, title: "手动标题", updatedAt: 8 },
        titleSource: "custom",
      });
      await repo.applyCliFacts({
        meta: { ...meta, title: "真实问题", updatedAt: 9 },
        titleSource: "default",
      });
      expect((await repo.getTaskMeta(meta))?.title).toBe("手动标题");
    } finally {
      repo.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
});
