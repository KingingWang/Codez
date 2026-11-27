import { DatabaseSync } from "node:sqlite";
import type { DatabaseMigrationFacts } from "@codez/shared";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { Worker } from "node:worker_threads";
import { once } from "node:events";
import { build } from "esbuild";
import { afterEach, expect, it } from "vitest";
import { runTasksDatabaseMigrations } from "#src/session/tasksDatabase/migrations.js";
import { migrateControllerRemoteWorkspaceIdentity } from "#src/session/controllerRemoteIdentityMigration.js";
import { SourceServerWorkspaceAliasRepo } from "#src/session/sourceServerWorkspaceAliasRepo.js";
import { SourceServerWorkspaceIdentityMapper } from "#src/source-server-workspace/sourceServerWorkspaceIdentityChannelServer.js";
import { ProjectRepository } from "#src/project-storage/project-repository.js";
import { projectStorage } from "#src/project-storage/index.js";
import { buildServerRemoteWorkspaceIdentity } from "@codez/shared";
import { getWorkspaceHash } from "#src/paths.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "codez-remote-schema-"));
  roots.push(root);
  const taskDbPath = join(root, "tasks.sqlite");
  const sessionDbPath = join(root, "session.sqlite");
  return { taskDbPath, sessionDbPath, backupRoot: join(root, "backups") };
}

it("已迁移 Controller 无源行重连在其他连接持写锁时只读返回，checksum 仍校验", async () => {
  const options = await fixture();
  const writer = new DatabaseSync(options.taskDbPath);
  const input = {
    dbPath: options.taskDbPath,
    oldWorkspaceKey: "remote:ssh:old:22:u:/repo",
    newWorkspaceKey: "remote:server:source:/repo",
  };
  try {
    writer.exec("PRAGMA journal_mode = WAL");
    await runTasksDatabaseMigrations(writer);
    writer
      .prepare(`INSERT INTO tasks
      (workspace_key, workspace_path, workspace_identity, task_id, created_at, updated_at)
      VALUES (?, '/repo', ?, 'task-1', 1, 1)`)
      .run(input.oldWorkspaceKey, input.oldWorkspaceKey);
    await migrateControllerRemoteWorkspaceIdentity(input);
    const ledger = writer.prepare("SELECT * FROM tasks_schema_migration ORDER BY id").all();
    const audit = writer.prepare("SELECT * FROM controller_remote_identity_migrations").all();
    writer.exec("BEGIN IMMEDIATE; UPDATE tasks SET updated_at = 2");
    // 保持真实写锁直到断言结束；错误实现无法靠等待 writer 释放而偶然通过。
    await expect(migrateControllerRemoteWorkspaceIdentity(input)).resolves.toMatchObject({
      status: "completed",
      before: { tasks: 0 },
      after: { tasks: 1 },
    });
    writer.exec("ROLLBACK");
    expect(writer.prepare("SELECT * FROM tasks_schema_migration ORDER BY id").all()).toEqual(
      ledger,
    );
    expect(writer.prepare("SELECT * FROM controller_remote_identity_migrations").all()).toEqual(
      audit,
    );
    writer.exec(`UPDATE tasks_schema_migration SET checksum = 'broken'
      WHERE id = '0004_controller_remote_identity'; BEGIN IMMEDIATE`);
    await expect(migrateControllerRemoteWorkspaceIdentity(input)).rejects.toThrow(/checksum/);
  } finally {
    if (writer.isTransaction) writer.exec("ROLLBACK");
    writer.close();
  }
});

