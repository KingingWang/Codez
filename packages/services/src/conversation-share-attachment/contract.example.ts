import type { ScopeConversationShareForAttachment } from "./contract.js";

/** Desktop 传递既有受信 attachment；Share 的业务状态仍在原服务中。 */
export function exampleDesktopConversationShare(
  scope: ScopeConversationShareForAttachment,
  service: Parameters<ScopeConversationShareForAttachment>[0],
  agent: Parameters<ScopeConversationShareForAttachment>[2],
  connection: Parameters<ScopeConversationShareForAttachment>[3],
): ReturnType<ScopeConversationShareForAttachment> {
  return scope(service, "desktop-continuous", agent, connection);
}

/** 手机仅保留公开预览，不借此入口创建 Desktop 的分享或导入操作。 */
export function exampleMobileConversationShare(
  scope: ScopeConversationShareForAttachment,
  service: Parameters<ScopeConversationShareForAttachment>[0],
): ReturnType<ScopeConversationShareForAttachment> {
  return scope(service, "web-remote-replayable");
}
