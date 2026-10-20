import { randomUUID } from "node:crypto";
import { link, mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { join } from "node:path";
import { hostname } from "node:os";
import { worktreeRemovalError } from "./gitRemovalErrors.js";

export interface WorktreeRemovalRecord {
  version: 1;
  action: "remove";
  operationId: string;
  requestFingerprint: string;
  repositoryIdentity: string;
  targetPath: string;
  treeIdentity: string;
  state: "reserved" | "completed";
}

export function validateRemovalOperationId(value: string): void {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value)) {
    throw worktreeRemovalError("operation-conflict", "Invalid worktree removal operation ID.");
  }
}

const recordDirectory = (commonDir: string) => join(commonDir, "codez/worktree-operations");
const recordPath = (commonDir: string, id: string) =>
  join(recordDirectory(commonDir), `${id}.json`);
const absent = (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT";

export async function loadRemovalRecord(
  commonDir: string,
  id: string,
  requestFingerprint: string,
  repositoryIdentity: string,
): Promise<WorktreeRemovalRecord | null> {
  let raw: string;
  try {
    raw = await readFile(recordPath(commonDir, id), "utf8");
  } catch (error) {
    if (absent(error)) return null;
    throw error;
  }
  let record: Partial<WorktreeRemovalRecord>;
  try {
    record = JSON.parse(raw) as Partial<WorktreeRemovalRecord>;
  } catch {
    throw worktreeRemovalError("operation-conflict", "Worktree operation record is invalid.");
  }
  if (
    !record ||
    record.version !== 1 ||
    record.action !== "remove" ||
    record.operationId !== id ||
    record.requestFingerprint !== requestFingerprint ||
    record.repositoryIdentity !== repositoryIdentity ||
    typeof record.targetPath !== "string" ||
    typeof record.treeIdentity !== "string" ||
    !["reserved", "completed"].includes(record.state ?? "")
  ) {
    throw worktreeRemovalError(
      "operation-conflict",
      "Operation ID belongs to a different or invalid request.",
    );
  }
  return record as WorktreeRemovalRecord;
}

export async function saveRemovalRecord(
  commonDir: string,
  record: WorktreeRemovalRecord,
  createOnly = false,
) {
  const path = recordPath(commonDir, record.operationId);
  const temporary = `${path}.${randomUUID()}.tmp`;
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(record)}\n`);
    await handle.sync();
    await handle.close();
    if (createOnly) {
      try {
        await link(temporary, path);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST") {
          throw worktreeRemovalError(
            "operation-conflict",
            "Operation ID was reserved by another request.",
          );
        }
        throw error;
      }
    } else await rename(temporary, path);
  } finally {
    await handle.close().catch(() => {});
    await unlink(temporary).catch((error: unknown) => {
      if (!absent(error)) throw error;
    });
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

export async function withRemovalLock<T>(
  commonDir: string,
  id: string,
  run: () => Promise<T>,
): Promise<T> {
  await mkdir(recordDirectory(commonDir), { recursive: true });
  const lock = join(recordDirectory(commonDir), `${id}.remove-lock`);
  const token = JSON.stringify({ pid: process.pid, host: hostname(), nonce: randomUUID() });
  const temporary = `${lock}.${randomUUID()}.tmp`;
  const file = await open(temporary, "wx", 0o600);
  try {
    await file.writeFile(token);
    await file.sync();
  } finally {
    await file.close();
  }
  try {
    try {
      await link(temporary, lock);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      try {
        await link(temporary, `${lock}.recovery`);
      } catch {
        throw worktreeRemovalError("unknown", "Removal lock recovery is already executing.");
      }
      try {
        let old: string;
        try {
          old = await readFile(lock, "utf8");
        } catch (readError) {
          if (!absent(readError)) throw readError;
          await link(temporary, lock);
          old = token;
        }
        if (old !== token) {
          let owner: { pid?: unknown; host?: unknown } = {};
          try {
            owner = JSON.parse(old) as typeof owner;
          } catch {
            /* 不猜测锁所有者。 */
          }
          if (
            typeof owner.pid !== "number" ||
            !Number.isSafeInteger(owner.pid) ||
            owner.pid <= 0 ||
            owner.host !== hostname() ||
            isProcessAlive(owner.pid)
          ) {
            throw worktreeRemovalError("unknown", "This removal operation is already executing.");
          }
          // 恢复 gate 串行化两个重试方，防止它们都按旧 PID 删除另一个刚获得的新锁。
          await unlink(lock);
          await link(temporary, lock);
        }
      } finally {
        await unlink(`${lock}.recovery`);
      }
    }
    try {
      return await run();
    } finally {
      if ((await readFile(lock, "utf8")) === token) await unlink(lock);
    }
  } finally {
    await unlink(temporary);
  }
}
