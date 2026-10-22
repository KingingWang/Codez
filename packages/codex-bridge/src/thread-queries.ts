import {
  compactConversationRowForWire,
  sessionsIndexReconcileParamsSchema,
  sessionsIndexReconcileResultSchema,
  v4ConversationPlansParamsSchema,
  v4ConversationRowPayloadParamsSchema,
  v4ConversationRowPayloadResultSchema,
  v4ConversationRowsRangeParamsSchema,
  type ConversationSnapshot,
  type SessionsIndexReconcileResult,
  type V4ConversationPlansResult,
  type V4ConversationRowPayloadResult,
  type V4ConversationRowsRangeResult,
} from "@codez/shared/codez-protocol-v4";
import type { CodexRpcPort } from "./contract.js";
import { codexThreadSchema } from "./codex-types.js";
import { decorateNativeThread } from "./command-input.js";
import { assertWritableThreadState } from "./control-common.js";
import { sameExecutionPath } from "./execution-path.js";
import { array, object, type JsonObject } from "./json.js";
import { paginateNativeRows } from "./native-paging.js";
import { canonicalNativeThreads } from "./projection.js";
import { nativeThreadTitle } from "./native-thread-title.js";
import { CodexRpcError } from "./rpc-errors.js";
import { parentThreadIdOf, parentThreadOwnedByWorkspace } from "./thread-load.js";
import { DeletedThreadError, type ThreadProjectionState } from "./thread-state-types.js";

/** 原生 thread/read 对不存在或已删除会话返回的未加载错误。 */
function isMissingNativeThreadReadError(error: unknown): boolean {
  return (
    error instanceof CodexRpcError &&
    error.code === -32600 &&
    error.message.includes("thread not loaded")
  );
}

/** 原生 thread/delete 对尚未物化或已删除 rollout 返回的缺失错误。 */
function isMissingNativeRolloutDeleteError(error: unknown): boolean {
  return (
    error instanceof CodexRpcError &&
    error.code === -32600 &&
    error.message.includes("no rollout found")
  );
}

/**
 * 执行 v4 deleteSession：
 * 修复原因：过去 deleteSession 先调 store.ensure(thread/resume) 再删除，对已收到 thread/deleted
 * 的会话抛 DeletedThreadError，对未加载会话不必要地触发 resume，对无 rollout 的草稿/已删会话
 * 因原生报错而失败。这里对未加载会话只走免锁 thread/read 校验工作区归属与只读门禁，
 * 并将已删除/无 rollout 视为幂等完成，同时写入 store tombstone 供后续 reconcile 确认。
 */
export async function deleteBridgeThread(input: {
  sessionId: string;
  rpc: CodexRpcPort;
  cwd: string;
  store: {
    get(id: string): ThreadProjectionState | undefined;
    isDeleted(id: string): boolean;
    remove(id: string): void;
  };
  cancelTitle?: (id: string) => void;
}): Promise<void> {
  const { sessionId, rpc, cwd, store, cancelTitle } = input;
  if (store.isDeleted(sessionId)) {
    cancelTitle?.(sessionId);
    return;
  }
  let metadata: JsonObject | undefined = store.get(sessionId)?.thread;
  const state = store.get(sessionId);
  if (state) {
    assertWritableThreadState(state, "deleteSession");
  } else {
    try {
      const read = object(await rpc.request("thread/read", { threadId: sessionId }));
      metadata = decorateNativeThread(read);
    } catch (error) {
      if (error instanceof DeletedThreadError || isMissingNativeThreadReadError(error)) {
        cancelTitle?.(sessionId);
        store.remove(sessionId);
        return;
      }
      throw error;
    }
    if (parentThreadIdOf(metadata) !== undefined) {
      assertWritableThreadState({ readOnly: "subagent-child" }, "deleteSession");
    }
    if (!(await sameExecutionPath(metadata.cwd, cwd))) {
      throw new Error("Thread belongs to a different workspace");
    }
  }
  const running =
    (typeof metadata?.status === "object" &&
      metadata.status !== null &&
      (metadata.status as { type?: unknown }).type === "active") ||
    array(metadata?.turns)
      .map(object)
      .some((turn) => turn.status === "inProgress");
  if (running) throw new Error("Stop the active turn before deleting");
  cancelTitle?.(sessionId);
  try {
    await rpc.request("thread/delete", { threadId: sessionId });
  } catch (error) {
    if (!isMissingNativeRolloutDeleteError(error)) throw error;
  }
  store.remove(sessionId);
}

