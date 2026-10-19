/**
 * project-storage 标准调用示例：agent 靠模仿写代码，这里放的就是该模仿的那份。
 */
import type { DatabaseSync } from "node:sqlite";
import type { ProjectStorageContract } from "#src/project-storage/contract.js";

export async function exampleProjectStorage(
  port: ProjectStorageContract,
  db: DatabaseSync,
  backupDirectory: string,
): Promise<void> {
  await port.migrate(db, { backupDirectories: [backupDirectory] });
}

/** 调用方已在同一写事务插入原生线程任务行；仅首次写入 Host 组织归属。 */
export function exampleAdmitNativeProjectOrigin(
  port: ProjectStorageContract,
  db: DatabaseSync,
  taskId: string,
  projectId: string | null,
): void {
  port.admitTaskIdentity(db, { workspacePath: "/project", taskId }, "local", projectId);
}
