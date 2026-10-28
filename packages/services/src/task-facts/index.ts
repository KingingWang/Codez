import {
  generateTraceId,
  resolveWorkspaceKey,
  CODEZ_AGENT_PROVIDER,
  type CodezTaskMeta,
} from "@codez/shared";
import type { SessionsIndexReconcileResult } from "@codez/shared/codez-protocol-v4";
import type {
  TaskFactChange,
  TaskFactSource,
  TaskFactStore,
  TaskFactsContract,
  TaskWorkspace,
  TaskFactTarget,
} from "#src/task-facts/contract.js";
export type {
  TaskFactsContract,
  TaskFactStore,
  TaskFactSource,
  TaskFactTarget,
  TaskFactMutation,
} from "#src/task-facts/contract.js";

export function createTaskFacts(options: {
  store: TaskFactStore;
  source: TaskFactSource;
  changed(change: TaskFactChange): void;
}): TaskFactsContract {
  const { store, source, changed } = options;
  // 仅保留在途请求的代际，不缓存会话状态。新帧到达即撤销旧请求的落库资格。
  const refreshes = new Map<string, symbol>();
  const key = (target: TaskFactTarget) =>
    JSON.stringify([resolveWorkspaceKey(target), target.taskId]);
  const mirror = async (
    target: TaskWorkspace,
    result: SessionsIndexReconcileResult,
    current: () => boolean,
    publish = true,
    pendingDeleteIds?: ReadonlySet<string>,
  ) => {
    for (const fact of result.sessions) {
      if (!current()) return;
      const task = {
        workspacePath: target.workspacePath,
        workspaceIdentity: target.workspaceIdentity,
        taskId: fact.sessionId,
      };
      if (!fact.exists) {
        // 修复原因：已携带删除交接意图（bit 1）或刚完成物理删除的会话在 CLI 中已不存在（not found），
        // 按 spec 7.4 应视为已删并清位；若仅标 orphan 而不写 cli_deleted=1，行会在 readTree 中持续复活。
        if (pendingDeleteIds?.has(fact.sessionId)) {
          await store.applyCliDeletion(task);
          if (publish && current()) changed({ target: task, reason: "task_deleted" });
        } else {
          await store.markCliOrphan(task);
        }
        continue;
      }
      if (fact.deleted && fact.createdAt === 0 && fact.updatedAt === 0 && fact.title === "") {
        // Codex 原生删除是物理移除 rollout，bridge 仅保有会话 ID tombstone（无历史时间/标题）；
        // 直接提交删除事实，避免空占位覆盖 SQLite 已有的归档展示时间与标题。
        await store.applyCliDeletion(task);
        if (publish && current()) changed({ target: task, reason: "task_deleted" });
        continue;
      }
      const before = publish ? await store.getTaskMeta(task) : null;
      if (!current()) return;
      const meta = await store.applyCliFacts({
        meta: {
          ...task,
          traceId: generateTraceId(fact.sessionId),
          title: fact.title,
          createdAt: fact.createdAt,
          updatedAt: fact.updatedAt,
          mode: "default",
          provider: CODEZ_AGENT_PROVIDER,
        },
        titleSource: fact.titleSource,
        lastOutcome: fact.lastOutcome,
        deleted: fact.deleted,
      });
      if (
        publish &&
        current() &&
        (fact.deleted ||
          !before ||
          before.title !== meta.title ||
          before.updatedAt !== meta.updatedAt ||
          before.status !== meta.status)
      )
        changed({
          target: task,
          meta,
          reason: fact.deleted ? "task_deleted" : "task_title_changed",
        });
    }
  };
  const port: TaskFactsContract = {
    async ingest(target, summary) {
      refreshes.delete(key({ ...target, taskId: summary.sessionId }));
      const lastOutcome = summary.lastOutcome;
      const meta: CodezTaskMeta = {
        taskId: summary.sessionId,
        traceId: generateTraceId(summary.sessionId),
        title: summary.title,
        workspacePath: target.workspacePath,
        workspaceIdentity: target.workspaceIdentity,
        createdAt: summary.createdAt,
        updatedAt: summary.lastActivityAt,
        mode: "default",
        provider: CODEZ_AGENT_PROVIDER,
        ...(summary.parentSessionId ? { forkedFromTaskId: summary.parentSessionId } : {}),
        ...(lastOutcome ? { status: lastOutcome === "error" ? "error" : "completed" } : {}),
      };
      return store.applyCliFacts({
        meta,
        ...(summary.originProjectId !== undefined
          ? { originProjectId: summary.originProjectId }
          : {}),
        titleSource: summary.titleSource,
        lastOutcome,
      });
    },
    async removed(target) {
      refreshes.delete(key(target));
      await store.applyCliDeletion(target);
      changed({ target, reason: "task_deleted" });
    },
    async refresh(target) {
      const id = key(target);
      const generation = Symbol();
      refreshes.set(id, generation);
      try {
        const result = await source.reconcile(target, [target.taskId]);
        await mirror(target, result, () => refreshes.get(id) === generation, false);
        return await store.getTaskMeta(target);
      } finally {
        if (refreshes.get(id) === generation) refreshes.delete(id);
      }
    },
    async mutate(target, intent) {
      await source.execute(target, intent);
      const meta =
        intent.type === "delete"
          ? await (async () => {
              const id = key(target);
              const generation = Symbol();
              refreshes.set(id, generation);
              try {
                const result = await source.reconcile(target, [target.taskId]);
                await mirror(
                  target,
                  result,
                  () => refreshes.get(id) === generation,
                  false,
                  new Set([target.taskId]),
                );
                return await store.getTaskMeta(target);
              } finally {
                if (refreshes.get(id) === generation) refreshes.delete(id);
              }
            })()
          : await port.refresh(target);
      changed({
        target,
        ...(meta ? { meta } : {}),
        reason: intent.type === "delete" ? "task_deleted" : "task_title_changed",
      });
      return meta;
    },
    async reconcile(target, presentSessionIds, stillCurrent) {
      const rows = (await store.listReconciliationRows(target)).filter(
        (row) => !presentSessionIds.has(row.meta.taskId) || (row.handoffPending & 3) !== 0,
      );
      // 修复原因：256 个缺席行一批会在快照换代前产生无法撤销的原生请求；缩小
      // 已授权的只读批次，在每批间核对代际，避免过期快照继续压满出站队列。
      for (let offset = 0; offset < rows.length && stillCurrent(); offset += 32) {
        const batch = rows.slice(offset, offset + 32);
        const pendingDeleteIds = new Set(
          batch.filter((row) => (row.handoffPending & 1) !== 0).map((row) => row.meta.taskId),
        );
        let result = await source.reconcile(
          target,
          batch.map((row) => row.meta.taskId),
        );
        if (!stillCurrent()) return;
        const changedIds: string[] = [];
        for (const fact of result.sessions) {
          if (!stillCurrent()) return;
          if (!fact.exists || fact.deleted) continue;
          const pending = batch.find((row) => row.meta.taskId === fact.sessionId)!;
          if ((pending.handoffPending & 3) === 0) continue;
          await source.execute(
            { ...target, taskId: fact.sessionId },
            (pending.handoffPending & 1) !== 0
              ? { type: "delete" }
              : { type: "rename", title: pending.meta.title },
          );
          changedIds.push(fact.sessionId);
        }
        if (changedIds.length && stillCurrent()) {
          const confirmed = await source.reconcile(target, changedIds);
          result = {
            sessions: [
              ...result.sessions.filter((fact) => !changedIds.includes(fact.sessionId)),
              ...confirmed.sessions,
            ],
          };
        }
        await mirror(target, result, stillCurrent, true, pendingDeleteIds);
      }
    },
  };
  return port;
}