it("Source 管理查询在已迁移 task 库持写锁时只读返回", async () => {
  const options = await fixture();
  const writer = new DatabaseSync(options.taskDbPath);
  const repo = new SourceServerWorkspaceAliasRepo(options);
  try {
    writer.exec("PRAGMA journal_mode = WAL");
    await repo.getFailedPathCount();
    const ledger = writer.prepare("SELECT * FROM tasks_schema_migration").all();
    writer.exec("BEGIN IMMEDIATE");
    await expect(repo.getFailedPathCount()).resolves.toBe(0);
    await expect(repo.getAbandonedPathCount()).resolves.toBe(0);
    writer.exec("ROLLBACK");
    expect(writer.prepare("SELECT * FROM tasks_schema_migration").all()).toEqual(ledger);
  } finally {
    if (writer.isTransaction) writer.exec("ROLLBACK");
    writer.close();
  }
});

it("Source 已有 alias 在 session 库持写锁时可解析，identity 账本不变且 checksum 仍校验", async () => {
  const options = await fixture();
  const writer = new DatabaseSync(options.sessionDbPath);
  const canonicalKey = "remote:ssh:one:22:u:/repo";
  const input = { workspacePath: "/repo", legacyRouteHint: canonicalKey };
  const repo = new SourceServerWorkspaceAliasRepo(options);
  try {
    writer.exec(`PRAGMA journal_mode = WAL;
      CREATE TABLE session (id TEXT PRIMARY KEY, workspace_id TEXT, directory TEXT, path TEXT, time_updated INTEGER)`);
    writer
      .prepare("INSERT INTO session VALUES ('session-1', ?, '/repo', '/repo', 1)")
      .run(canonicalKey);
    await repo.resolveCanonicalWorkspaceKey(input);
    const ledger = writer.prepare("SELECT * FROM schema_migration").all();
    writer.exec("BEGIN IMMEDIATE; UPDATE session SET time_updated = 2");
    await expect(repo.resolveCanonicalWorkspaceKey(input)).resolves.toEqual({
      canonicalKey,
      mergedKeys: [],
    });
    writer.exec("ROLLBACK");
    expect(writer.prepare("SELECT * FROM schema_migration").all()).toEqual(ledger);
    writer.exec(`UPDATE schema_migration SET checksum = 'broken'
      WHERE id = '0024_session_database_identity'; BEGIN IMMEDIATE`);
    await expect(repo.resolveCanonicalWorkspaceKey(input)).rejects.toThrow(/checksum/);
  } finally {
    if (writer.isTransaction) writer.exec("ROLLBACK");
    writer.close();
  }
});

it("并发 Source/Core 初始化只记账一次，默认业务表与远端扩展可以交错接管", async () => {
  const options = await fixture();
  const compiled = await build({
    entryPoints: [resolve("packages/services/src/session/tasksDatabase/migrations.ts")],
    bundle: true,
    write: false,
    platform: "node",
    format: "cjs",
    // #src 属于各自 package；全局 alias 会把 shared 的入口错误重定向到 services。
  });
  const gate = new SharedArrayBuffer(4);
  const workers = ["source-server", "base", "source-server"].map(
    (scope) =>
      new Worker(
        `${compiled.outputFiles[0]!.text}
    const { parentPort, workerData } = require('node:worker_threads');
    const db = new (require('node:sqlite').DatabaseSync)(workerData.path);
    db.exec('PRAGMA busy_timeout = 5000');
    parentPort.postMessage('ready');
    Atomics.wait(new Int32Array(workerData.gate), 0, 0);
    module.exports.runTasksDatabaseMigrations(db, workerData.scope).then(() => db.close());`,
        { eval: true, workerData: { path: options.taskDbPath, scope, gate } },
      ),
  );
  try {
    const exits = workers.map((worker) => once(worker, "exit"));
    await Promise.all(workers.map((worker) => once(worker, "message")));
    Atomics.store(new Int32Array(gate), 0, 1);
    Atomics.notify(new Int32Array(gate), 0);
    expect(await Promise.all(exits)).toEqual([[0], [0], [0]]);
    const db = new DatabaseSync(options.taskDbPath);
    try {
      expect(db.prepare("SELECT id FROM tasks_schema_migration ORDER BY id").all()).toEqual([
        { id: "0001_adopt_task_schema" },
        { id: "0002_provider_selection" },
        { id: "0003_official_glm_selection" },
        { id: "0004_codex_automation_correlations" },
        { id: "0004_project_execution_scopes" },
        { id: "0005_codex_automation_stopped" },
        { id: "0005_source_server_workspace_schema" },
        { id: "0006_task_group_admissions" },
        // fork 的会话永久删除迁移（task_purge 表 + 恢复/插入守卫触发器）随 base scope 一起登记。
        { id: "0007_task_permanent_deletion" },
      ]);
      expect(db.prepare("PRAGMA integrity_check").get()?.integrity_check).toBe("ok");
    } finally {
      db.close();
    }
  } finally {
    await Promise.all(workers.map((worker) => worker.terminate()));
  }
});

