// bridge 自有附件对象的计量与清理（specs/codex-session-data-purge.md「附件作用域」）。
//
// 为什么必须由 bridge 自己做：附件对象在 `<bridgeHome>/<sha256(workspaceIdentity)>/attachments/objects`，
// 不在 CODEX_HOME，原生 thread/delete 完全不知道它们存在（thread_data_cleanup 只清 agent message
// board，codex-rs/core/src/thread_manager.rs:480-492），所以「彻底删除」少了这一步就永远泄漏。
//
// 归属证明：manifest 里的 `upload.sessionId` 是唯一权威。附件读取路径强制
// `upload.sessionId === 请求方 sessionId`（attachments-files.ts:414-431），跨会话借用 ref 会被
// refNotAuthorized 拒绝，原生历史里的图片也是给读取方另建 derived 副本（:381-407）——
// 因此存活会话读不到被删会话的对象，不需要 legacy CLI 那种引用不动点迭代。
//
// 边界：只 unlink 枚举出来的 `objects/<uuid>.data` 与 `objects/<uuid>.json`，逐个校验常规文件、
// 非符号链接、nlink===1；绝不删目录，绝不动 `staging/`（可能有在途上传）。
import { lstat, readdir, unlink } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { openAttachmentFile } from "./attachments-files.js";
import { SessionDataFault } from "./session-data-native-db.js";
import { isThreadId } from "./session-data-files.js";

const SCOPE_DIR_NAME = /^[0-9a-f]{64}$/i;
const ATTACHMENT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MANIFEST_MAX_BYTES = 16 * 1024;
const DEFAULT_MAX_SCOPES = 64;
const DEFAULT_MAX_OBJECTS = 100_000;

/** 只校验本模块据以行动的字段；未知字段按 zod 默认剥离，不因原生新增字段而拒绝。 */
const manifestSchema = z.object({
  version: z.literal(1),
  workspace: z.string().min(1),
  id: z.string().regex(ATTACHMENT_ID),
  upload: z.object({ sessionId: z.string().min(1) }),
});

export interface AttachmentObject {
  id: string;
  sessionId: string;
  dataPath: string;
  manifestPath: string;
  /** 删前 lstat 得到的字节数；blob 已缺失时为 0。 */
  bytes: number;
}

export interface AttachmentScanLimits {
  maxScopes?: number;
  maxObjects?: number;
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    const stats = await lstat(path);
    return stats.isDirectory() && !stats.isSymbolicLink();
  } catch (error) {
    // 只有 ENOENT 才是「没有附件」；权限/IO 错误不能当成空目录，
    // 否则 EACCES 的 objects 目录会把整棵树的附件判成不存在（fail-open）。
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw new SessionDataFault("attachment-scan-failed", `cannot inspect attachment store ${path}`);
  }
}

/**
 * 本机全部 bridge 作用域目录。载体可能是管理面 bridge（它自己的 scope 里没有目标工作区的对象），
 * 所以按已授权的本机全局控制面枚举全部 scope；目录名必须是 64 位十六进制，其他一律忽略。
 */
export async function listBridgeAttachmentScopes(
  bridgeHome: string,
  limits: AttachmentScanLimits = {},
): Promise<string[]> {
  const maxScopes = limits.maxScopes ?? DEFAULT_MAX_SCOPES;
  let entries;
  try {
    entries = await readdir(bridgeHome, { withFileTypes: true });
  } catch (error) {
    // bridgeHome 不存在 = 这台机器还没有任何 bridge 附件，是可证明的空集。
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw new SessionDataFault("attachment-scan-failed", "cannot list bridge home");
  }
  const scopes: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
    if (!SCOPE_DIR_NAME.test(entry.name)) continue;
    const objects = join(bridgeHome, entry.name, "attachments", "objects");
    if (!(await isDirectory(objects))) continue;
    if (scopes.length >= maxScopes)
      throw new SessionDataFault(
        "attachment-scan-too-large",
        "bridge attachment scopes exceeded budget",
      );
    scopes.push(join(bridgeHome, entry.name, "attachments"));
  }
  return scopes;
}

