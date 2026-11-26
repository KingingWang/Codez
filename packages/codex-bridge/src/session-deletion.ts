// #38：归档专用协议缺失导致 Codex 预检恒为 0。复用 session-data 事实和唯一原生删除路径，
// 在同一维护屏障里校验确认版本，不把 measure/purge 的异形返回值直接透传给归档 UI。
import { createHash } from "node:crypto";
import { lstat } from "node:fs/promises";
import { isAbsolute } from "node:path";
import {
  v4SessionDeletionParamsSchema,
  v4SessionDeletionExecuteParamsSchema,
  v4SessionDeletionPreviewBatchParamsSchema,
  v4SessionDeletionPreviewBatchResultSchema,
  v4SessionDeletionPreviewSchema,
  v4SessionDeletionResultSchema,
  type V4SessionDeletionParams,
  type V4SessionDeletionPreview,
  type V4SessionDeletionPreviewBatchItem,
  type V4SessionDeletionResult,
} from "@codez/shared/codez-protocol-v4";
import { sameExecutionPath } from "./execution-path.js";
import {
  collectFacts,
  bridgeHomeOf,
  purgeSessionData,
  type SessionDataDeps,
  type SessionFacts,
} from "./session-data.js";
import { SessionDataFault } from "./session-data-native-db.js";
import { clearPendingTree } from "./session-data-files.js";
import {
  deletionIdentity,
  readDeletionReceipt,
  writeDeletionReceipt,
  type SessionDeletionReceipt,
} from "./session-deletion-receipts.js";

function errorCode(error: unknown): string {
  return error instanceof SessionDataFault ? error.code : "unavailable";
}

function completedPreview(
  params: V4SessionDeletionParams,
  receipt: SessionDeletionReceipt,
): V4SessionDeletionPreview {
  return {
    sessionId: params.sessionId,
    revision: receipt.revision,
    sessionIds: receipt.sessionIds,
    forks: [],
    retainedArtifacts: [],
    deletedFiles: 0,
    incomplete: false,
    completed: true,
  };
}

function unavailablePreview(sessionId: string): V4SessionDeletionPreview {
  return {
    sessionId,
    revision: "",
    sessionIds: [],
    forks: [],
    retainedArtifacts: [],
    deletedFiles: 0,
    blockedReason: "unavailable",
    incomplete: false,
    completed: false,
  };
}