it("Controller 与 Source 的附加表登记到同库账本，保留旧记录且不混用专属表", async () => {
  const options = await fixture();
  const db = new DatabaseSync(options.taskDbPath);
  try {
    await runTasksDatabaseMigrations(db);
    const oldLedger = db.prepare("SELECT * FROM tasks_schema_migration ORDER BY id").all();
    await migrateControllerRemoteWorkspaceIdentity({
      dbPath: options.taskDbPath,
      oldWorkspaceKey: "remote:ssh:old:22:u:/repo",
      newWorkspaceKey: "remote:server:source:/repo",
    });
    expect(
      db
        .prepare("SELECT id FROM tasks_schema_migration WHERE id='0004_controller_remote_identity'")
        .get(),
    ).toEqual({
      id: "0004_controller_remote_identity",
    });
    expect(
      db.prepare("SELECT 1 FROM sqlite_master WHERE name='workspace_alias'").get(),
    ).toBeUndefined();
    const beforeReopen = db.prepare("SELECT * FROM tasks_schema_migration ORDER BY id").all();
    await migrateControllerRemoteWorkspaceIdentity({
      dbPath: options.taskDbPath,
      oldWorkspaceKey: "remote:ssh:old:22:u:/repo",
      newWorkspaceKey: "remote:server:source:/repo",
    });
    expect(db.prepare("SELECT * FROM tasks_schema_migration ORDER BY id").all()).toEqual(
      beforeReopen,
    );
    expect(
      db
        .prepare(
          "SELECT * FROM tasks_schema_migration WHERE id != '0004_controller_remote_identity' AND id != '0005_source_server_workspace_schema' ORDER BY id",
        )
        .all(),
    ).toEqual(oldLedger);
  } finally {
    db.close();
  }
  const sourceOptions = await fixture();
  const sourceDb = new DatabaseSync(sourceOptions.taskDbPath);
  try {
    const repo = new SourceServerWorkspaceAliasRepo(sourceOptions);
    await expect(repo.getFailedPathCount()).resolves.toBe(0);
    expect(sourceDb.prepare("SELECT id FROM tasks_schema_migration").all()).toEqual([
      { id: "0005_source_server_workspace_schema" },
    ]);
    expect(
      sourceDb
        .prepare("SELECT 1 FROM sqlite_master WHERE name='controller_remote_identity_migrations'")
        .get(),
    ).toBeUndefined();
    const sourceLedger = sourceDb.prepare("SELECT * FROM tasks_schema_migration").all();
    await repo.getFailedPathCount();
    await runTasksDatabaseMigrations(sourceDb);
    expect(
      sourceDb
        .prepare(
          "SELECT * FROM tasks_schema_migration WHERE id='0005_source_server_workspace_schema'",
        )
        .all(),
    ).toEqual(sourceLedger);
  } finally {
    sourceDb.close();
  }
});

