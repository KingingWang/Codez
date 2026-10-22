import { describe, expect, it } from "vitest";
import type { ProjectTask, ProjectTree } from "@/project-sidebar/contract.js";
import {
  selectProjectRows,
  mergeProjectTrees,
  projectKey,
  projectHasUnread,
  resolveEntryProject,
} from "@/project-sidebar/view.js";
import { buildArchiveGroups } from "@/project-sidebar/archive-view.js";
const task = (id: string, projectId: string | null, updatedAt: number): ProjectTask => ({
  taskId: id,
  projectId,
  hostId: "local",
  pinned: false,
  archived: false,
  workspacePath: "/same",
  title: id,
  mode: "build",
  traceId: id,
  createdAt: 1,
  updatedAt,
});
const makeProject = (
  id: string,
  roots: Array<string | { rootPath: string; physicalPath?: string }>,
  hostId = "local",
) => ({
  id,
  hostId,
  name: id,
  roots: roots.map((entry, position) => ({
    ...(typeof entry === "string" ? { rootPath: entry } : entry),
    position,
    isPrimary: position === 0,
  })),
  nameOverridden: false,
  pinned: false,
  position: 0,
  deleted: false,
  createdAt: 1,
  updatedAt: 1,
});
describe("project-sidebar read contract", () => {
  it("leaves an old cwd entry unresolved when two projects share that root", () => {
    const project = makeProject("one", ["/same"], "remote:server:s");
    const entry = {
      id: "legacy",
      hostId: project.hostId,
      projectId: null,
      name: "old",
      roots: [],
      lastSyncedAt: null,
      legacyWorkspace: { workspacePath: "/same" } as never,
    };
    expect(resolveEntryProject(entry, { projects: [project], tasks: [] })?.id).toBe("one");
    const oldServerEntry = {
      ...entry,
      projectId: "legacy-single-root:root",
      roots: project.roots,
      legacyWorkspace: null,
    };
    expect(resolveEntryProject(oldServerEntry, { projects: [project], tasks: [] })?.id).toBe("one");
    expect(
      resolveEntryProject(oldServerEntry, {
        projects: [project, { ...project, id: "two" }],
        tasks: [],
      }),
    ).toBeUndefined();
    expect(
      resolveEntryProject(entry, { projects: [project, { ...project, id: "two" }], tasks: [] }),
    ).toBeUndefined();
  });
  it("joins only retained remote projects and does not retain offline task facts", () => {
    const hostId = "remote:server:s";
    const local: ProjectTree = {
      projects: [],
      tasks: [
        task("local", null, 1),
        {
          ...task("controller-remote", null, 5),
          hostId,
          workspacePath: "/repo",
          workspaceIdentity: `${hostId}:/repo`,
        },
        { ...task("remote", "p", 9), hostId },
      ],
    };
    const remoteTask = { ...task("remote", "p", 9), hostId };
    const directory = {
      hosts: [
        {
          id: hostId,
          membershipId: "m",
          kind: "docker" as const,
          target: { kind: "docker" as const, container: "s" },
          position: 1,
        },
      ],
      entries: [
        {
          id: "entry",
          hostId,
          projectId: "p",
          name: "cached",
          roots: [],
          lastSyncedAt: 1,
          legacyWorkspace: null,
        },
      ],
    };
    const remote: ProjectTree = {
      projects: [
        { ...makeProject("p", [], hostId), name: "online", nameOverridden: true, pinned: true },
      ],
      tasks: [
        remoteTask,
        { ...remoteTask, taskId: "unadded", projectId: "other" },
        { ...remoteTask, taskId: "unclassified", projectId: null },
      ],
    };
    const online = mergeProjectTrees(local, directory, new Map([[remoteTask.hostId, remote]]));
    expect(online.tree.tasks.map((row) => row.taskId)).toEqual([
      "local",
      "remote",
      "unclassified",
      "controller-remote",
    ]);
    expect(online.tree.projects[0]?.name).toBe("online");
    expect(online.availability.get(projectKey(remote.projects[0]!))).toEqual({
      entryId: "entry",
      online: true,
    });
    const offline = mergeProjectTrees(local, directory, new Map());
    expect(offline.tree.projects[0]?.name).toBe("cached");
    expect(offline.tree.tasks.map((row) => row.taskId)).toEqual(["local"]);
    expect(offline.availability.get(projectKey(remote.projects[0]!))?.online).toBe(false);
  });
  it("does not conflate project IDs from different physical Hosts", () => {
    const tree: ProjectTree = {
      projects: [],
      tasks: [task("local", "p", 1), { ...task("remote", "p", 2), hostId: "remote:server:s" }],
    };
    expect(
      selectProjectRows(tree, {
        kind: "project",
        projectId: "p",
        hostId: "local",
      }).map((row) => row.taskId),
    ).toEqual(["local"]);
  });
  it("retains missing-summary rows, NULL ownership and deleted project history", () => {
    const tree: ProjectTree = {
      projects: [],
      tasks: [
        task("orphan", null, 9),
        task("deleted-project", "gone", 5),
        task("same-cwd", "other", 7),
      ],
    };
    expect(
      selectProjectRows(tree, { kind: "project", projectId: null }).map((row) => row.taskId),
    ).toEqual(["orphan"]);
    expect(selectProjectRows(tree, { kind: "timeline" }).map((row) => row.taskId)).toEqual([
      "orphan",
      "same-cwd",
      "deleted-project",
    ]);
  });
  it("pin/archive organization cannot change activity ordering", () => {
    const tree: ProjectTree = {
      projects: [],
      tasks: [
        { ...task("pinned", "p", 1), pinned: true },
        task("new", "p", 10),
        { ...task("archived", "p", 11), archived: true },
      ],
    };
    expect(
      selectProjectRows(tree, { kind: "project", projectId: "p" }).map((row) => row.taskId),
    ).toEqual(["new"]);
    expect(selectProjectRows(tree, { kind: "pinned" }).map((row) => row.taskId)).toEqual([
      "pinned",
    ]);
    expect(selectProjectRows(tree, { kind: "timeline" }).map((row) => row.taskId)).toEqual([
      "new",
      "pinned",
    ]);
  });
  it("new local single-root project reads all indexed A history without changing ownership", () => {
    const localProject = (id: string, roots: string[]) => makeProject(id, roots);
    const remoteRow = (
      id: string,
      projectId: string | null,
      hostId: string,
      extra: Partial<ProjectTask> = {},
    ) => ({
      ...task(id, projectId, 3),
      workspacePath: "/a",
      workspaceIdentity: `${hostId}:/a`,
      hostId,
      ...extra,
    });
    const tree: ProjectTree = {
      projects: [
        localProject("single-a", ["/a"]),
        localProject("single-b", ["/b"]),
        localProject("multi-ab", ["/a", "/b"]),
        localProject("multi-ac", ["/a", "/c"]),
        { ...localProject("remote-a", ["/a"]), hostId: "remote:server:s" },
        { ...localProject("remote-b", ["/a"]), hostId: "remote:server:s" },
        { ...localProject("foreign-a", ["/a"]), hostId: "remote:server:other" },
      ],
      tasks: [
        { ...task("cli-a", null, 8), workspacePath: "/a", unreadAt: 5 },
        { ...task("codez-ab", "multi-ab", 7), workspacePath: "/a" },
        { ...task("codez-ac", "multi-ac", 6), workspacePath: "/a" },
        { ...task("cli-b", null, 5), workspacePath: "/b" },
        { ...task("pinned-a", "multi-ab", 4), workspacePath: "/a", pinned: true },
        { ...task("archived-a", null, 3), workspacePath: "/a", archived: true },
        remoteRow("remote-a", "remote-a", "remote:server:s", { updatedAt: 2 }),
        remoteRow("remote-cli-a", null, "remote:server:s", { unreadAt: 4 }),
        remoteRow("stale-identity-a", null, "remote:server:s", {
          workspaceIdentity: "remote:server:other:/a",
        }),
        remoteRow("foreign-cli-a", null, "remote:server:other"),
      ],
    };
    const rows = (id: string, hostId = "local") =>
      selectProjectRows(tree, { kind: "project", projectId: id, hostId }).map((row) => row.taskId);
    expect(rows("single-a")).toEqual(["cli-a", "codez-ab", "codez-ac"]);
    expect(rows("single-b")).toEqual(["cli-b"]);
    expect(rows("multi-ab")).toEqual(["codez-ab"]);
    expect(rows("multi-ac")).toEqual(["codez-ac"]);
    expect(rows("remote-a", "remote:server:s")).toEqual(["remote-cli-a", "remote-a"]);
    expect(rows("remote-b", "remote:server:s")).toEqual(["remote-cli-a", "remote-a"]);
    expect(rows("foreign-a", "remote:server:other")).toEqual(["foreign-cli-a"]);
    expect(
      selectProjectRows(tree, { kind: "project", projectId: null, hostId: "local" }).map(
        (row) => row.taskId,
      ),
    ).toEqual(["cli-a", "cli-b"]);
    expect(selectProjectRows(tree, { kind: "timeline" })).toHaveLength(9);
    expect(selectProjectRows(tree, { kind: "pinned" }).map((row) => row.taskId)).toEqual([
      "pinned-a",
    ]);
    expect(projectHasUnread(tree, tree.projects[0]!)).toBe(true);
    expect(projectHasUnread(tree, tree.projects[4]!)).toBe(true);
    expect(tree.tasks.find((row) => row.taskId === "remote-cli-a")?.projectId).toBeNull();
    expect(tree.tasks.find((row) => row.taskId === "cli-a")?.projectId).toBeNull();
    expect(
      buildArchiveGroups(tree, { project: JSON.stringify(["local", "single-a"]) })
        .flatMap((group) => group.tasks)
        .map((row) => row.taskId),
    ).toEqual(["archived-a"]);
  });

  it("matches symlinked single-root project and physical-cwd tasks by physicalPath while keeping fallback when physicalPath is absent", () => {
    const hostId = "remote:server:moga";
    const symlinkRoot = "/home/jingjin/workspace/hypervisor/osx-ca";
    const physicalRoot = "/home/back/disk/home/jingjin/workspace/hypervisor/osx-ca";
    const remoteTask = (
      id: string,
      path: string,
      host = hostId,
      extra: Partial<ProjectTask> = {},
    ) => ({
      ...task(id, null, 10),
      hostId: host,
      workspacePath: path,
      workspacePhysicalPath: path,
      workspaceIdentity: `${host}:${path}`,
      ...extra,
    });
    const tree: ProjectTree = {
      projects: [
        makeProject("osx-ca", [{ rootPath: symlinkRoot, physicalPath: physicalRoot }], hostId),
      ],
      tasks: [
        remoteTask("rollout-physical", physicalRoot, hostId, { unreadAt: 9 }),
        remoteTask("archived-physical", physicalRoot, hostId, { archived: true }),
        remoteTask("other-physical", "/home/back/disk/home/jingjin/workspace/other"),
        remoteTask("foreign-host-same-physical", physicalRoot, "remote:server:other"),
      ],
    };
    expect(
      selectProjectRows(tree, { kind: "project", projectId: "osx-ca", hostId }).map(
        (row) => row.taskId,
      ),
    ).toEqual(["rollout-physical"]);
    expect(projectHasUnread(tree, tree.projects[0]!)).toBe(true);
    expect(
      buildArchiveGroups(tree, { project: JSON.stringify([hostId, "osx-ca"]) })
        .flatMap((group) => group.tasks)
        .map((row) => row.taskId),
    ).toEqual(["archived-physical"]);
  });
});
