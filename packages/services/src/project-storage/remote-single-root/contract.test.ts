import { describe, expect, it } from "vitest";
import { fixture, port } from "#src/project-storage/test-fixture.js";

const hostId = "remote:server:single-root";
async function remoteFixture() {
  const fixtureState = await fixture();
  await port.migrate(fixtureState.db, { ...fixtureState.context, hostId });
  return { ...fixtureState, repo: port.repository(fixtureState.db, hostId) };
}

describe("remote project single-root authority", () => {
  it("requires exactly one immutable root while allowing metadata and restore", async () => {
    const { repo } = await remoteFixture();
    for (const roots of [[], ["/a", "/b"]])
      expect(() => repo.saveProject({ roots })).toThrow("project.remote-single-root-required");
    expect(repo.readTree().projects).toEqual([]);
    const project = repo.saveProject({ roots: ["/a"] });
    for (const roots of [[], ["/b"], ["/a", "/b"]]) {
      expect(() => repo.saveProject({ id: project.id, roots })).toThrow();
      expect(repo.readTree().projects[0]?.roots).toEqual(project.roots);
    }
    expect(repo.saveProject({ id: project.id, name: "Renamed", pinned: true })).toMatchObject({
      id: project.id,
      name: "Renamed",
      pinned: true,
      roots: project.roots,
    });
    repo.deleteProject(project.id);
    expect(repo.saveProject({ restoreProjectId: project.id, roots: ["/a"] }).id).toBe(project.id);
  });

  it("rejects unclassified, foreign-root and extra-directory admission without inserting rows", async () => {
    const { repo, db } = await remoteFixture();
    const project = repo.saveProject({ roots: ["/a"] });
    const task = {
      taskId: "new",
      workspacePath: "/a",
      workspaceIdentity: `${hostId}:/a`,
    };
    expect(() => repo.reserveCreatedTask({ task, projectId: null })).toThrow(
      "project.remote-project-required",
    );
    expect(() =>
      repo.reserveCreatedTask({
        task,
        projectId: project.id,
        additionalDirectories: ["/b"],
      }),
    ).toThrow("project.remote-single-root-required");
    expect(() =>
      repo.reserveCreatedTask({
        task: { ...task, workspacePath: "/b" },
        projectId: project.id,
        additionalDirectories: [],
      }),
    ).toThrow("project.cwd-not-in-roots");
    expect(db.prepare("SELECT count(*) AS count FROM tasks").get()?.count).toBe(0);
    expect(repo.reserveCreatedTask({ task, projectId: project.id })).toMatchObject({
      projectId: project.id,
      workspacePath: "/a",
      additionalDirectories: [],
    });
  });

  it("moves only same-directory tasks and never appends a root", async () => {
    const { repo } = await remoteFixture();
    const first = repo.saveProject({ roots: ["/a"] });
    const same = repo.saveProject({ roots: ["/a"] });
    const other = repo.saveProject({ roots: ["/b"] });
    const task = {
      taskId: "task",
      workspacePath: "/a",
      workspaceIdentity: `${hostId}:/a`,
    };
    repo.reserveCreatedTask({ task, projectId: first.id });
    expect(() => repo.moveTask({ task, projectId: other.id, addMissingRoot: true })).toThrow(
      "project.cwd-not-in-roots",
    );
    expect(repo.resolveSessionDirectories(task).projectId).toBe(first.id);
    expect(repo.readTree().projects.find((p) => p.id === other.id)?.roots).toEqual(other.roots);
    repo.moveTask({ task, projectId: same.id });
    expect(repo.resolveSessionDirectories(task)).toMatchObject({
      projectId: same.id,
      workspacePath: "/a",
      additionalDirectories: [],
    });
  });

  it("reads existing unclassified history through an online single-root project without assigning it", async () => {
    const { repo, db } = await remoteFixture();
    const project = repo.saveProject({ roots: ["/a"] });
    const task = {
      taskId: "external-history",
      workspacePath: "/a",
      workspaceIdentity: `${hostId}:/a`,
    };
    repo.reserveCreatedTask({ task, projectId: project.id });
    // 修复依据：外部 Codex 历史只有 CLI 事实，未携带 Codez 项目 ID；模拟首次发现后的合法 NULL 归属。
    db.prepare("UPDATE tasks SET project_id=NULL,cli_created_at=1 WHERE task_id=?").run(
      task.taskId,
    );
    repo.saveProject({ roots: ["/a"] });
    expect(repo.resolveSessionDirectories(task)).toEqual({
      workspacePath: "/a",
      projectId: null,
      additionalDirectories: [],
    });
    expect(
      db.prepare("SELECT project_id FROM tasks WHERE task_id=?").get(task.taskId)?.project_id,
    ).toBeNull();
    expect(() =>
      repo.resolveSessionDirectories({
        ...task,
        workspaceIdentity: `${hostId}:/elsewhere`,
      }),
    ).toThrow("project.remote-project-required");
    repo.deleteProject(project.id);
    // 另一同目录项目在线，旧会话仍可只读打开；最后一个也移除后才失去恢复资格。
    expect(repo.resolveSessionDirectories(task).projectId).toBeNull();
  });

  it("rejects remote unclassified history without an indexed CLI row or with extra directories, while allowing indexed external CLI history without an active project", async () => {
    const { repo, db } = await remoteFixture();
    const project = repo.saveProject({ roots: ["/a"] });
    const task = {
      taskId: "external-history",
      workspacePath: "/a",
      workspaceIdentity: `${hostId}:/a`,
    };
    expect(() => repo.resolveSessionDirectories(task)).toThrow("project.remote-project-required");
    repo.reserveCreatedTask({ task, projectId: project.id });
    db.prepare("UPDATE tasks SET project_id=NULL WHERE task_id=?").run(task.taskId);
    expect(() => repo.resolveSessionDirectories(task)).toThrow("project.remote-project-required");
    db.prepare(
      "UPDATE tasks SET cli_created_at=1,execution_directories='[\"/b\"]' WHERE task_id=?",
    ).run(task.taskId);
    expect(() => repo.resolveSessionDirectories(task)).toThrow(
      "project.remote-single-root-required",
    );
    db.prepare("UPDATE tasks SET execution_directories='[]' WHERE task_id=?").run(task.taskId);
    repo.deleteProject(project.id);
    expect(repo.resolveSessionDirectories(task)).toEqual({
      workspacePath: "/a",
      projectId: null,
      additionalDirectories: [],
    });
  });
});
