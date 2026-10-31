/**
 * conversation-share-attachment 模块清单；层：adapters。
 * 依赖与 architecture-policy.yaml 保持一致，业务 owner 仍为原 Share / attachment。
 */
export const conversationShareAttachmentModule = {
  id: "conversation-share-attachment",
  requires: ["services", "shared", "rpc"],
  provides: ["conversation-share-attachment"],
  publicEntrypoints: [
    "contract.ts",
    "../conversation-share/conversationShareConnectionScope.ts",
    "../conversation-share/codexSharedContextContentCopy.ts",
  ],
} as const;
