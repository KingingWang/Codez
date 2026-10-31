import type {
  ConversationWorkspaceTargetParams,
  ResolveConversationWorkspaceTarget,
} from "@/conversation-workspace-target/contract.js";
import type { closeWorkspaceTabsBeforeRemoval } from "@/lib/workspaceRuntimeRelease.js";

/** Root 从当前窗口注入只读查询与既有打开操作，每次调用读取最新事实。 */
export function exampleConversationWorkspaceTarget(
  resolve: ResolveConversationWorkspaceTarget,
  ports: ConversationWorkspaceTargetParams,
) {
  return resolve(ports);
}

/** 使用关闭前的同一 tab / service 快照，全部释放成功才委托窗口 store 关闭。 */
export function exampleWorkspaceRemoval(
  closeTabs: typeof closeWorkspaceTabsBeforeRemoval,
  params: Parameters<typeof closeWorkspaceTabsBeforeRemoval>[0],
): Promise<void> {
  return closeTabs(params);
}