/**
 * v4/sessionsIndex/reconcile：按明确 sessionIds 查询持久事实，不创建或恢复运行实例。
 * 修复原因：bridge 此前未实现该 RPC，导致归档删除/重命名后的 refresh 固定报
 * "Codex adapter does not support v4/sessionsIndex/reconcile"，UI 将已删除会话计入失败。
 */
export async function reconcileBridgeSessions(
  params: unknown,
  input: {
    rpc: CodexRpcPort;
    cwd: string;
    workspaceId: string;
    store: {
      get(id: string): ThreadProjectionState | undefined;
      isDeleted(id: string): boolean;
    };
  },
): Promise<SessionsIndexReconcileResult> {
  const parsed = sessionsIndexReconcileParamsSchema.parse(params);
  if (
    parsed.workspaceId !== input.workspaceId &&
    !(await sameExecutionPath(parsed.workspaceId, input.cwd))
  ) {
    throw Object.assign(new Error("Request workspace scope mismatch"), { code: -32602 });
  }
  const uniqueIds = [...new Set(parsed.sessionIds)];
  const sessions = await Promise.all(
    uniqueIds.map(async (sessionId) => {
      if (input.store.isDeleted(sessionId)) {
        return {
          sessionId,
          exists: true as const,
          deleted: true,
          title: "",
          titleSource: "default" as const,
          createdAt: 0,
          updatedAt: 0,
        };
      }
      const cached = input.store.get(sessionId)?.thread;
      let metadata: JsonObject;
      if (cached) {
        metadata = cached;
      } else {
        try {
          const read = object(await input.rpc.request("thread/read", { threadId: sessionId }));
          metadata = decorateNativeThread(read);
        } catch {
          return { sessionId, exists: false as const, deleted: false as const };
        }
      }
      if (
        parentThreadIdOf(metadata) !== undefined ||
        !(await sameExecutionPath(metadata.cwd, input.cwd))
      ) {
        return { sessionId, exists: false as const, deleted: false as const };
      }
      const thread = codexThreadSchema.parse({
        ...metadata,
        cwd: input.cwd,
        turns: array(metadata.turns),
      });
      const last = thread.turns.at(-1);
      const lastOutcome =
        thread.status.type === "systemError" || last?.status === "failed"
          ? ("error" as const)
          : last?.status === "interrupted"
            ? ("interrupted" as const)
            : last?.status === "completed"
              ? ("completed" as const)
              : undefined;
      return {
        sessionId,
        exists: true as const,
        deleted: false,
        title: nativeThreadTitle(thread),
        titleSource: "default" as const,
        createdAt: thread.createdAt * 1000,
        updatedAt: thread.updatedAt * 1000,
        ...(lastOutcome ? { lastOutcome } : {}),
      };
    }),
  );
  return sessionsIndexReconcileResultSchema.parse({ sessions });
}

/** 工作区会话列表：原生 thread/list 分页 + 物理路径归属过滤（不触碰投影缓存）。 */
export async function listWorkspaceThreads(rpc: CodexRpcPort, cwd: string): Promise<unknown[]> {
  const rows = await paginateNativeRows(
    rpc,
    "thread/list",
    {
      cwd,
      // 原生默认只列当前 provider 的交互来源；项目历史应包含 CLI/exec 与桌面
      // 创建的会话，切换 provider 也不能让旧记录消失。空数组显式取消 provider 过滤。
      modelProviders: [],
      sourceKinds: ["cli", "vscode", "exec", "appServer"],
      archived: false,
    },
    "thread",
  );
  // CLI/exec 落盘的是规范化物理路径；按物理目录过滤，别名拼写才不会把列表判空。
  const owned = await Promise.all(rows.map((row) => sameExecutionPath(object(row).cwd, cwd)));
  // 分页只收集原始事实；完整校验与同 ID rollout 选择由投影单一 owner 处理。
  return canonicalNativeThreads(rows.filter((_, index) => owned[index]));
}

