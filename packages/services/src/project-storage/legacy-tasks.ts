import type { DatabaseSync } from "node:sqlite";
import {
  resolveWorkspaceKey,
  parseRemoteWorkspaceIdentity,
  remoteHostIdFromWorkspaceIdentity,
} from "@codez/shared";
import { resolvePhysicalPathSync } from "@codez/shared/node";
import { addProjectSchema, tableExists } from "#src/project-storage/schema.js";

export const HANDOFF_DELETE = 1;
export const HANDOFF_TITLE = 2;
export const HANDOFF_ORPHAN = 4;
export const OWNERSHIP_DECIDED = 8;

export function hostForWorkspace(workspaceKey: string): { hostId: string; kind: string } {
  const parsed = parseRemoteWorkspaceIdentity(workspaceKey);
  return {
    hostId: remoteHostIdFromWorkspaceIdentity(workspaceKey) ?? "local",
    kind: parsed?.kind ?? "local",
  };
}

export function ensureHost(db: DatabaseSync, workspaceKey: string, ownerHostId?: string): string {
  const { hostId, kind } = ownerHostId
    ? { hostId: ownerHostId, kind: ownerHostId === "local" ? "local" : "server" }
    : hostForWorkspace(workspaceKey);
  db.prepare(
    "INSERT OR IGNORE INTO hosts(host_id,kind,position) VALUES(?,?,(SELECT count(*) FROM hosts))",
  ).run(hostId, kind);
  return hostId;
}

export function uniqueRootProject(
  db: DatabaseSync,
  hostId: string,
  rootPath: string,
  physicalRootPath?: string | null,
): string | null {
  const resolvedPhysical =
    physicalRootPath !== undefined ? physicalRootPath : (resolvePhysicalPathSync(rootPath) ?? null);
  const projects = db
    .prepare(`SELECT DISTINCT p.project_id FROM projects p JOIN project_roots r USING(project_id)
    WHERE p.host_id=? AND p.deleted=0 AND (
      r.root_path=? OR (? IS NOT NULL AND coalesce(r.physical_path, r.root_path)=?)
    ) LIMIT 2`)
    .all(hostId, rootPath, resolvedPhysical, resolvedPhysical) as { project_id: string }[];
  return projects.length === 1 ? projects[0]!.project_id : null;
}

export function initializeLegacyTaskIdentity(
  db: DatabaseSync,
  assignProject: boolean,
  ownerHostId?: string,
  hostAliases?: ReadonlyMap<string, string>,
): void {
  if (!tableExists(db, "tasks")) return;
  const rows = db
    .prepare(
      "SELECT workspace_key,workspace_path,task_id,project_id FROM tasks WHERE host_id IS NULL",
    )
    .all() as {
    workspace_key: string;
    workspace_path: string;
    task_id: string;
    project_id: string | null;
  }[];
  const update = db.prepare(`UPDATE tasks SET host_id=?,root_path=workspace_path,project_id=?,
    physical_root_path=coalesce(physical_root_path,?),
    cli_title=title,cli_title_source=CASE WHEN title_overridden=1 THEN 'custom' ELSE 'default' END,
    cli_created_at=created_at,cli_updated_at=updated_at,
    cli_last_outcome=CASE WHEN task_status='error' THEN 'error' WHEN task_status='interrupted' THEN 'interrupted' WHEN task_status='completed' THEN 'completed' ELSE NULL END,
    cli_deleted=0,handoff_pending=handoff_pending | ? | CASE WHEN deleted=1 THEN 1 ELSE 0 END | CASE WHEN title_overridden=1 THEN 2 ELSE 0 END
    WHERE workspace_key=? AND task_id=? AND host_id IS NULL`);
  for (const row of rows) {
    const rawHostId = hostForWorkspace(row.workspace_key).hostId;
    const hostId = ensureHost(db, row.workspace_key, ownerHostId ?? hostAliases?.get(rawHostId));
    const physicalRootPath =
      hostId === (ownerHostId ?? "local")
        ? (resolvePhysicalPathSync(row.workspace_path) ?? null)
        : null;
    const projectId =
      row.project_id ??
      (assignProject ? uniqueRootProject(db, hostId, row.workspace_path, physicalRootPath) : null);
    update.run(
      hostId,
      projectId,
      physicalRootPath,
      assignProject ? OWNERSHIP_DECIDED : 0,
      row.workspace_key,
      row.task_id,
    );
  }
}