it("Source schema 和正式账本原子提交，记账失败回滚，checksum 损坏明确拒绝", async () => {
  const options = await fixture();
  const db = new DatabaseSync(options.taskDbPath);
  try {
    await runTasksDatabaseMigrations(db);
    db.exec(`CREATE TRIGGER reject_remote_migration BEFORE INSERT ON tasks_schema_migration
      WHEN NEW.id = '0005_source_server_workspace_schema'
      BEGIN SELECT RAISE(ABORT, 'injected ledger failure'); END;`);
    const repo = new SourceServerWorkspaceAliasRepo(options);
    await expect(repo.getFailedPathCount()).rejects.toThrow("injected ledger failure");
    expect(
      db.prepare("SELECT 1 FROM sqlite_master WHERE name='workspace_alias'").get(),
    ).toBeUndefined();
    db.exec("DROP TRIGGER reject_remote_migration");
    await expect(repo.getFailedPathCount()).resolves.toBe(0);
    db.exec(
      "UPDATE tasks_schema_migration SET checksum='broken' WHERE id='0005_source_server_workspace_schema'",
    );
    await expect(repo.getFailedPathCount()).rejects.toThrow(/checksum/);
  } finally {
    db.close();
  }
});

it("接管无旧版本标记的完整表时，保留活动计划的 phase 和 session generation", async () => {
  const options = await fixture();
  const db = new DatabaseSync(options.taskDbPath);
  try {
    const repo = new SourceServerWorkspaceAliasRepo(options);
    await repo.getFailedPathCount();
    db.exec(`INSERT INTO workspace_migration_ledger
      (migration_id, path, canonical_key, variant_keys_json, status, phase, task_backup_path,
       created_at, updated_at, session_db_generation)
      VALUES ('active-plan', '/repo', 'canonical', '[]', 'running', 'task-db-merged', '/backup', 1, 2, 'frozen-generation');
      DELETE FROM workspace_migration_schema_version;
      DELETE FROM tasks_schema_migration WHERE id='0005_source_server_workspace_schema';`);
    const before = db.prepare("SELECT * FROM workspace_migration_ledger").all();
    await repo.getFailedPathCount();
    expect(db.prepare("SELECT * FROM workspace_migration_ledger").all()).toEqual(before);
  } finally {
    db.close();
  }
});

it("Source 首次创建 session identity 表时登记 schema_migration，已有 identity 保持不变", async () => {
  const options = await fixture();
  const taskDb = new DatabaseSync(options.taskDbPath);
  const sessionDb = new DatabaseSync(options.sessionDbPath);
  const canonical = "remote:ssh:one:22:u:/repo";
  const variant = "remote:ssh:two:22:u:/repo";
  try {
    await runTasksDatabaseMigrations(taskDb);
    const insert = taskDb.prepare(`INSERT INTO tasks
      (workspace_key, workspace_path, workspace_identity, task_id, created_at, updated_at)
      VALUES (?, '/repo', ?, ?, 1, ?)`);
    insert.run(canonical, canonical, "task-1", 20);
    insert.run(variant, variant, "task-2", 10);
    sessionDb.exec(`CREATE TABLE session (id TEXT PRIMARY KEY, workspace_id TEXT, directory TEXT, path TEXT, time_updated INTEGER);
      CREATE TABLE codez_database_identity (scope TEXT PRIMARY KEY, identity TEXT NOT NULL);
      INSERT INTO codez_database_identity VALUES ('session', 'legacy-generation');`);
    const repo = new SourceServerWorkspaceAliasRepo(options);
    await repo.resolveCanonicalWorkspaceKey({ workspacePath: "/repo", legacyRouteHint: canonical });
    expect(sessionDb.prepare("SELECT id FROM schema_migration").all()).toEqual([
      { id: "0024_session_database_identity" },
    ]);
    expect(sessionDb.prepare("SELECT identity FROM codez_database_identity").get()).toEqual({
      identity: "legacy-generation",
    });
  } finally {
    sessionDb.close();
    taskDb.close();
  }
});

