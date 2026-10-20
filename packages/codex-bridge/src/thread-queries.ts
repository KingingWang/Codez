import {
  compactConversationRowForWire,
  v4ConversationPlansParamsSchema,
  v4ConversationRowPayloadParamsSchema,
  v4ConversationRowPayloadResultSchema,
  v4ConversationRowsRangeParamsSchema,
  type ConversationSnapshot,
  type V4ConversationPlansResult,
  type V4ConversationRowPayloadResult,
  type V4ConversationRowsRangeResult,
} from "@codez/shared/codez-protocol-v4";
import type { CodexRpcPort } from "./contract.js";
import { sameExecutionPath } from "./execution-path.js";
import { object } from "./json.js";
import { paginateNativeRows } from "./native-paging.js";
import { canonicalNativeThreads } from "./projection.js";

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
