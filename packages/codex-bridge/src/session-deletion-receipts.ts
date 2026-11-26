// #38：原生删除不返回后代集合，完成凭据必须在清 pending 前落盘，才能跨重启补清 Host 索引。
// 只保留身份哈希、操作/清单版本和会话 ID；绝不保存标题、正文、路径或文件清单。
import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import type { V4SessionDeletionParams } from "@codez/shared/codez-protocol-v4";
import { SessionDataFault } from "./session-data-native-db.js";
import { bridgeHomeOf, type SessionDataDeps } from "./session-data.js";

const receiptSchema = z
  .object({
    version: z.literal(1),
    rootId: z.string().uuid(),
    revision: z.string().regex(/^[a-f0-9]{64}$/),
    operationId: z.string().min(1).max(1024),
    sessionIds: z.array(z.string().uuid()).min(1).max(4096),
  })
  .strict();
export type SessionDeletionReceipt = z.infer<typeof receiptSchema>;

export function deletionIdentity(params: V4SessionDeletionParams): string {
  return params.workspace.workspaceIdentity?.trim() || params.workspace.workspacePath;
}

function receiptPath(params: V4SessionDeletionParams, deps: SessionDataDeps): string {
  const key = createHash("sha256")
    .update(JSON.stringify([deletionIdentity(params), params.sessionId.toLowerCase()]))
    .digest("hex");
  return join(bridgeHomeOf(deps), "session-deletions", `${key}.json`);
}

export async function readDeletionReceipt(
  params: V4SessionDeletionParams,
  deps: SessionDataDeps,
): Promise<SessionDeletionReceipt | undefined> {
  const path = receiptPath(params, deps);
  try {
    const stat = await lstat(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 256 * 1024)
      throw new Error("invalid receipt file");
    const receipt = receiptSchema.parse(JSON.parse(await readFile(path, "utf8")));
    if (
      receipt.rootId !== params.sessionId.toLowerCase() ||
      !receipt.sessionIds.includes(receipt.rootId)
    )
      throw new Error("receipt identity mismatch");
    return receipt;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new SessionDataFault("deletion-receipt-unreadable", "cannot verify deletion receipt");
  }
}

export async function writeDeletionReceipt(
  params: V4SessionDeletionParams,
  deps: SessionDataDeps,
  receipt: SessionDeletionReceipt,
): Promise<void> {
  const path = receiptPath(params, deps);
  const temporary = `${path}.${randomUUID()}.tmp`;
  await mkdir(join(bridgeHomeOf(deps), "session-deletions"), { recursive: true });
  try {
    await writeFile(temporary, JSON.stringify(receiptSchema.parse(receipt)), {
      flag: "wx",
      mode: 0o600,
    });
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}
