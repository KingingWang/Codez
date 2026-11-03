import type { DatabaseSync } from "node:sqlite";
import {
  generateTraceId,
  isRemoteWorkspaceIdentity,
  resolveWorkspaceKey,
  CODEZ_AGENT_PROVIDER,
} from "@codez/shared";
import type {
  ProjectTask,
  ProjectTaskRef,
  VirtualProject,
} from "#src/project-storage/contract.js";

// 只读记录查询；事务、Host 过滤与全部写操作仍由 ProjectRepository 持有。
export function readProjects(db: DatabaseSync, includeDeleted = true): VirtualProject[] {
  const roots = db
    .prepare(
      "SELECT project_id,root_path,physical_path,position,is_primary FROM project_roots ORDER BY position,root_path",
    )
    .all();
  return db
    .prepare(
      `SELECT * FROM projects ${includeDeleted ? "" : "WHERE deleted=0"} ORDER BY position,project_id`,
    )
    .all()
    .map((row) => ({
      id: String(row.project_id),
      hostId: String(row.host_id),
      name: String(row.name),
      nameOverridden: row.name_overridden === 1,
      position: Number(row.position),
      pinned: row.pinned === 1,
      deleted: row.deleted === 1,
      createdAt: Number(row.created_at),
      updatedAt: Number(row.updated_at),
      roots: roots
        .filter((root) => root.project_id === row.project_id)
        .map((root) => ({
          rootPath: String(root.root_path),
          ...(typeof root.physical_path === "string" && root.physical_path.length > 0
            ? { physicalPath: root.physical_path }
            : {}),
          position: Number(root.position),
          isPrimary: root.is_primary === 1,
        })),
    }));
}

export function requireProject(db: DatabaseSync, id: string): VirtualProject {
  const project = readProjects(db).find((entry) => entry.id === id);
  if (!project) throw new Error("project.not-found");
  return project;
}

// 复用 schema.ts 的同一实现，避免同模块内出现第二份表存在性判断（语义等价：Boolean vs !== undefined）。
export { tableExists } from "#src/project-storage/schema.js";

export function readTask(db: DatabaseSync, task: ProjectTaskRef) {
  return db
    .prepare("SELECT * FROM tasks WHERE workspace_key=? AND task_id=?")
    .get(resolveWorkspaceKey(task), task.taskId);
}

export function readTasks(db: DatabaseSync): ProjectTask[] {
  // 迁移后的旧后端行也有 CLI 时间；沿用列表的 provider 边界，避免展示 Controller 无法操作的会话。
  return db
    .prepare(
      "SELECT * FROM tasks WHERE provider=? AND deleted=0 AND coalesce(cli_deleted,0)=0 AND cli_created_at IS NOT NULL ORDER BY cli_updated_at DESC,task_id",
    )
    .all(CODEZ_AGENT_PROVIDER)
    .map((row) => {
      const meta = typeof row.meta_json === "string" ? JSON.parse(row.meta_json) : {};
      return {
        ...meta,
        taskId: String(row.task_id),
        traceId: meta.traceId ?? generateTraceId(String(row.task_id)),
        // workspacePath 是任务所属 workspace；worktree 任务的 cwd 另由 cwd 给出
        // （docs/git/worktree.md §6.6.1）。普通任务两列相同，行为不变。
        workspacePath: String(row.workspace_path),
        ...(typeof row.worktree_root === "string" ? { worktreeRoot: row.worktree_root } : {}),
        ...(row.root_path && row.root_path !== row.workspace_path
          ? { cwd: String(row.root_path) }
          : {}),
        ...(typeof row.physical_root_path === "string" && row.physical_root_path.length > 0
          ? { workspacePhysicalPath: row.physical_root_path }
          : {}),
        workspaceIdentity:
          row.workspace_identity === row.workspace_key
            ? String(row.workspace_identity)
            : isRemoteWorkspaceIdentity(String(row.workspace_key))
              ? String(row.workspace_key)
              : undefined,
        title: String(row.title_overridden === 1 ? row.title : (row.cli_title ?? "")),
        titleOverridden: row.title_overridden === 1 || row.cli_title_source === "custom",
        createdAt: Number(row.cli_created_at),
        updatedAt: Number(row.cli_updated_at),
        status:
          row.cli_last_outcome === "error"
            ? "error"
            : row.cli_last_outcome
              ? "completed"
              : undefined,
        mode: meta.mode ?? "default",
        pinned: row.pinned === 1,
        archived: row.archived === 1,
        unreadAt: row.unread_at == null ? undefined : Number(row.unread_at),
        projectId: row.project_id == null ? null : String(row.project_id),
        hostId: String(row.host_id),
      };
    });
}