/**
 * 按指定 sessionIds 读取线程身份（供 subscribeConversationV4 父链回溯与子代理索引修复使用）。
 * 修复原因：过去 session/list 忽略 sessionIds 全量调用 thread/list 扫描工作区全部历史，
 * 且 thread/list 的 sourceKinds 不含 subAgent*，既拖慢每次会话订阅（远端实测 1.4s+）又查不到冷启子线程。
 * 这里优先复用已加载状态，未加载时只做免锁只读 thread/read，不触发 resume 或全量扫描。
 */
export async function listTargetedThreads(
  rpc: CodexRpcPort,
  cwd: string,
  sessionIds: readonly string[],
  getCachedThread: (id: string) => JsonObject | undefined,
): Promise<unknown[]> {
  const uniqueIds = [...new Set(sessionIds)];
  const resolved = await Promise.all(
    uniqueIds.map(async (id) => {
      const cached = getCachedThread(id);
      let metadata: JsonObject;
      if (cached) {
        metadata = cached;
      } else {
        try {
          const read = object(await rpc.request("thread/read", { threadId: id }));
          metadata = decorateNativeThread(read);
        } catch {
          return null;
        }
      }
      const parentThreadId = parentThreadIdOf(metadata);
      const ownedByWorkspace = await sameExecutionPath(metadata.cwd, cwd);
      const ownedByParent =
        !ownedByWorkspace &&
        parentThreadId !== undefined &&
        (await parentThreadOwnedByWorkspace(
          rpc,
          getCachedThread(parentThreadId),
          cwd,
          parentThreadId,
        ));
      if (!ownedByWorkspace && !ownedByParent) return null;
      return { ...metadata, cwd, turns: [] };
    }),
  );
  return canonicalNativeThreads(resolved.filter((thread) => thread !== null));
}

/** 原生队列读取（写操作走命令层，这里只是投影数据源）。 */
export async function listNativeQueue(rpc: CodexRpcPort, id: string): Promise<unknown[]> {
  return paginateNativeRows(rpc, "thread/queue/list", { threadId: id }, "queue");
}

export async function queryBridgeRowsRange(
  params: unknown,
  loadSnapshot: (sessionId: string) => Promise<ConversationSnapshot>,
): Promise<V4ConversationRowsRangeResult> {
  const parsed = v4ConversationRowsRangeParamsSchema.parse(params);
  const snapshot = await loadSnapshot(parsed.sessionId);
  const all = snapshot.rows.window.filter(
    (row) => parsed.beforeRowId === undefined || row.rowId < parsed.beforeRowId,
  );
  return {
    rows: all.slice(-parsed.limit).map(compactConversationRowForWire),
    atSeq: snapshot.seq,
    atRevision: snapshot.revision,
    atLogEpoch: snapshot.logEpoch,
    hasMore: all.length > parsed.limit,
  };
}

export async function queryBridgeRowPayload(
  params: unknown,
  loadSnapshot: (sessionId: string) => Promise<ConversationSnapshot>,
): Promise<V4ConversationRowPayloadResult> {
  const parsed = v4ConversationRowPayloadParamsSchema.parse(params);
  const snapshot = await loadSnapshot(parsed.sessionId);
  const found = snapshot.rows.window.find(
    (candidate): candidate is Extract<typeof candidate, { kind: "toolCall" | "reasoning" }> =>
      candidate.rowId === parsed.rowId &&
      (candidate.kind === "toolCall" || candidate.kind === "reasoning"),
  );
  return v4ConversationRowPayloadResultSchema.parse({
    row: found ?? null,
    atSeq: snapshot.seq,
    atRevision: snapshot.revision,
    atLogEpoch: snapshot.logEpoch,
  });
}

export async function queryBridgePlans(
  params: unknown,
  loadSnapshot: (sessionId: string) => Promise<ConversationSnapshot>,
): Promise<V4ConversationPlansResult> {
  const parsed = v4ConversationPlansParamsSchema.parse(params);
  const snapshot = await loadSnapshot(parsed.sessionId);
  return {
    plans: snapshot.rows.window.filter(
      (row): row is Extract<typeof row, { kind: "toolCall" }> =>
        row.kind === "toolCall" && row.toolName === "ExitPlanMode",
    ),
    atSeq: snapshot.seq,
    atLogEpoch: snapshot.logEpoch,
  };
}
