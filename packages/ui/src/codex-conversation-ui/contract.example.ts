import type { CodexConversationContinueAction, ConversationRowTarget } from "./contract.js";

/** 传递已由当前投影确定的稳定目标，不从显示文本生成 entityId。 */
export function conversationContinueExample(
  action: CodexConversationContinueAction,
  target: ConversationRowTarget,
) {
  action(target);
}
