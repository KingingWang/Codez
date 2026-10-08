import type { InputRouting } from "@codez/shared/codez-protocol-v4";
import type { ConversationComposerSendOptions } from "@/v4/ConversationComposer.js";

interface PromptScrollFocusPolicyInput {
  draftMode: boolean;
  inputRoutingMode: InputRouting["mode"] | null;
  heldQueueDisposition?: ConversationComposerSendOptions["heldQueueDisposition"];
}

/**
 * Bug 原因：后续 prompt 即使立即发送也不代表用户结束阅读上文；
 * 旧策略在 ACK 后无条件调用“回到底部”，抢走了 pane 的滚动权。
 * 已在底部的 pane 自身会继续跟随，只有草稿首发需要主动定位新会话。
 */
export function shouldFocusTimelineAfterComposerSend(input: PromptScrollFocusPolicyInput): boolean {
  return input.draftMode;
}