it.each(["base", "controller-remote", "source-server"] as const)(
  "启动门禁与 %s scope 共用事务，已迁移时也完成交接提交",
  async (scope) => {
    const db = new DatabaseSync(":memory:");
    try {
      const migration: DatabaseMigrationFacts = {
        kind: "initialize",
        executedCount: 0,
        committedCount: 0,
      };
      const phases: string[] = [];
      db.exec("BEGIN IMMEDIATE");
      await runTasksDatabaseMigrations(db, {
        scope,
        transactionOpen: true,
        migration,
        onProgress: (phase) => phases.push(phase),
      });
      const expectedCount = scope === "base" ? 8 : 1;
      expect(db.isTransaction).toBe(false);
      expect(migration).toEqual({
        kind: "initialize",
        executedCount: expectedCount,
        committedCount: expectedCount,
        lastAppliedMigrationId: null,
      });
      expect(phases.filter((phase) => phase === "migrating")).toHaveLength(expectedCount);
      expect(phases.at(-1)).toBe("committing");
      const ledger = db.prepare("SELECT * FROM tasks_schema_migration ORDER BY id").all();
      const repeated: DatabaseMigrationFacts = {
        kind: "none",
        executedCount: 0,
        committedCount: 0,
      };
      db.exec("BEGIN IMMEDIATE");
      await runTasksDatabaseMigrations(db, { scope, transactionOpen: true, migration: repeated });
      expect(db.isTransaction).toBe(false);
      expect(repeated).toEqual({
        kind: "none",
        executedCount: 0,
        committedCount: 0,
        lastAppliedMigrationId: ledger.at(-1)?.id,
      });
      expect(db.prepare("SELECT * FROM tasks_schema_migration ORDER BY id").all()).toEqual(ledger);
    } finally {
      if (db.isTransaction) db.exec("ROLLBACK");
      db.close();
    }
  },
);

const equivalentHostId = "remote:server:srv:/";
const equivalentSshKey = "remote:ssh:one:22:u:/repo";
const equivalentServerKey = "remote:server:srv:/repo";

async function equivalentPathFixture() {
  const options = await fixture();
  const db = new DatabaseSync(options.taskDbPath);
  try {
    await runTasksDatabaseMigrations(db);
    await runTasksDatabaseMigrations(db, "source-server");
    await projectStorage.migrate(db, {
      hostId: equivalentHostId,
      backupDirectories: [options.backupRoot],
      now: () => Date.now(),
    });
  } finally {
    db.close();
  }
  return options;
}

function insertEquivalentTask(
  db: DatabaseSync,
  workspaceKey: string,
  workspacePath: string,
  taskId: string,
  metaJson = "{}",
) {
  db.prepare(
    `INSERT INTO tasks (workspace_key, workspace_path, workspace_identity, task_id,
        created_at, updated_at, host_id, root_path, cli_created_at, cli_updated_at, meta_json)
       VALUES (?, ?, ?, ?, 1, 1, ?, ?, 1, 1, ?)`,
  ).run(
    workspaceKey,
    workspacePath,
    workspaceKey,
    taskId,
    equivalentHostId,
    workspacePath,
    metaJson,
  );
}

it("等价尾斜杠路径重复 resolve 收敛同一 canonical 且 alias 单行", async () => {
  const options = await equivalentPathFixture();
  const repo = new SourceServerWorkspaceAliasRepo(options);
  await repo.resolveCanonicalWorkspaceKey({
    workspacePath: "/repo/",
    legacyRouteHint: equivalentSshKey,
  });
  await expect(
    repo.resolveCanonicalWorkspaceKey({
      workspacePath: "/repo",
      legacyRouteHint: equivalentSshKey,
    }),
  ).resolves.toEqual({ canonicalKey: equivalentSshKey, mergedKeys: [] });
  const db = new DatabaseSync(options.taskDbPath, { readOnly: true });
  try {
    expect(db.prepare("SELECT path, canonical_key FROM workspace_alias").all()).toEqual([
      { path: "/repo", canonical_key: equivalentSshKey },
    ]);
  } finally {
    db.close();
  }
});

