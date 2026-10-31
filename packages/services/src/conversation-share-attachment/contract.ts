import type { scopeConversationShareServiceForAttachment } from "../conversation-share/conversationShareConnectionScope.js";

/** 复用当前 Share 端口的 attachment 隔离，不另建连接、订阅或会话。 */
export type ScopeConversationShareForAttachment = typeof scopeConversationShareServiceForAttachment;

export type ConversationShareAttachmentMode = Parameters<ScopeConversationShareForAttachment>[1];

export interface ConversationShareAttachmentContract {
  readonly scopeForAttachment: ScopeConversationShareForAttachment;
}
