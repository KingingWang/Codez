import { ServiceChannels } from "@codez/shared";
import type {
  TraceId,
  CodezAgentMcpServer,
  CodezDeliveryKind,
  CodezMessageWithParts,
  ModelSelection,
  CodezPermissionRequestParams,
  CodezUserInputRequestParams,
  CodezUserInputResponse,
  CodezSessionInfo,
  CodezSessionImportHistory,
  CodezSessionEvent,
  CodezSessionMode,
  CodezSessionPersistence,
  CodezSessionStateSnapshot,
  CodezStateUpdatedNotification,
  CodezWorkspacePresentation,
} from "@codez/shared";
import { createServiceDescriptor } from "#src/descriptors.js";

export interface CodezSessionWorkspaceTarget {
  workspacePath: string;
  workspaceIdentity?: string;
  remoteSessionId?: string;
}

export type CodezSessionReadWorkspacePresentationParams = CodezSessionWorkspaceTarget;

export interface CodezTaskTarget extends CodezSessionWorkspaceTarget {
  sessionId: string;
}

export interface CodezSessionCreateParams extends CodezSessionWorkspaceTarget {
  /** 仅导入事务使用的预分配 ID；普通新会话继续由 Agent 分配。 */
  sessionId?: string;
  sessionTraceId?: TraceId;
  parentSessionId?: string;
  mode?: CodezSessionMode;
  model?: ModelSelection;
  persistence?: CodezSessionPersistence;
  thoughtLevel?: string;
  mcpServers?: CodezAgentMcpServer[];
  importedHistory?: CodezSessionImportHistory;
}

export interface CodezSessionResumeParams extends CodezTaskTarget {
  model?: ModelSelection;
  thoughtLevel?: string;
  mcpServers?: CodezAgentMcpServer[];
  /**
   * 默认广播 resume 得到的历史快照，并让 shadow 订阅请求初始 snapshot。
   * 续聊发送前的 runtime 预恢复会关闭它，避免旧终态快照覆盖本地已开始的新输入运行态。
   */
  broadcastSnapshot?: boolean;
}

export interface CodezSessionListParams extends CodezSessionWorkspaceTarget {
  includeArchived?: boolean;
  limit?: number;
}

export interface CodezSessionReadParams extends CodezTaskTarget {
  deliveryKind?: CodezDeliveryKind;
  messageLimit?: number;
  afterSeq?: number;
}

export interface CodezSessionMessagesParams extends CodezTaskTarget {
  afterMessageId?: string;
  limit?: number;
}

export interface CodezSessionEventsParams extends CodezTaskTarget {
  afterSeq?: number;
  limit?: number;
}

export interface CodezSessionSetModelParams extends CodezTaskTarget {
  model: ModelSelection;
  expectedRevision?: number;
  persistAsWorkspaceLastUsed?: boolean;
}

export interface CodezSessionSetThoughtLevelParams extends CodezTaskTarget {
  thoughtLevel?: string;
  expectedRevision?: number;
  persistAsWorkspaceLastUsed?: boolean;
}

export interface CodezSessionSetModeParams extends CodezTaskTarget {
  mode: CodezSessionMode;
  expectedRevision?: number;
}

export interface CodezSessionSubscribeParams extends CodezTaskTarget {
  deliveryKind: CodezDeliveryKind;
  afterSeq?: number;
  includeSnapshot?: boolean;
  eventCoalescing?: {
    mode: "background-summary";
    intervalMs?: number;
  };
}

export type CodezSessionServiceEvent =
  | { type: "session.event"; event: CodezSessionEvent }
  | { type: "state.updated"; notification: CodezStateUpdatedNotification }
  | { type: "permission.request"; request: CodezPermissionRequestParams }
  | { type: "userInput.request"; request: CodezUserInputRequestParams }
  | {
      type: "userInput.response";
      requestId: string;
      response: CodezUserInputResponse;
    }
  | { type: "snapshot"; snapshot: CodezSessionStateSnapshot };

export interface CodezSessionInitializeResult {
  available: boolean;
  workspaceKey: string;
  protocolName?: string;
  protocolVersion?: number;
  transportKind?: "stdio" | "websocket";
  reason?: string;
  reasonCode?: "provider_not_ready";
}

export interface CodezSessionWorkspaceRuntimeIdentity {
  generation: number;
  identity: string;
  processId?: number;
  workspaceKey: string;
}

export interface ICodezSessionService {
  initializeWorkspace(params: CodezSessionWorkspaceTarget): Promise<CodezSessionInitializeResult>;
  getWorkspaceRuntimeIdentity(
    params: CodezSessionWorkspaceTarget,
  ): Promise<CodezSessionWorkspaceRuntimeIdentity>;
  readWorkspacePresentation(
    params: CodezSessionReadWorkspacePresentationParams,
  ): Promise<CodezWorkspacePresentation>;
  createSession(params: CodezSessionCreateParams): Promise<CodezSessionStateSnapshot>;
  resumeSession(params: CodezSessionResumeParams): Promise<CodezSessionStateSnapshot>;
  listSessions(params: CodezSessionListParams): Promise<CodezSessionInfo[]>;
  readSession(params: CodezSessionReadParams): Promise<CodezSessionStateSnapshot>;
  readSessionMessages(params: CodezSessionMessagesParams): Promise<CodezMessageWithParts[]>;
  readSessionEvents(params: CodezSessionEventsParams): Promise<CodezSessionEvent[]>;
  promoteDeferredDraftSession(params: CodezTaskTarget): Promise<void>;
  closeSession(params: CodezTaskTarget): Promise<void>;
  closeDeferredDraftSession(params: CodezTaskTarget): Promise<boolean>;
  setModel(params: CodezSessionSetModelParams): Promise<CodezSessionStateSnapshot>;
  setThoughtLevel(params: CodezSessionSetThoughtLevelParams): Promise<CodezSessionStateSnapshot>;
  setMode(params: CodezSessionSetModeParams): Promise<CodezSessionStateSnapshot>;
  // renderer 订阅面走 agentService 的 conversation/sessions-index 帧通道。
}

export const ICodezSessionService = createServiceDescriptor<ICodezSessionService>(
  ServiceChannels.CodezSession,
);