/**
 * 枚举归属给定会话树的附件对象。manifest 读不出/解析失败计入 unreadable：
 * 无法证明归属就不能删，但也不能假装这些数据不存在，调用方据此 fail-closed。
 */
export async function listOwnedAttachmentObjects(
  scopes: readonly string[],
  sessionIds: ReadonlySet<string>,
  limits: AttachmentScanLimits = {},
): Promise<{ objects: AttachmentObject[]; unreadable: number }> {
  const wanted = new Set([...sessionIds].map((id) => id.toLowerCase()));
  const objects: AttachmentObject[] = [];
  let unreadable = 0;
  let visited = 0;
  if (wanted.size === 0 || scopes.length === 0) return { objects, unreadable };
  const maxVisited = limits.maxObjects ?? DEFAULT_MAX_OBJECTS;
  for (const scopeRoot of scopes) {
    const objectsDir = join(scopeRoot, "objects");
    let entries;
    try {
      entries = await readdir(objectsDir, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw new SessionDataFault("attachment-scan-failed", "cannot list attachment objects");
    }
    for (const entry of entries) {
      // 预算按**扫描过的条目**计，不按命中数计：否则一个装着大量无关对象的 store
      // 可以被无限扫描下去，预算形同不存在。
      if (++visited > maxVisited)
        throw new SessionDataFault(
          "attachment-scan-too-large",
          "bridge attachment objects exceeded budget",
        );
      if (!entry.isFile() || entry.isSymbolicLink() || !entry.name.endsWith(".json")) continue;
      const id = entry.name.slice(0, -".json".length);
      if (!ATTACHMENT_ID.test(id)) continue;
      const manifestPath = join(objectsDir, entry.name);
      let manifest: z.infer<typeof manifestSchema>;
      try {
        const handle = await openAttachmentFile(manifestPath, MANIFEST_MAX_BYTES);
        try {
          manifest = manifestSchema.parse(JSON.parse((await handle.readFile()).toString("utf8")));
        } finally {
          await handle.close();
        }
      } catch {
        unreadable += 1;
        continue;
      }
      if (manifest.id.toLowerCase() !== id.toLowerCase()) {
        unreadable += 1;
        continue;
      }
      const sessionId = manifest.upload.sessionId.toLowerCase();
      if (!wanted.has(sessionId) || !isThreadId(sessionId)) continue;
      objects.push({
        id,
        sessionId,
        dataPath: join(objectsDir, `${id}.data`),
        manifestPath,
        bytes: await regularFileBytes(join(objectsDir, `${id}.data`)),
      });
    }
  }
  return { objects, unreadable };
}

async function regularFileBytes(path: string): Promise<number> {
  try {
    const stats = await lstat(path);
    return stats.isFile() && !stats.isSymbolicLink() && stats.nlink === 1 ? stats.size : 0;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0;
    throw new SessionDataFault("attachment-stat-failed", `cannot stat attachment ${path}`);
  }
}

async function unlinkObject(path: string): Promise<void> {
  try {
    await unlink(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
}

/**
 * 删除已证明归属的附件对象，只统计确认从磁盘消失的字节。
 * 任一对象删不掉都按 errno 记入 failed，由调用方保留重试索引；不做递归删除。
 */
export async function removeAttachmentObjects(
  objects: readonly AttachmentObject[],
): Promise<{ bytes: number; failed: Array<{ id: string; code: string }> }> {
  let bytes = 0;
  const failed: Array<{ id: string; code: string }> = [];
  for (const object of objects) {
    try {
      // 以 unlink 前一刻的真实大小计量：调用方传进来的 bytes 可能来自更早的一次列举，
      // 重试时对象可能已经消失，照旧累加会把没删的字节报成已释放。
      const present = await regularFileBytes(object.dataPath);
      await unlinkObject(object.dataPath);
      await unlinkObject(object.manifestPath);
      const remaining = await regularFileBytes(object.dataPath);
      if (remaining > 0) {
        failed.push({ id: object.id, code: "attachment-remains" });
        continue;
      }
      bytes += present;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException)?.code;
      failed.push({ id: object.id, code: typeof code === "string" && code ? code : "unknown" });
    }
  }
  return { bytes, failed };
}