it("历史等价路径 alias 分叉仅一方有状态时零搬运采纳有状态方，任务可解析可归档", async () => {
  const options = await equivalentPathFixture();
  const db = new DatabaseSync(options.taskDbPath);
  try {
    db.prepare(
      "INSERT INTO workspace_alias (path, canonical_key, created_at, updated_at) VALUES (?, ?, 1, 1)",
    ).run("/repo/", equivalentServerKey);
    db.prepare(
      "INSERT INTO workspace_alias (path, canonical_key, created_at, updated_at) VALUES (?, ?, 1, 1)",
    ).run("/repo", equivalentSshKey);
    insertEquivalentTask(db, equivalentSshKey, "/repo/", "task-1");
  } finally {
    db.close();
  }
  const repo = new SourceServerWorkspaceAliasRepo(options);
  const mapper = new SourceServerWorkspaceIdentityMapper();
  const stable = buildServerRemoteWorkspaceIdentity({
    serverId: "srv",
    workspacePath: "/repo/",
  });
  for (const workspacePath of ["/repo/", "/repo"]) {
    const resolved = await repo.resolveCanonicalWorkspaceKey({ workspacePath });
    expect(resolved).toEqual({ canonicalKey: equivalentSshKey, mergedKeys: [] });
    mapper.register({ stableIdentity: stable, canonicalIdentity: resolved.canonicalKey });
  }
  const check = new DatabaseSync(options.taskDbPath);
  try {
    expect(check.prepare("SELECT path FROM workspace_alias ORDER BY path").all()).toEqual([
      { path: "/repo" },
    ]);
    const projectRepo = new ProjectRepository(check, equivalentHostId);
    const mapped = mapper.mapIncoming({
      workspacePath: "/repo/",
      workspaceIdentity: stable,
      taskId: "task-1",
    });
    // 修复前这里抛 project.remote-project-required（映射覆盖后查不到 task 行）。
    expect(projectRepo.resolveSessionDirectories(mapped)).toMatchObject({
      workspacePath: "/repo/",
      projectId: null,
    });
    expect(projectRepo.readTaskCwd(mapped)).toBe("/repo/");
  } finally {
    check.close();
  }
});

it("历史等价路径 alias 双方有状态且任务不相交时复用合并流程收口单 canonical", async () => {
  const options = await equivalentPathFixture();
  const db = new DatabaseSync(options.taskDbPath);
  try {
    db.prepare(
      "INSERT INTO workspace_alias (path, canonical_key, created_at, updated_at) VALUES (?, ?, 1, 1)",
    ).run("/repo/", equivalentServerKey);
    db.prepare(
      "INSERT INTO workspace_alias (path, canonical_key, created_at, updated_at) VALUES (?, ?, 1, 1)",
    ).run("/repo", equivalentSshKey);
    insertEquivalentTask(db, equivalentServerKey, "/repo/", "task-a");
    insertEquivalentTask(db, equivalentSshKey, "/repo/", "task-b");
  } finally {
    db.close();
  }
  const repo = new SourceServerWorkspaceAliasRepo(options);
  const resolved = await repo.resolveCanonicalWorkspaceKey({ workspacePath: "/repo" });
  expect(resolved.mergedKeys).toEqual(
    resolved.canonicalKey === equivalentServerKey ? [equivalentSshKey] : [equivalentServerKey],
  );
  const check = new DatabaseSync(options.taskDbPath);
  try {
    expect(
      check.prepare("SELECT task_id, workspace_key FROM tasks ORDER BY task_id").all(),
    ).toEqual([
      { task_id: "task-a", workspace_key: resolved.canonicalKey },
      { task_id: "task-b", workspace_key: resolved.canonicalKey },
    ]);
    expect(check.prepare("SELECT path FROM workspace_alias").all()).toEqual([{ path: "/repo" }]);
    expect(check.prepare("SELECT status FROM workspace_migration_ledger").all()).toEqual([
      { status: "completed" },
    ]);
  } finally {
    check.close();
  }
});