/**
 * 修复原因（issue #19）：控制端曾先于 Source Server 别名映射回填 `tasks.host_id`，或仅重键
 * `workspace_key`/`workspace_identity` 为 `remote:server:<serverId>:/path` 而遗漏 `host_id`，
 * 导致存量远程会话行的 `host_id` 停留在旧 SSH 线路身份并在侧栏中被整批过滤。
 * 仅在控制端对已收敛为稳定 `remote:server:` 身份且 `host_id` 不一致的行幂等修正 `host_id`，
 * 不改变 `project_id`、`workspace_identity`、CLI 事实或时间戳。
 */
function reconcileMismatchedServerTaskHosts(db: DatabaseSync, ownerHostId?: string): void {
  if (ownerHostId && ownerHostId !== "local") return;
  for (const table of ["tasks", "automations", "off_peak_tasks"] as const) {
    if (!tableExists(db, table)) continue;
    const hasIdentityColumn = (
      db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>
    ).some((column) => column.name === "workspace_identity");
    const rows = db
      .prepare(
        hasIdentityColumn
          ? `SELECT DISTINCT workspace_key,workspace_identity,host_id FROM ${table}
             WHERE workspace_key LIKE 'remote:server:%' OR workspace_identity LIKE 'remote:server:%'`
          : `SELECT DISTINCT workspace_key,NULL AS workspace_identity,host_id FROM ${table}
             WHERE workspace_key LIKE 'remote:server:%'`,
      )
      .all() as Array<{
      workspace_key: string;
      workspace_identity: string | null;
      host_id: string | null;
    }>;
    const updateByKey = db.prepare(`UPDATE ${table} SET host_id=? WHERE workspace_key=?`);
    for (const row of rows) {
      const identity = row.workspace_key.startsWith("remote:server:")
        ? row.workspace_key
        : (row.workspace_identity ?? "");
      const parsed = parseRemoteWorkspaceIdentity(identity);
      const stableHostId =
        parsed?.kind === "server" ? remoteHostIdFromWorkspaceIdentity(identity) : null;
      if (!stableHostId || row.host_id === stableHostId) continue;
      ensureHost(db, identity, stableHostId);
      updateByKey.run(stableHostId, row.workspace_key);
    }
  }
}

function initializeLegacyDefinitions(db: DatabaseSync, ownerHostId?: string): void {
  for (const table of ["automations", "off_peak_tasks"]) {
    if (!tableExists(db, table)) continue;
    const rows = db
      .prepare(
        `SELECT DISTINCT workspace_key,workspace_path,project_id FROM ${table} WHERE host_id IS NULL`,
      )
      .all() as {
      workspace_key: string;
      workspace_path: string;
      project_id: string | null;
    }[];
    const update =
      db.prepare(`UPDATE ${table} SET host_id=?,project_id=?,additional_directories=coalesce(additional_directories,'[]')
      WHERE workspace_key=? AND workspace_path=? AND host_id IS NULL`);
    for (const row of rows) {
      const hostId = ensureHost(db, row.workspace_key, ownerHostId);
      // 原因：旧版本新增定义不会重跑 v3 migration；host_id 标识一次性交接，不能重算合法 NULL 归属。
      // 旧版只有 cwd，附加目录保持 []，不因当前项目 roots 扩大既有自动执行范围。
      update.run(
        hostId,
        row.project_id ?? uniqueRootProject(db, hostId, row.workspace_path),
        row.workspace_key,
        row.workspace_path,
      );
    }
  }
}

function backfillPhysicalRootPaths(db: DatabaseSync, ownerHostId?: string): void {
  const hostId = ownerHostId ?? "local";
  if (tableExists(db, "project_roots") && tableExists(db, "projects")) {
    const roots = db
      .prepare(
        `SELECT DISTINCT r.root_path FROM project_roots r
         JOIN projects p USING(project_id)
         WHERE p.host_id=? AND r.physical_path IS NULL`,
      )
      .all(hostId) as { root_path: string }[];
    if (roots.length > 0) {
      const updateRoot = db.prepare(
        `UPDATE project_roots SET physical_path=?
         WHERE root_path=? AND physical_path IS NULL
           AND project_id IN (SELECT project_id FROM projects WHERE host_id=?)`,
      );
      for (const { root_path } of roots) {
        const physical = resolvePhysicalPathSync(root_path);
        if (physical) updateRoot.run(physical, root_path, hostId);
      }
    }
  }
  if (tableExists(db, "tasks")) {
    const taskRoots = db
      .prepare(
        `SELECT DISTINCT root_path FROM tasks
         WHERE host_id=? AND root_path IS NOT NULL AND physical_root_path IS NULL`,
      )
      .all(hostId) as { root_path: string }[];
    if (taskRoots.length > 0) {
      const updateTask = db.prepare(
        `UPDATE tasks SET physical_root_path=?
         WHERE host_id=? AND root_path=? AND physical_root_path IS NULL`,
      );
      for (const { root_path } of taskRoots) {
        const physical = resolvePhysicalPathSync(root_path);
        if (physical) updateTask.run(physical, hostId, root_path);
      }
    }
  }
}

