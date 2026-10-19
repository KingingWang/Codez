import { describe, expect, it } from "vitest";
import { fixture, port } from "#src/project-storage/test-fixture.js";

describe("Codex native first-project origin contract", () => {
  it("beats shared cwd, keeps explicit NULL and never overwrites a later move", async () => {
    const { db, context } = await fixture();
    await port.migrate(db, context);
    const repo = port.repository(db);
    const first = repo.saveProject({ roots: ["/a", "/b"] });
    const second = repo.saveProject({ roots: ["/a", "/c"] });
    const add = (taskId: string) => {
      db.prepare(`INSERT INTO tasks(workspace_key,workspace_path,task_id,created_at,updated_at)
        VALUES('/a','/a',?,1,1)`).run(taskId);
      return { workspacePath: "/a", taskId };
    };
    const own = add("own");
    port.admitTaskIdentity(db, own, "local", first.id);
    const global = add("global");
    port.admitTaskIdentity(db, global, "local", null);
    const cli = add("cli");
    port.admitTaskIdentity(db, cli, "local");
    const projectIds = () =>
      db
        .prepare("SELECT task_id,project_id FROM tasks ORDER BY task_id")
        .all()
        .map((row) => [row.task_id, row.project_id]);
    expect(projectIds()).toEqual([
      ["cli", null],
      ["global", null],
      ["own", first.id],
    ]);
    repo.moveTask({ task: own, projectId: second.id });
    port.admitTaskIdentity(db, own, "local", first.id);
    port.admitTaskIdentity(db, own, "local", "deleted-origin");
    expect(repo.resolveSessionDirectories(own).projectId).toBe(second.id);
    expect(() => port.admitTaskIdentity(db, add("missing"), "local", "not-a-project")).toThrow(
      "project.not-found",
    );
  });
});
