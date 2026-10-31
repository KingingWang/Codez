import type { ConversationRowTarget } from "@codez/shared/codez-protocol-v4";

export type { CodezApiRetryStatus } from "@codez/shared";
export type {
  ApiRetryState,
  AttachmentRef,
  CommandAck,
  ConversationRowTarget,
  SessionUsageState,
  TurnHeaderRow,
} from "@codez/shared/codez-protocol-v4";

/** 原 pane 提供的 continuation 回调，目标校验和 admission 不属于展示层。 */
export type CodexConversationContinueAction = (target: ConversationRowTarget) => void;