async function previewFacts(
  params: V4SessionDeletionParams,
  facts: SessionFacts,
): Promise<V4SessionDeletionPreview> {
  if (facts.fault) throw facts.fault;
  const tree = facts.tree!;
  // 管理面 cwd 与目标无关，但请求的执行路径必须属于目标；身份则独立绑定 revision/凭据。
  if (
    !isAbsolute(params.workspace.workspacePath) ||
    (!tree.rootAbsent &&
      (!tree.rootCwd || !(await sameExecutionPath(params.workspace.workspacePath, tree.rootCwd))))
  )
    throw new SessionDataFault("workspace-mismatch", "deletion workspace does not own thread");
  const sessionIds = [...facts.threadIds].sort();
  if (sessionIds.length > 4096)
    throw new SessionDataFault("tree-too-large", "deletion receipt exceeds tree budget");
  const paths = [
    ...new Set([
      ...[...facts.rollouts.values()].flat(),
      ...facts.attachments.flatMap((attachment) => [attachment.dataPath, attachment.manifestPath]),
    ]),
  ].sort();
  const files: unknown[] = [];
  for (const path of paths) {
    try {
      const stat = await lstat(path);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1)
        throw new SessionDataFault("file-identity-unavailable", "cannot verify deletion file");
      files.push([path, stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs]);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  const blockedReason: V4SessionDeletionPreview["blockedReason"] = facts.unreadableManifests
    ? "unavailable"
    : tree.members.some((member) => member.writerConflict)
      ? "in-use"
      : tree.members.some((member) => member.activity === "running")
        ? "running"
        : tree.members.some((member) => member.activity === "unknown")
          ? "unavailable"
          : tree.rootAbsent && !facts.pending
            ? "not-found"
            : undefined;
  const revision = createHash("sha256")
    .update(
      JSON.stringify({
        identity: deletionIdentity(params),
        rootId: tree.rootId,
        sessionIds,
        members: tree.members.map((member) => [member.id, member.cwd, member.updatedAt]).sort(),
        files,
      }),
    )
    .digest("hex");
  return v4SessionDeletionPreviewSchema.parse({
    sessionId: params.sessionId,
    revision,
    sessionIds,
    forks: [],
    retainedArtifacts: [],
    deletedFiles: files.length,
    ...(blockedReason ? { blockedReason } : {}),
    incomplete: Boolean(facts.pending),
    completed: false,
  });
}

export async function previewSessionDeletions(rawParams: unknown, deps: SessionDataDeps) {
  const { items } = v4SessionDeletionPreviewBatchParamsSchema.parse(rawParams);
  const results: V4SessionDeletionPreviewBatchItem[] = [];
  const pending: number[] = [];
  // 已完成凭据无需再读原生事实；其他项读取失败不能阻止它补清 Host 索引。
  await Promise.all(
    items.map(async (item, index) => {
      try {
        const receipt = await readDeletionReceipt(item, deps);
        if (receipt) results[index] = { preview: completedPreview(item, receipt) };
        else pending.push(index);
      } catch (error) {
        results[index] = { error: { code: errorCode(error) } };
      }
    }),
  );
  if (pending.length) {
    try {
      const ids = [...new Set(pending.map((index) => items[index]!.sessionId.toLowerCase()))];
      const facts = await collectFacts(deps, ids, { tolerateFaults: true, includePending: true });
      await Promise.all(
        pending.map(async (index) => {
          const item = items[index]!;
          try {
            results[index] = {
              preview: await previewFacts(item, facts.get(item.sessionId.toLowerCase())!),
            };
          } catch (error) {
            results[index] = { error: { code: errorCode(error) } };
          }
        }),
      );
    } catch (error) {
      for (const index of pending) results[index] = { error: { code: errorCode(error) } };
    }
  }
  return v4SessionDeletionPreviewBatchResultSchema.parse({ results });
}

export async function previewSessionDeletion(
  rawParams: unknown,
  deps: SessionDataDeps,
): Promise<V4SessionDeletionPreview> {
  const params = v4SessionDeletionParamsSchema.parse(rawParams);
  try {
    const { results } = await previewSessionDeletions({ items: [params] }, deps);
    const result = results[0]!;
    return "preview" in result ? result.preview : unavailablePreview(params.sessionId);
  } catch {
    return unavailablePreview(params.sessionId);
  }
}

export async function executeSessionDeletion(
  rawParams: unknown,
  deps: SessionDataDeps,
): Promise<V4SessionDeletionResult> {
  const params = v4SessionDeletionExecuteParamsSchema.parse(rawParams);
  const result = (
    status: V4SessionDeletionResult["status"],
    sessionIds: string[],
    reason?: string,
  ) =>
    v4SessionDeletionResultSchema.parse({
      sessionId: params.sessionId,
      status,
      sessionIds,
      retainedArtifacts: 0,
      ...(reason ? { reason } : {}),
    });
  let acceptedIds: string[] = [];
  try {
    if (params.operationId.length > 1024)
      throw new SessionDataFault("invalid-operation-id", "operation id exceeds receipt budget");
    const receipt = await readDeletionReceipt(params, deps);
    if (receipt) {
      if (params.revision !== receipt.revision) return result("blocked", [], "changed");
      // 完成凭据已证明清理成功；跨重启重试只补做非破坏性的 tombstone/pending 收尾。
      await clearPendingTree(`${bridgeHomeOf(deps)}/session-data-pending`, params.sessionId);
      for (const id of receipt.sessionIds) deps.store.remove(id);
      return result("deleted", receipt.sessionIds);
    }
    const purged = await purgeSessionData(
      { sessionIds: [params.sessionId], directories: [] },
      deps,
      {
        async beforeDelete(_id, facts) {
          const preview = await previewFacts(params, facts);
          if (preview.blockedReason)
            throw new SessionDataFault(preview.blockedReason, "deletion blocked");
          if (preview.revision !== params.revision)
            throw new SessionDataFault("changed", "deletion preview changed");
          acceptedIds = preview.sessionIds;
        },
        async afterDelete(_id, threadIds) {
          await writeDeletionReceipt(params, deps, {
            version: 1,
            rootId: params.sessionId.toLowerCase(),
            operationId: params.operationId,
            revision: params.revision,
            sessionIds: [...threadIds].sort(),
          });
        },
      },
    );
    if (purged.deleted.length) return result("deleted", acceptedIds);
    const kept = purged.kept[0];
    if (kept) return result("blocked", [], kept.reason === "running" ? "running" : "in-use");
    const code = purged.failed[0]?.code ?? "unavailable";
    if (
      [
        "changed",
        "in-use",
        "running",
        "not-found",
        "workspace-mismatch",
        "writer-conflict",
      ].includes(code)
    )
      return result(
        "blocked",
        [],
        code === "writer-conflict"
          ? "in-use"
          : code === "workspace-mismatch"
            ? "unavailable"
            : code,
      );
    return result("incomplete", acceptedIds, code);
  } catch (error) {
    return result("incomplete", acceptedIds, errorCode(error));
  }
}
