import type { CodexRpcPort } from "./contract.js";
import { codexTurnSchema } from "./codex-types.js";
import { emitBridgeStateDiagnostic, type BridgeStateDiagnostic } from "./diagnostics.js";
import { object } from "./json.js";
import { paginateNativeRows } from "./native-paging.js";
import type { ThreadStateStore } from "./thread-state.js";

interface SubagentStopContext {
  rpc: CodexRpcPort;
  store: ThreadStateStore;
}

/** 父 envelope 是唯一停止入口；child 的只读视图不取得写权限或第二份执行状态。 */
export async function cancelSubagentWork(
  context: SubagentStopContext,
  parentId: string,
  childId: string,
): Promise<void> {
  const registered = () =>
    context.store.subagentActivityTracker().childrenOf(parentId).includes(childId);
  if (!registered()) throw new Error("Subagent work is not registered to this parent");
  // 修复依据：父侧登记只授权目标，执行 turn 必须免锁读原生当前事实。ensure/resume 会
  // 改写未加载 child 的 rollout，且缓存 turn 可能已结束；不能用它们决定 interrupt。
  const child = object(
    object(await context.rpc.request("thread/read", { threadId: childId })).thread,
  );
  if (child.id !== childId || child.parentThreadId !== parentId)
    throw new Error("Native subagent identity does not match the registered parent");
  const turns = (
    await paginateNativeRows(
      context.rpc,
      "thread/turns/list",
      { threadId: childId, itemsView: "notLoaded", sortDirection: "desc" },
      "history",
    )
  ).map((value) => codexTurnSchema.parse(value));
  const running = turns.filter((turn) => turn.status === "inProgress");
  if (running.length > 1) throw new Error("Native subagent has ambiguous active turns");
  // 读取期间关系可能被重投影/删除事件撤销；再次核验，不把过期登记变成写权限。
  if (!registered()) throw new Error("Subagent registration changed before interrupt");
  if (running.length === 0) return;
  await context.rpc.request("turn/interrupt", { threadId: childId, turnId: running[0]!.id });
}

/** root Stop 的 ACK 只由 root interrupt 决定；单 child 失败不能阻断后续 child。 */
export async function cascadeSubagentStop(
  context: SubagentStopContext,
  parentId: string,
  onFallback?: (diagnostic: BridgeStateDiagnostic) => void,
): Promise<void> {
  for (const childId of context.store.subagentActivityTracker().childrenOf(parentId)) {
    try {
      await cancelSubagentWork(context, parentId, childId);
    } catch {
      // Bug #32：原先 root stop 没有子线程清理，留下孤儿任务。尽力级联失败只记闭合
      // 诊断，不翻转已成功的 root ACK，也不自动重试可能已执行的 interrupt。
      emitBridgeStateDiagnostic(onFallback, {
        kind: "subagentStopFallback",
        sessionId: parentId,
        childSessionId: childId,
      });
    }
  }
}
