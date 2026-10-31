import type { ICodezAgentService } from "@codez/services";

export type { ICodezAgentService, IServiceAccessor } from "@codez/services";
export type {
  CodexConversationHistoryRunsParams,
  CodexConversationHistoryRunsResult,
} from "@codez/shared/codez-protocol-v4";

/** 所属 Host 的只读能力事实；失败保持原 fail-closed 展示。 */
export type CodexHelloPort = Pick<ICodezAgentService, "helloConversationV4">;
export type CodexHistoryPort = Pick<ICodezAgentService, "codexHistoryRunsV4">;