export function reconcileLegacy(db: DatabaseSync, ownerHostId?: string): void {
  db.exec("BEGIN IMMEDIATE");
  try {
    // 幂等补齐新增物理路径列与索引（已应用 0005_projects 的存量库不会重跑 0005，在此统一自愈）。
    addProjectSchema(db);
    // Bug 原因：同一台机器上本机桌面与 Source Server 共用 tasks-index；0005 按库只执行一次，
    // 只写入首个打开者的 host 行，后打开的 owner 新建项目触发 projects.host_id 外键失败。
    // 每次启动幂等补齐当前 owner 的 host 行；不改任务 host_id 与项目归属。
    ensureHost(db, "local", ownerHostId);
    initializeLegacyTaskIdentity(db, true, ownerHostId);
    initializeLegacyDefinitions(db, ownerHostId);
    reconcileMismatchedServerTaskHosts(db, ownerHostId);
    backfillPhysicalRootPaths(db, ownerHostId);
    if (tableExists(db, "tasks")) {
      db.exec(`UPDATE tasks SET handoff_pending=handoff_pending | ${HANDOFF_DELETE} WHERE deleted=1 AND coalesce(cli_deleted,0)=0;
        UPDATE tasks SET handoff_pending=handoff_pending | ${HANDOFF_TITLE}
        WHERE title_overridden=1 AND (coalesce(cli_title_source,'')<>'custom' OR coalesce(cli_title,'')<>title);`);
    }
    db.exec("COMMIT");
  } catch (error) {
    if (db.isTransaction) db.exec("ROLLBACK");
    throw error;
  }
}

/** 新版本插入身份和首次归属，不借旧列生成 CLI 事实。调用方与 INSERT 共用写事务。 */
export function admitTaskIdentity(
  db: DatabaseSync,
  task: { workspacePath: string; workspaceIdentity?: string; taskId: string },
  ownerHostId?: string,
  originProjectId?: string | null,
): void {
  const key = resolveWorkspaceKey(task);
  const hostId = ensureHost(db, key, ownerHostId);
  const physicalRootPath =
    hostId === (ownerHostId ?? "local")
      ? (resolvePhysicalPathSync(task.workspacePath) ?? null)
      : null;
  if (
    originProjectId !== undefined &&
    db
      .prepare("SELECT host_id FROM tasks WHERE workspace_key=? AND task_id=?")
      .get(key, task.taskId)?.host_id != null
  ) {
    if (physicalRootPath) {
      db.prepare(
        "UPDATE tasks SET physical_root_path=coalesce(physical_root_path,?) WHERE workspace_key=? AND task_id=?",
      ).run(physicalRootPath, key, task.taskId);
    }
    return;
  }
  // 原因：多目录项目共享 cwd，唯一目录匹配不能表达创建时的项目选择；原生
  // threadSource 只在首次插入决定组织归属，已决定的行（含用户移动）由 WHERE 保护。
  if (originProjectId) {
    const owner = db
      .prepare("SELECT host_id FROM projects WHERE project_id=?")
      .get(originProjectId);
    if (!owner) throw new Error("project.not-found");
    if (owner.host_id !== hostId) throw new Error("project.host-mismatch");
  }
  db.prepare(
    "UPDATE tasks SET host_id=?,root_path=workspace_path,physical_root_path=coalesce(physical_root_path,?),project_id=?,handoff_pending=handoff_pending | ? WHERE workspace_key=? AND task_id=? AND host_id IS NULL",
  ).run(
    hostId,
    physicalRootPath,
    originProjectId === undefined
      ? uniqueRootProject(db, hostId, task.workspacePath, physicalRootPath)
      : originProjectId,
    OWNERSHIP_DECIDED,
    key,
    task.taskId,
  );
  if (physicalRootPath) {
    db.prepare(
      "UPDATE tasks SET physical_root_path=coalesce(physical_root_path,?) WHERE workspace_key=? AND task_id=?",
    ).run(physicalRootPath, key, task.taskId);
  }
}
