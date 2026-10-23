import { describe, expect, it } from "vitest";
import type { ProjectTask, ProjectTree } from "@/project-sidebar/contract.js";
import {
  countProjectTreeUnreadTasks,
  selectProjectRows,
  visibleSidebarTaskTree,
} from "@/project-sidebar/view.js";

const task = (id: string, overrides: Partial<ProjectTask> = {}): ProjectTask => ({
  taskId: id,
  projectId: "p1",
  hostId: "local",
  pinned: false,
  archived: false,
  workspacePath: "/repo",
  title: id,
  mode: "build",
  traceId: id,
  createdAt: 1,
  updatedAt: 1,
  ...overrides,
});

const project = (id: string, hostId: string, deleted = false): VirtualProject => ({
  id,
  hostId,
  name: id,
  nameOverridden: false,
  roots: [],
  position: 0,
  pinned: false,
  deleted,
});

const tree = (
  tasks: ProjectTask[],
  projects: VirtualProject[] = [project("p1", "local")],
): ProjectTree => ({ projects, tasks });

describe("countProjectTreeUnreadTasks", () => {
  it("只统计非归档且有 unreadAt 的任务", () => {
    expect(
      countProjectTreeUnreadTasks(
        tree([
          task("a", { unreadAt: 100 }),
          task("b", { unreadAt: undefined }),
          task("c", { unreadAt: 300, archived: true }),
        ]),
      ),
    ).toBe(1);
  });

  it("按 host+workspace+task 去重：不同 host 的同名任务分别计数", () => {
    expect(
      countProjectTreeUnreadTasks(
        tree(
          [
            task("a", { unreadAt: 100 }),
            task("b", { unreadAt: 200 }),
            // 本地与远端主机的同路径同名任务在树里是不同实例，分别计数
            task("a", { unreadAt: 300, hostId: "remote:server" }),
          ],
          [project("p1", "local"), project("p1", "remote:server")],
        ),
      ),
    ).toBe(3);
  });

  it("空树计 0", () => {
    expect(countProjectTreeUnreadTasks(tree([]))).toBe(0);
  });

  it("孤儿任务（项目不存在）不计入：没有蓝点落点的未读不产生幽灵提醒", () => {
    expect(
      countProjectTreeUnreadTasks(tree([task("orphan", { unreadAt: 100, projectId: "ghost" })])),
    ).toBe(0);
  });

  it("软删项目的未读不计入（侧边栏不渲染已删项目）", () => {
    expect(
      countProjectTreeUnreadTasks(
        tree(
          [task("a", { unreadAt: 100 }), task("ghost", { unreadAt: 200, projectId: "p-deleted" })],
          [project("p1", "local"), project("p-deleted", "local", true)],
        ),
      ),
    ).toBe(1);
  });

  it("置顶任务跨项目可见：软删项目的置顶未读仍计入", () => {
    expect(
      countProjectTreeUnreadTasks(
        tree(
          [task("pinned", { unreadAt: 100, pinned: true, projectId: "p-deleted" })],
          [project("p1", "local"), project("p-deleted", "local", true)],
        ),
      ),
    ).toBe(1);
  });

  it("本地无项目任务（projectId null + host local）计入", () => {
    expect(
      countProjectTreeUnreadTasks(tree([task("local-task", { unreadAt: 100, projectId: null })])),
    ).toBe(1);
  });

  it("远端单 root 项目可见的未归属任务（projectId null + matching workspaceIdentity）计入", () => {
    expect(
      countProjectTreeUnreadTasks(
        tree(
          [
            task("remote-history", {
              unreadAt: 100,
              projectId: null,
              hostId: "remote:server:s",
              workspacePath: "/repo",
              workspaceIdentity: "remote:server:s:/repo",
            }),
          ],
          [
            {
              ...project("p-remote", "remote:server:s"),
              roots: [{ rootPath: "/repo", position: 0, isPrimary: true }],
            },
          ],
        ),
      ),
    ).toBe(1);
  });
});

describe("visibleSidebarTaskTree", () => {
  it("hides only untitled or injected-context rows across sidebar views without removing facts", () => {
    const facts = tree([
      task("blank", { title: "", unreadAt: 1 }),
      task("whitespace", { title: " \n " }),
      task("native-placeholder", { title: "New session" }),
      task("environment", { title: "<environment_context> <cwd>/repo</cwd>" }),
      task("agents-instructions", {
        title: "# AGENTS.md instructions for /repo\n\n<INSTRUCTIONS>\n规则\n</INSTRUCTIONS>",
      }),
      task("manual-context", {
        title: "<environment_context> <cwd>/repo</cwd>",
        titleOverridden: true,
      }),
      task("manual-new-task", { title: "新任务", titleOverridden: true, pinned: true }),
      task("real", { title: "真实问题" }),
    ]);
    const visible = visibleSidebarTaskTree(facts);
    expect(visible.tasks.map((item) => item.taskId)).toEqual([
      "manual-context",
      "manual-new-task",
      "real",
    ]);
    expect(facts.tasks).toHaveLength(8);
    expect(countProjectTreeUnreadTasks(visible)).toBe(0);
    expect(selectProjectRows(visible, { kind: "pinned" }).map((item) => item.taskId)).toEqual([
      "manual-new-task",
    ]);
    expect(selectProjectRows(visible, { kind: "timeline" }).map((item) => item.taskId)).toEqual([
      "real",
      "manual-new-task",
      "manual-context",
    ]);
    expect(
      selectProjectRows(visible, { kind: "project", projectId: "p1" }).map((item) => item.taskId),
    ).toEqual(["real", "manual-context"]);
  });
});
