import type { scopeConversationShareServiceForAttachment } from "../conversation-share/conversationShareConnectionScope.js";
import type { expandSharedContextContentCopy } from "../conversation-share/codexSharedContextContentCopy.js";

export type {
  SharedContextContentCopyRecord,
  SharedContextContentCopyReader,
  SharedContextRefInput,
} from "../conversation-share/codexSharedContextContentCopy.js";

/** 原 Share owner 的只读内容端口，不增加发布、导入或连接状态。 */
export type ExpandCodexSharedContextContentCopy = typeof expandSharedContextContentCopy;

/** 复用当前 Share 端口的 attachment 隔离，不另建连接、订阅或会话。 */
export type ScopeConversationShareForAttachment = typeof scopeConversationShareServiceForAttachment;

export type ConversationShareAttachmentMode = Parameters<ScopeConversationShareForAttachment>[1];

export interface ConversationShareAttachmentContract {
  readonly scopeForAttachment: ScopeConversationShareForAttachment;
}