it("历史等价路径 alias 双方有状态且配置目录冲突时 fail-closed 且不整合 alias", async () => {
  const options = await equivalentPathFixture();
  const db = new DatabaseSync(options.taskDbPath);
  try {
    db.prepare(
      "INSERT INTO workspace_alias (path, canonical_key, created_at, updated_at) VALUES (?, ?, 1, 1)",
    ).run("/repo/", equivalentServerKey);
    db.prepare(
      "INSERT INTO workspace_alias (path, canonical_key, created_at, updated_at) VALUES (?, ?, 1, 1)",
    ).run("/repo", equivalentSshKey);
    insertEquivalentTask(db, equivalentServerKey, "/repo/", "task-a");
    insertEquivalentTask(db, equivalentSshKey, "/repo/", "task-b");
  } finally {
    db.close();
  }
  // 配置目录哈希只吃 workspaceKey；两侧同相对路径不同字节触发既有 config 冲突 fail-closed。
  for (const [key, content] of [
    [equivalentServerKey, "A"],
    [equivalentSshKey, "B"],
  ] as const) {
    const dir = join(dirname(options.taskDbPath), "sessions", getWorkspaceHash("/repo", key));
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "settings.json"), content);
  }
  const repo = new SourceServerWorkspaceAliasRepo(options);
  const error = await repo
    .resolveCanonicalWorkspaceKey({ workspacePath: "/repo" })
    .catch((value: unknown) => value as Error & { code?: string; retryable?: boolean });
  expect(error).toBeInstanceOf(Error);
  expect((error as { code?: string }).code).toBe("workspace-config-file-conflict");
  expect((error as { retryable?: boolean }).retryable).toBe(false);
  const check = new DatabaseSync(options.taskDbPath);
  try {
    expect(check.prepare("SELECT path FROM workspace_alias ORDER BY path").all()).toEqual([
      { path: "/repo" },
      { path: "/repo/" },
    ]);
    expect(
      check.prepare("SELECT DISTINCT workspace_key FROM tasks ORDER BY workspace_key").all(),
    ).toEqual([{ workspace_key: equivalentServerKey }, { workspace_key: equivalentSshKey }]);
  } finally {
    check.close();
  }
});

it("旧尾斜杠路径建键的活动 ledger 可被归一化路径输入续跑", async () => {
  const options = await equivalentPathFixture();
  const db = new DatabaseSync(options.taskDbPath);
  try {
    db.prepare(
      `INSERT INTO workspace_migration_ledger (migration_id, path, canonical_key,
        variant_keys_json, status, phase, task_backup_path, session_backup_path,
        created_at, updated_at)
       VALUES ('migration-legacy', '/repo/', ?, ?, 'running', 'preflight', ?, NULL, 1, 1)`,
    ).run(
      equivalentServerKey,
      JSON.stringify([equivalentServerKey, equivalentSshKey]),
      join(options.backupRoot, "migration-legacy", "tasks-index.sqlite"),
    );
    insertEquivalentTask(db, equivalentServerKey, "/repo/", "task-a");
    insertEquivalentTask(db, equivalentSshKey, "/repo/", "task-b");
  } finally {
    db.close();
  }
  const repo = new SourceServerWorkspaceAliasRepo(options);
  const resolved = await repo.resolveCanonicalWorkspaceKey({ workspacePath: "/repo" });
  expect(resolved).toMatchObject({
    canonicalKey: equivalentServerKey,
    migrationId: "migration-legacy",
  });
  const check = new DatabaseSync(options.taskDbPath);
  try {
    expect(
      check.prepare("SELECT task_id, workspace_key FROM tasks ORDER BY task_id").all(),
    ).toEqual([
      { task_id: "task-a", workspace_key: equivalentServerKey },
      { task_id: "task-b", workspace_key: equivalentServerKey },
    ]);
  } finally {
    check.close();
  }
});
