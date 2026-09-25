import type { BackgroundBashOutputResult, SessionDebugSnapshot } from "@codez/shared";
/* eslint-disable max-lines -- Codez agent service 接口集中声明 protocol/session/workspace 方法，拆分会增加 service descriptor 迁移成本。 */
import type { Event, IDisposable } from "@codez/rpc";
import { ServiceChannels } from "@codez/shared";
import type { AppUsageRange, AppUsageSnapshot, CodezTaskTokenUsageResult } from "@codez/shared";
import type { CodezAutomation, CodezAutomationRun } from "@codez/shared";
import type {
  CodexRequest,
  CodezStorageStartupState,
  CodezDeliveryKind,
  CodezAgentMcpServer,
  CodezBackgroundTurnAttribution,
  TraceId,
  CodezSessionCompactResult,
  CodezSessionGoalAction,
  CodezSessionGoalResult,
  CodezMessageWithParts,
  ModelSelection,
  CodezSessionImportHistory,
  CodezPermissionRequestParams,
  AgentLaneResourceSample,
  CodezMcpTelemetryEvent,
  CodezMcpResourceSample,
  CodezToolExecResource,
  CodezProcessChildProcess,
  CodezMcpListResult,
  CodezPluginsListResult,
  CodezAgentRoleScope,
  CodezAgentRoleWriteInput,
  CodezAgentsListResult,
  CodezAgentsWriteResult,
  CodezPluginsOverviewResult,
  CodezPluginsMarketplaceMutationResult,
  CodezPluginsInstallResult,
  CodezPluginsReferenceCatalogResult,
  CodezSkillsReferenceCatalogResult,
  CodezWorkflowsDeleteResult,
  CodezWorkflowsGetResult,
  CodezWorkflowsListResult,
  CodezWorkflowsMoveResult,
  CodezWorkflowsRunsResult,
  CodezWorkflowsUpdateMetaResult,
  CodezPluginsUninstallResult,
  CodezPluginsRestoreBuiltinResult,
  CodezPluginsConfigureResult,
  CodezPluginsDescribeResult,
  CodezPluginsValidateResult,
  CodezPluginsSetEnabledResult,
  CodezPluginsCancelOperationResult,
  CodezPluginOperationProgressNotification,
  CodezProviderTestModelConnectivityParams,
  CodezProviderTestModelConnectivityResult,
  CodezUserInputRequestParams,
  CodezUserInputResponse,
  CodezSessionEvent,
  CodezSessionInfo,
  CodezSessionMode,
  CodezSessionPersistence,
  CodezSessionSendResult,
  CodezSessionRequestRuntimePreferencesParams,
  CodezSessionRuntimePreferencesResult,
  CodezSessionStateSnapshot,
  CodezSessionSubagentsResult,
  CodezStateUpdatedNotification,
  CodezTaskClientMode,
  CodezBrowserAmbientContext,
  CodezWorkspacePresentation,
  CodezWorkspaceGenerateTextResult,
  CodezWorkspaceGenerateTextParams,
  CodezWorkspaceHookTrustGrantResult,
  CodezAutomationBotDeliveryTarget,
} from "@codez/shared";
import type {
  ClientHello,
  CommandAck,
  CommandEnvelope,
  CommandKey,
  CommandsQueryResult,
  ConversationTopicWireCandidate,
  ConversationTelemetryFact,
  CuaPermissionObservation,
  ConversationRowTarget,
  HelloMessage,
  SessionsIndexTopicWireCandidate,
  V4AttachmentBeginResult,
  V4AttachmentChunkResult,
  V4AttachmentCommitResult,
  V4AttachmentPreviewSourceResult,
  V4AttachmentReadResult,
  V4ConversationAttachmentReadResult,
  V4ConversationAttachmentStatResult,
  V4ConnectionFlowState,
  V4ConversationFileChangesResult,
  V4ConversationFileRewindPreviewResult,
  V4ConversationPlansResult,
  V4ConversationWorkflowRunEventsResult,
  V4ConversationWorkflowRunArtifactDataResult,
  V4ConversationWorkflowRunArtifactReadResult,
  V4ConversationWorkflowRunArtifactsResult,
  V4ConversationWorkflowRunNodeResultResult,
  V4ConversationWorkflowRunWorkspaceResult,
  V4ConversationWorkflowRunsResult,
  CodexConversationHistoryRunsParams,
  CodexConversationHistoryRunsResult,
  V4ConversationRowsRangeResult,
  V4ConversationResyncResult,
  V4ConversationSubscribeResult,
  V4SessionsIndexSubscribeResult,
  V4WorkspaceConfigSubscribeResult,
  WorkspaceConfigTopicWireCandidate,
} from "@codez/shared/codez-protocol-v4";
import { createServiceDescriptor } from "../descriptors.js";
import type { CodexUsageCacheSnapshot } from "../usage-stats/codexUsageObservationCache.js";

export * from "./codezAgentPluginParams.js";
export * from "./codezAgentWorkflowParams.js";
import type {
  CodezAgentAddPluginMarketplaceParams,
  CodezAgentAutomationIdParams,
  CodezAgentCancelPluginOperationParams,
  CodezAgentConfigurePluginParams,
  CodezAgentResetPluginConfigParams,
  CodezAgentCreateAutomationParams,
  CodezAgentDeleteAutomationRunParams,
  CodezAgentDescribePluginParams,
  CodezAgentInstallPluginParams,
  CodezAgentListMcpServerStatusesParams,
  CodezAgentPluginViewParams,
  CodezAgentPluginReferenceCatalogParams,
  CodezAgentSkillReferenceCatalogParams,
  CodezAgentResolveSuggestedPluginReferenceParams,
  CodezAgentRemovePluginMarketplaceParams,
  CodezAgentRestoreBuiltinPluginParams,
  CodezAgentSetPluginEnabledParams,
  CodezAgentSetAutomationEnabledParams,
  CodezAgentUninstallPluginParams,
  CodezAgentUpdatePluginMarketplaceParams,
  CodezAgentUpdatePluginParams,
  CodezAgentUpdateAutomationParams,
  CodezAgentValidatePluginParams,
  CodezAgentWorkspaceTarget,
} from "./codezAgentPluginParams.js";
import type {
  CodezAgentDeleteSavedWorkflowParams,
  CodezAgentGetSavedWorkflowParams,
  CodezAgentListSavedWorkflowRunsParams,
  CodezAgentListSavedWorkflowsParams,
  CodezAgentMoveSavedWorkflowParams,
  CodezAgentUpdateSavedWorkflowMetaParams,
} from "./codezAgentWorkflowParams.js";

export interface CodezAgentSessionTarget extends CodezAgentWorkspaceTarget {
  sessionId: string;
}

export interface CodezAgentResumeSessionParams extends CodezAgentSessionTarget {
  model?: ModelSelection;
  thoughtLevel?: string;
  mcpServers?: CodezAgentMcpServer[];
  // 冷恢复会重建 runtime，工具面隔离必须和 create 保持同一安全边界（CUA 只放行 codez-cua 工具、
  // 禁 Bash 等）。否则 resume 后模型可见工具面/执行权限会比创建时更宽。
  toolAllowlist?: string[];
  toolDenylist?: string[];
}

export interface CodezAgentInitializeResult {
  available: boolean;
  workspaceKey: string;
  protocolName?: string;
  protocolVersion?: number;
  transportKind?: "stdio" | "websocket";
  reason?: string;
  reasonCode?: "provider_not_ready";
}

export interface CodezAgentRunAutomationNowResult {
  status: "queued" | "duplicate";
}

export interface CodezAgentWorkspaceRuntimeIdentity {
  generation: number;
  identity: string;
  processId?: number;
  workspaceKey: string;
}

export const CODEZ_AGENT_RUNTIME_UNAVAILABLE_CODE = "CODEZ_AGENT_RUNTIME_UNAVAILABLE";

export type CodezAgentRuntimePolicy = "start-if-needed" | "existing-only";

export interface CodezAgentRuntimeLifecycleEvent extends CodezAgentWorkspaceTarget {
  workspaceKey: string;
  runtimeIdentity: CodezAgentWorkspaceRuntimeIdentity;
  state: "available" | "unavailable";
}

export type CodezAgentCuaPermissionObservation = CuaPermissionObservation &
  CodezAgentWorkspaceTarget;

export interface CodezAgentCreateSessionParams extends CodezAgentWorkspaceTarget {
  sessionId?: string;
  sessionTraceId?: TraceId;
  parentSessionId?: string;
  mode?: CodezSessionMode;
  model?: ModelSelection;
  persistence?: CodezSessionPersistence;
  thoughtLevel?: string;
  /** automation 执行会话关闭模型二次命名，保持首条用户 query 作为稳定标题。 */
  titleGenerationEnabled?: boolean;
  mcpServers?: CodezAgentMcpServer[];
  toolAllowlist?: string[];
  toolDenylist?: string[];
  importedHistory?: CodezSessionImportHistory;
}

export interface CodezAgentListSessionsParams extends CodezAgentWorkspaceTarget {
  sessionIds?: string[];
  runtimePolicy?: CodezAgentRuntimePolicy;
  includeArchived?: boolean;
  limit?: number;
}

export interface CodezAgentListSessionSubagentsParams extends CodezAgentSessionTarget {
  endedCursor?: string;
  endedLimit?: number;
  /** 远程 workspace 的宿主连接身份；只用于选择现有 Host，不进入 CLI wire query。 */
  remoteSessionId?: string;
}

export interface CodezAgentAppUsageParams {
  range: AppUsageRange;
  timeZone?: string;
}

export interface CodezAgentTaskTokenUsageParams extends CodezAgentSessionTarget {}

export interface CodezAgentReadSessionParams extends CodezAgentSessionTarget {
  deliveryKind?: CodezDeliveryKind;
  messageLimit?: number;
  afterSeq?: number;
  /** 被动索引/观察者只能读取现有 runtime，禁止为了读快照拉起 session。 */
  runtimePolicy?: CodezAgentRuntimePolicy;
}

export interface CodezAgentReadSessionMessagesParams extends CodezAgentSessionTarget {
  afterMessageId?: string;
  limit?: number;
}

export interface CodezAgentReadSessionEventsParams extends CodezAgentSessionTarget {
  afterSeq?: number;
  limit?: number;
}

export type CodezAgentReadWorkspacePresentationParams = CodezAgentWorkspaceTarget;

export interface CodezAgentGrantWorkspaceHookTrustParams extends CodezAgentWorkspaceTarget {
  bundleDigest: string;
  hookDeclarationDigest: string;
}

export interface CodezAgentSendPromptParamsBase extends CodezAgentSessionTarget {
  modelSelection?: ModelSelection;
  modelExecution?: import("@codez/shared/codez-protocol-v4").CommandPayloadMap["sendText"]["modelExecution"];
  inputId?: string;
  queryId?: string;
  messageId?: string;
  sessionTraceId?: TraceId;
  content: string;
  attachments?: Record<string, unknown>[];
  /** provider-only 的当前 IAB 状态；UI/session persistence 仍使用 content 原文。 */
  browserAmbientContext?: CodezBrowserAmbientContext;
  clientMode?: CodezTaskClientMode;
  expectedRevision?: number;
  expectedProviderRevision?: string;
  runtimeProviderHeaders?: Record<string, string>;
  toolDenylist?: string[];
  /** Bot 来源 turn 的稳定回推地址；只在当前 turn 内供 CronCreate 读取。 */
  botDeliveryTarget?: CodezAutomationBotDeliveryTarget;
}

export type CodezAgentSendPromptParams = CodezAgentSendPromptParamsBase &
  CodezBackgroundTurnAttribution;

export interface CodezAgentCompactParams extends CodezAgentSessionTarget {
  inputId?: string;
  instructions?: string;
  expectedRevision?: number;
}

export interface CodezAgentGoalParams extends CodezAgentSessionTarget {
  inputId?: string;
  action: CodezSessionGoalAction;
  objective?: string;
  expectedRevision?: number;
}

export interface CodezAgentSetModelParams extends CodezAgentSessionTarget {
  model: ModelSelection;
  expectedRevision?: number;
  persistAsWorkspaceLastUsed?: boolean;
}

export interface CodezAgentSetThoughtLevelParams extends CodezAgentSessionTarget {
  thoughtLevel?: string;
  expectedRevision?: number;
  persistAsWorkspaceLastUsed?: boolean;
}

export interface CodezAgentSetModeParams extends CodezAgentSessionTarget {
  mode: CodezSessionMode;
  expectedRevision?: number;
}

export interface CodezAgentGenerateWorkspaceTextParams extends CodezAgentWorkspaceTarget {
  selection: CodezWorkspaceGenerateTextParams["selection"];
  prompt?: string;
  messages?: CodezWorkspaceGenerateTextParams["messages"];
  tools?: CodezWorkspaceGenerateTextParams["tools"];
  querySource: string;
  maxOutputTokens?: number;
  signal?: AbortSignal;
  /**
   * 协议层 RPC 超时。thinking 模型的长请求会超过协议 client 默认的
   * 3 分钟；调用方必须把自身 deadline 透传到这里，否则默认超时先触发、
   * 还会被 onRequestTimeout 误判 stale 杀进程。
   */
  requestTimeoutMs?: number;
}

export interface CodezAgentTestModelConnectivityParams extends CodezAgentWorkspaceTarget {
  selection: CodezProviderTestModelConnectivityParams["selection"];
  signal?: AbortSignal;
}

export interface CodezAgentSessionRuntimePreferencesRequest extends CodezSessionRequestRuntimePreferencesParams {
  requestId: string;
}

export interface CodezAgentRespondSessionRuntimePreferencesParams {
  requestId: string;
  resolution:
    | { status: "resolved"; preferences: CodezSessionRuntimePreferencesResult }
    | { status: "failed"; message: string };
}

export interface CodezAgentSessionSubscribeParams extends CodezAgentSessionTarget {
  deliveryKind: CodezDeliveryKind;
  afterSeq?: number;
  includeSnapshot?: boolean;
  eventCoalescing?: {
    mode: "background-summary";
    intervalMs?: number;
  };
}

// ── v4 conversation 通道（竖切）──
// host 只做转发：subscribe/unsubscribe/command 透传给 CLI v4 gateway，
// v4/conversation/frame 通知按 workspace fan-out 给 renderer。

export interface CodezAgentConversationSubscribeParams extends CodezAgentSessionTarget {
  /** 水位不变量：仅当客户端真持有该时刻一致状态才允许带。 */
  base?: { logEpoch: string; seq: number };
  visibility?: "foreground" | "background";
}

export interface CodezAgentConversationUnsubscribeParams extends CodezAgentWorkspaceTarget {
  subscriptionId: string;
  runtimePolicy?: CodezAgentRuntimePolicy;
}

export interface CodezAgentConversationResyncParams extends CodezAgentWorkspaceTarget {
  subscriptionId: string;
  base: { logEpoch: string; seq: number } | null;
  forceSnapshot?: boolean;
  runtimePolicy?: CodezAgentRuntimePolicy;
}

/** 行分页 query（rows/range）：按游标向上取一窗历史行。 */
export interface CodezAgentConversationRowsRangeParams extends CodezAgentSessionTarget {
  /** 取 rowId < beforeRowId 的行；缺省 = 从当前尾部向前。 */
  beforeRowId?: number;
  /** 1..rowsRangeMaxLimit（200）。 */
  limit: number;
}

/** 当前有效分支里的终态 ExitPlanMode 目录。 */
export type CodezAgentConversationPlansParams = CodezAgentSessionTarget;

/** workflow run 的事件日志分页（详情页审计面）；cursor = journal sequence。 */
export interface CodezAgentConversationWorkflowRunEventsParams extends CodezAgentSessionTarget {
  runId: string;
  afterSequence?: number;
  limit?: number;
}

/** dwf run 的枚举（重启后的发现查询）。 */
export interface CodezAgentConversationWorkflowRunsParams extends CodezAgentSessionTarget {
  limit?: number;
}

/** Codex 原生 turn 的独立只读历史投影查询。 */
export interface CodezAgentCodexHistoryRunsParams extends CodezAgentSessionTarget {
  limit?: number;
  status?: CodexConversationHistoryRunsParams["status"];
  beforeTurnId?: string;
}

// ── dwf 用户面产物──
// ⚠ 术语：artifact = 脚本经 `artifact.*` 发布给**用户**看的产出（文件 / markdown / 预置看板），
// 不是 run 的顶层返回值（引擎内部对后者的同名叫法）。

/** 产物清单；UI 冷恢复与中枢详情的 durable 读法。 */
export interface CodezAgentConversationWorkflowRunArtifactsParams extends CodezAgentSessionTarget {
  runId: string;
}

/** 预置看板的取数面；cursor = journal sequence（严格大于）。 */
export interface CodezAgentConversationWorkflowRunArtifactDataParams extends CodezAgentSessionTarget {
  runId: string;
  artifactId: string;
  afterSequence?: number;
  limit?: number;
}

/** 内容产物的字节，一次一块（≤ 512 KiB，形状逐字照 attachmentRead）。 */
export interface CodezAgentConversationWorkflowRunArtifactReadParams extends CodezAgentSessionTarget {
  runId: string;
  artifactId: string;
  version: number;
  offset: number;
  limit: number;
}

// ── dwf 工作区 transcript──
/** 轻行清单：一个 run 的 files.* / git.* / world.run 行，不带正文。 */
export interface CodezAgentConversationWorkflowRunWorkspaceParams extends CodezAgentSessionTarget {
  runId: string;
}

/** 一个工作区节点的正文，按 maxBytes 保形有界化（缺省与上限在 CLI 网关侧）。 */
export interface CodezAgentConversationWorkflowRunNodeResultParams extends CodezAgentSessionTarget {
  runId: string;
  siteId: string;
  ordinal: number;
  maxBytes?: number;
}

export interface CodezAgentBackgroundBashOutputParams extends CodezAgentSessionTarget {
  workId: string;
}

export interface CodezAgentConversationFileChangesParams extends CodezAgentSessionTarget {
  target: ConversationRowTarget;
  baseRevision: number;
  baseLogEpoch: string;
}

export interface CodezAgentConversationFileRewindPreviewParams extends CodezAgentSessionTarget {
  target: ConversationRowTarget;
  baseRevision: number;
  baseLogEpoch: string;
}

export interface CodezAgentConversationFileRewindProjectionOverlayParams extends CodezAgentSessionTarget {
  target: ConversationRowTarget;
  turnId: string;
}

export interface CodezAgentConversationCommandParams extends CodezAgentWorkspaceTarget {
  envelope: CommandEnvelope;
  /** 仅 host 内部用于 Browser Use runtime 边界，不进入 v4 wire envelope。 */
  clientMode?: CodezTaskClientMode;
}

export interface CodezAgentCommandsQueryParams extends CodezAgentWorkspaceTarget {
  clock?: true;
  commands: CommandKey[];
}

/** UI 不携带 connectionId；connection scope 以 trusted carrier 注入 wire identity。 */
export interface CodezAgentAttachmentBeginParams extends CodezAgentSessionTarget {
  uploadId: string;
  fileName: string;
  mime: string;
  totalBytes: number;
  totalChunks: number;
  checksum: string;
}

export interface CodezAgentAttachmentChunkParams extends CodezAgentSessionTarget {
  uploadId: string;
  chunkIndex: number;
  dataBase64: string;
}

export interface CodezAgentAttachmentTerminalParams extends CodezAgentSessionTarget {
  uploadId: string;
}

export interface CodezAgentAttachmentReadParams extends CodezAgentSessionTarget {
  ref: string;
  target?: ConversationRowTarget;
  attachmentIndex?: number;
  offset: number;
  limit: number;
}

export interface CodezAgentConversationAttachmentReadParams extends CodezAgentSessionTarget {
  ref: string;
  target: ConversationRowTarget;
  attachmentIndex: number;
  offset: number;
  limit: number;
}

export interface CodezAgentConversationAttachmentStatParams extends CodezAgentSessionTarget {
  ref: string;
  target: ConversationRowTarget;
  attachmentIndex: number;
}

export interface CodezAgentAttachmentPreviewSourceParams extends CodezAgentSessionTarget {
  ref: string;
  target?: ConversationRowTarget;
  attachmentIndex?: number;
}

/** host scope 内部 transport 控制面；connectionId 只能经 trusted carrier 注入。 */
export interface CodezAgentConnectionFlowParams extends CodezAgentWorkspaceTarget {
  state: V4ConnectionFlowState;
}

/** sessions-index：workspace 级列表订阅（无 sessionId 维度）。 */
export interface CodezAgentSessionsIndexSubscribeParams extends CodezAgentWorkspaceTarget {
  base?: { logEpoch: string; seq: number };
  visibility?: "foreground" | "background";
  /**
   * 订阅者作用域后缀：CLI 侧重订阅替换按 (connectionId, topic) 判定，
   * host 进程内多个独立消费者（renderer 侧栏 / task-index syncer）订阅同一 topic 时
   * 必须用不同 connectionId，否则互相替换对方的订阅代际。缺省共享 host 连接 id。
   */
  subscriberScope?: string;
  /**
   * task-list 等被动观察者必须使用 existing-only；runtime 不存在时返回稳定 unavailable，
   * 禁止为了建立列表订阅而启动 Agent。缺省保持显式会话入口的旧行为。
   */
  runtimePolicy?: CodezAgentRuntimePolicy;
}

/** workspace-config：workspace 级配置目录订阅（config options + slash 目录）。 */
export interface CodezAgentWorkspaceConfigSubscribeParams extends CodezAgentWorkspaceTarget {
  base?: { logEpoch: string; seq: number };
  visibility?: "foreground" | "background";
  subscriberScope?: string;
  runtimePolicy?: CodezAgentRuntimePolicy;
}

export type CodezAgentServiceEvent =
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

export interface CodezAgentAppRuntimePreferences {
  askUserQuestionAutoResolutionEnabled: boolean;
  modelIoFullRetentionEnabled?: boolean;
}

export interface CodezAgentLocalRuntimeChildProcesses {
  pid: number;
  provider: string;
  workspacePath: string;
  lane?: string;
  children: CodezProcessChildProcess[];
}

export interface CodezAgentStorageStartupSnapshot {
  generation: number;
  state: CodezStorageStartupState | null;
}

// Codex 子智能体（agent roles）文件管理参数。agents/* 是 bridge 控制面方法族，
// 载体必须是真实 workspace client——project scope 解析 `<cwd>/.codex/agents`，
// 远程 workspace 由远端 bridge 进程解析其 CODEX_HOME（spec：specs/codex-desktop-subagents.md）。
export interface CodezAgentWriteAgentRoleParams extends CodezAgentWorkspaceTarget {
  scope: CodezAgentRoleScope;
  /** 提供 = 更新既有角色（不支持改名）；缺省 = 新建。 */
  originalName?: string;
  role: CodezAgentRoleWriteInput;
}

export interface CodezAgentDeleteAgentRoleParams extends CodezAgentWorkspaceTarget {
  scope: CodezAgentRoleScope;
  name: string;
}

export interface ICodezAgentService {
  /** Native settings RPC; startup does not require legacy provider/model readiness. */
  codexRequest(params: CodezAgentWorkspaceTarget & { request: CodexRequest }): Promise<unknown>;
  /** 控制面不需要账号或模型，且不发送普通协议请求。 */
  prepareStorage(params: CodezAgentWorkspaceTarget): Promise<void>;
  getStorageStartupState(
    params: CodezAgentWorkspaceTarget,
  ): Promise<CodezAgentStorageStartupSnapshot | null>;
  onDynamicStorageStartupState(
    params: CodezAgentWorkspaceTarget,
  ): Event<CodezAgentStorageStartupSnapshot>;
  initialize(params: CodezAgentWorkspaceTarget): Promise<CodezAgentInitializeResult>;
  /**
   * 同步 App 全局运行时偏好到所有已活动 workspace；不得为此启动空闲 Agent。
   */
  syncAppRuntimePreferences(preferences: CodezAgentAppRuntimePreferences): Promise<void>;
  getWorkspaceRuntimeIdentity(
    params: CodezAgentWorkspaceTarget,
  ): Promise<CodezAgentWorkspaceRuntimeIdentity>;
  createSession(params: CodezAgentCreateSessionParams): Promise<CodezSessionStateSnapshot>;
  resumeSession(params: CodezAgentResumeSessionParams): Promise<CodezSessionStateSnapshot>;
  listSessions(params: CodezAgentListSessionsParams): Promise<CodezSessionInfo[]>;
  listSessionSubagents(
    params: CodezAgentListSessionSubagentsParams,
  ): Promise<CodezSessionSubagentsResult>;
  getAppUsageStats(params: CodezAgentAppUsageParams): Promise<AppUsageSnapshot>;
  getCodexUsageObservations(params: CodezAgentWorkspaceTarget): Promise<CodexUsageCacheSnapshot>;
  getTaskTokenUsage(params: CodezAgentTaskTokenUsageParams): Promise<CodezTaskTokenUsageResult>;
  readSession(params: CodezAgentReadSessionParams): Promise<CodezSessionStateSnapshot>;
  readSessionMessages(
    params: CodezAgentReadSessionMessagesParams,
  ): Promise<CodezMessageWithParts[]>;
  readSessionDebug(params: CodezAgentSessionTarget): Promise<SessionDebugSnapshot>;
  readSessionEvents(params: CodezAgentReadSessionEventsParams): Promise<CodezSessionEvent[]>;
  readWorkspacePresentation(
    params: CodezAgentReadWorkspacePresentationParams,
  ): Promise<CodezWorkspacePresentation>;
  /** 无 task/session 的 Settings 预信任；Agent 会重新发现并校验 canonical snapshot。 */
  grantWorkspaceHookTrust(
    params: CodezAgentGrantWorkspaceHookTrustParams,
  ): Promise<CodezWorkspaceHookTrustGrantResult>;
  listMcpServerStatuses(params: CodezAgentListMcpServerStatusesParams): Promise<CodezMcpListResult>;
  listPlugins(params: CodezAgentPluginViewParams): Promise<CodezPluginsListResult>;
  /**
   * Codex 子智能体（agent roles）文件列表：user/project 两 scope 的托管目录。
   * 走 workspace 级 agent client（bridge 按 attachment cwd 校验 project scope），
   * 不走独立 plugin management 进程。
   */
  listAgentRoles(params: CodezAgentWorkspaceTarget): Promise<CodezAgentsListResult>;
  /** 新建或更新角色 TOML；更新传 originalName，不支持改名（删除+新建）。 */
  writeAgentRole(params: CodezAgentWriteAgentRoleParams): Promise<CodezAgentsWriteResult>;
  /** 删除角色 TOML；按 effective name 定位，文件必须存在于该 scope。 */
  deleteAgentRole(params: CodezAgentDeleteAgentRoleParams): Promise<void>;
  /**
   * Plugin 对话引用 catalog：session-scoped 只读投影。
   * 走 workspace 级 agent client（session 记录只存在于该进程），不走独立插件管理进程。
   */
  getPluginReferenceCatalog(
    params: CodezAgentPluginReferenceCatalogParams,
  ): Promise<CodezPluginsReferenceCatalogResult>;
  /** Composer Skill 引用 catalog；带 sessionId 时读取该 runtime 的冻结快照。 */
  getSkillReferenceCatalog(
    params: CodezAgentSkillReferenceCatalogParams,
  ): Promise<CodezSkillsReferenceCatalogResult>;
  // 已保存工作流的 GUI 中枢：workspace 级、无会话，每次调用现扫 `<cwd>/.codez/workflows/`。
  // 全局档传 `scope: "global"`：带 workspace 就用它当载体，不带则由 services 层自选本机载体运行时。
  listSavedWorkflows(params: CodezAgentListSavedWorkflowsParams): Promise<CodezWorkflowsListResult>;
  getSavedWorkflow(params: CodezAgentGetSavedWorkflowParams): Promise<CodezWorkflowsGetResult>;
  updateSavedWorkflowMeta(
    params: CodezAgentUpdateSavedWorkflowMetaParams,
  ): Promise<CodezWorkflowsUpdateMetaResult>;
  deleteSavedWorkflow(
    params: CodezAgentDeleteSavedWorkflowParams,
  ): Promise<CodezWorkflowsDeleteResult>;
  listSavedWorkflowRuns(
    params: CodezAgentListSavedWorkflowRunsParams,
  ): Promise<CodezWorkflowsRunsResult>;
  // 在项目档 / 全局档之间移动同名文件：
  // `workspace` 是载体（移到项目传目标项目、移到全局传源项目），`to` 是落点档；不覆盖已存在的目标。
  moveSavedWorkflow(params: CodezAgentMoveSavedWorkflowParams): Promise<CodezWorkflowsMoveResult>;
  resolveSuggestedPluginReference(
    params: CodezAgentResolveSuggestedPluginReferenceParams,
  ): Promise<import("@codez/shared").CodezPluginsResolveSuggestedReferenceResult>;
  /** 推荐项 Plugin 首次本地检查缺失后的 operation-scoped 刷新进度。 */
  onDynamicPluginOperationProgress(
    operationId: string,
  ): Event<CodezPluginOperationProgressNotification>;
  getPluginsOverview(params: CodezAgentPluginViewParams): Promise<CodezPluginsOverviewResult>;
  /**
   * 资源管理器：枚举本 Host 内全部本地 Agent 进程（含 plugin / mcp-status 泳道），
   * 并向每个存活 runtime 请求 `process/childProcesses`；单个 runtime 失败只让它的 children 为空。
   */
  collectLocalRuntimeChildProcesses(
    signal?: AbortSignal,
  ): Promise<CodezAgentLocalRuntimeChildProcesses[]>;
  addPluginMarketplace(
    params: CodezAgentAddPluginMarketplaceParams,
  ): Promise<CodezPluginsMarketplaceMutationResult>;
  removePluginMarketplace(
    params: CodezAgentRemovePluginMarketplaceParams,
  ): Promise<CodezPluginsMarketplaceMutationResult>;
  updatePluginMarketplace(
    params: CodezAgentUpdatePluginMarketplaceParams,
  ): Promise<CodezPluginsMarketplaceMutationResult>;
  installPlugin(params: CodezAgentInstallPluginParams): Promise<CodezPluginsInstallResult>;
  cancelPluginOperation(
    params: CodezAgentCancelPluginOperationParams,
  ): Promise<CodezPluginsCancelOperationResult>;
  uninstallPlugin(params: CodezAgentUninstallPluginParams): Promise<CodezPluginsUninstallResult>;
  updatePlugin(params: CodezAgentUpdatePluginParams): Promise<CodezPluginsInstallResult>;
  restoreBuiltinPlugin(
    params: CodezAgentRestoreBuiltinPluginParams,
  ): Promise<CodezPluginsRestoreBuiltinResult>;
  configurePlugin(params: CodezAgentConfigurePluginParams): Promise<CodezPluginsConfigureResult>;
  resetPluginConfig(
    params: CodezAgentResetPluginConfigParams,
  ): Promise<CodezPluginsConfigureResult>;
  validatePlugin(params: CodezAgentValidatePluginParams): Promise<CodezPluginsValidateResult>;
  describePlugin(params: CodezAgentDescribePluginParams): Promise<CodezPluginsDescribeResult>;
  setPluginEnabled(params: CodezAgentSetPluginEnabledParams): Promise<CodezPluginsSetEnabledResult>;
  // ---- 定时任务(automation)管理 ----
  listAutomations(params: CodezAgentWorkspaceTarget): Promise<CodezAutomation[]>;
  listAllAutomations(): Promise<CodezAutomation[]>;
  createAutomation(params: CodezAgentCreateAutomationParams): Promise<CodezAutomation>;
  updateAutomation(params: CodezAgentUpdateAutomationParams): Promise<CodezAutomation | null>;
  deleteAutomation(params: CodezAgentAutomationIdParams): Promise<void>;
  setAutomationEnabled(params: CodezAgentSetAutomationEnabledParams): Promise<void>;
  restartAutomation(params: CodezAgentAutomationIdParams): Promise<void>;
  runAutomationNow(params: CodezAgentAutomationIdParams): Promise<CodezAgentRunAutomationNowResult>;
  listAutomationRuns(params: CodezAgentAutomationIdParams): Promise<CodezAutomationRun[]>;
  deleteAutomationRun(params: CodezAgentDeleteAutomationRunParams): Promise<void>;
  generateWorkspaceText(
    params: CodezAgentGenerateWorkspaceTextParams,
  ): Promise<CodezWorkspaceGenerateTextResult>;
  canGenerateWorkspaceText(params: CodezAgentWorkspaceTarget): Promise<boolean>;
  testModelConnectivity(
    params: CodezAgentTestModelConnectivityParams,
  ): Promise<CodezProviderTestModelConnectivityResult>;
  /**
   * @deprecated：send 主路径已收敛 v4 sendText 命令。仅剩两个消费点——
   * adapter 带附件输入回退（待附件命令面落地后移除）与 codezSessionService
   * pass-through；新代码禁止回用。
   */
  sendPrompt(params: CodezAgentSendPromptParams): Promise<CodezSessionSendResult>;
  compactSession(params: CodezAgentCompactParams): Promise<CodezSessionCompactResult>;
  goalSession(params: CodezAgentGoalParams): Promise<CodezSessionGoalResult>;
  closeSession(
    params: CodezAgentSessionTarget & { expectedPersistence?: "deferred" | "immediate" },
  ): Promise<boolean>;
  setModel(params: CodezAgentSetModelParams): Promise<CodezSessionStateSnapshot>;
  setThoughtLevel(params: CodezAgentSetThoughtLevelParams): Promise<CodezSessionStateSnapshot>;
  setMode(params: CodezAgentSetModeParams): Promise<CodezSessionStateSnapshot>;
  respondSessionRuntimePreferences(
    params: CodezAgentRespondSessionRuntimePreferencesParams,
  ): Promise<void>;
  onDynamicSessionRuntimePreferencesRequest(): Event<CodezAgentSessionRuntimePreferencesRequest>;
  /**
   * CLI 进程级资源样本，带 services 打的 lane 标签（CLI 自己不知道 lane）。
   * 使用 dynamic event 避免 RPC 服务在无人订阅时缓冲周期事件；
   * 该事件不属于 session/conversation continuous 或 replayable 状态。
   */
  onDynamicProcessResourceSample(): Event<AgentLaneResourceSample>;
  /** MCP 进程生命周期与低频内存事件，仅供可信 Host relay 上报 ARMS。 */
  onDynamicMcpTelemetry(): Event<CodezMcpTelemetryEvent>;
  /** MCP 进程树资源事实，只供可信 Host 汇总上报。 */
  onDynamicMcpResourceSamples(): Event<CodezMcpResourceSample[]>;
  /** Bash 完成事实，仅可信 Host 资源旁路订阅。 */
  onDynamicToolExecResource(): Event<CodezToolExecResource>;
  /**
   * @deprecated 旧协议订阅面（session/subscribe + session/event + state.updated）。
   * task-index syncer 已迁 v4 sessions-index/workspace-config 帧；
   * 仅剩 codezTaskServiceAdapter.onDynamicTaskEvent（replayable 读路径）消费。
   * 写路径已收敛 v4 命令面；本订阅是读路径投影源。
   */
  onDynamicSessionEvent(params: CodezAgentSessionSubscribeParams): Event<CodezAgentServiceEvent>;
  // ── v4 conversation 通道（竖切）──
  /** RPC attachment 建立后先读取 host 可信 hello。 */
  helloConversationV4(): Promise<HelloMessage>;
  /** hello 校验后回送 clientHello；metadata 不能覆盖 connection mode/profile。 */
  initializeConversationV4(clientHello: ClientHello): Promise<void>;
  /** 仅供 trusted host relay/facade；terminal RPC caller 必须被 connection scope 拒绝。 */
  setConnectionFlowStateV4(params: CodezAgentConnectionFlowParams): Promise<void>;
  subscribeConversationV4(
    params: CodezAgentConversationSubscribeParams,
  ): Promise<V4ConversationSubscribeResult>;
  resyncConversationV4(
    params: CodezAgentConversationResyncParams,
  ): Promise<V4ConversationResyncResult>;
  unsubscribeConversationV4(params: CodezAgentConversationUnsubscribeParams): Promise<void>;
  /** rows/range 行分页 query（loadOlder 游标向上补历史）。 */
  conversationRowsRangeV4(
    params: CodezAgentConversationRowsRangeParams,
  ): Promise<V4ConversationRowsRangeResult>;
  conversationPlansV4(
    params: CodezAgentConversationPlansParams,
  ): Promise<V4ConversationPlansResult>;
  /** workflow run 事件日志分页；与 plans 同族（只读、无状态、超时重发安全）。 */
  conversationWorkflowRunEventsV4(
    params: CodezAgentConversationWorkflowRunEventsParams,
  ): Promise<V4ConversationWorkflowRunEventsResult>;
  /** workflow run 枚举；journal-backed 的重启后发现面。 */
  conversationWorkflowRunsV4(
    params: CodezAgentConversationWorkflowRunsParams,
  ): Promise<V4ConversationWorkflowRunsResult>;
  /** Codex thread-history projection；独立于 legacy DWF workflowRuns。 */
  codexHistoryRunsV4(
    params: CodezAgentCodexHistoryRunsParams,
  ): Promise<CodexConversationHistoryRunsResult>;
  /** workflow run 的用户面产物清单；与 plans 同族（只读、无状态、超时重发安全）。 */
  conversationWorkflowRunArtifactsV4(
    params: CodezAgentConversationWorkflowRunArtifactsParams,
  ): Promise<V4ConversationWorkflowRunArtifactsResult>;
  /** 预置看板的条目分页；hook 以 itemCount 变化为信号增量拉取。 */
  conversationWorkflowRunArtifactDataV4(
    params: CodezAgentConversationWorkflowRunArtifactDataParams,
  ): Promise<V4ConversationWorkflowRunArtifactDataResult>;
  /** 内容产物的字节，一次一块；授权在 CLI 侧（journal 行才是取字节的依据）。 */
  conversationWorkflowRunArtifactReadV4(
    params: CodezAgentConversationWorkflowRunArtifactReadParams,
  ): Promise<V4ConversationWorkflowRunArtifactReadResult>;
  /** dwf 工作区 transcript 的清单。 */
  conversationWorkflowRunWorkspaceV4(
    params: CodezAgentConversationWorkflowRunWorkspaceParams,
  ): Promise<V4ConversationWorkflowRunWorkspaceResult>;
  /** 一个工作区节点的有界正文。 */
  conversationWorkflowRunNodeResultV4(
    params: CodezAgentConversationWorkflowRunNodeResultParams,
  ): Promise<V4ConversationWorkflowRunNodeResultResult>;
  backgroundBashOutputV4(
    params: CodezAgentBackgroundBashOutputParams,
  ): Promise<BackgroundBashOutputResult>;
  conversationFileChangesV4(
    params: CodezAgentConversationFileChangesParams,
  ): Promise<V4ConversationFileChangesResult>;
  conversationFileRewindPreviewV4(
    params: CodezAgentConversationFileRewindPreviewParams,
  ): Promise<V4ConversationFileRewindPreviewResult>;
  conversationFileRewindProjectionOverlayV4(
    params: CodezAgentConversationFileRewindProjectionOverlayParams,
  ): Promise<void>;
  sendConversationCommandV4(params: CodezAgentConversationCommandParams): Promise<CommandAck>;
  queryConversationCommandsV4(params: CodezAgentCommandsQueryParams): Promise<CommandsQueryResult>;
  attachmentBeginV4(params: CodezAgentAttachmentBeginParams): Promise<V4AttachmentBeginResult>;
  attachmentChunkV4(params: CodezAgentAttachmentChunkParams): Promise<V4AttachmentChunkResult>;
  attachmentCommitV4(params: CodezAgentAttachmentTerminalParams): Promise<V4AttachmentCommitResult>;
  attachmentAbortV4(params: CodezAgentAttachmentTerminalParams): Promise<void>;
  /** Desktop local 已发送视频 source query；远端与 Web 返回 chunked。 */
  attachmentPreviewSourceV4(
    params: CodezAgentAttachmentPreviewSourceParams,
  ): Promise<V4AttachmentPreviewSourceResult>;
  /** 已发送 image/video 只读分块查询；connection scope 注入可信 workspace 连接。 */
  attachmentReadV4(params: CodezAgentAttachmentReadParams): Promise<V4AttachmentReadResult>;
  /** Share 读取 userInput 附件，允许 text/plain 等非媒体类型。 */
  conversationAttachmentReadV4(
    params: CodezAgentConversationAttachmentReadParams,
  ): Promise<V4ConversationAttachmentReadResult>;
  /** Share 选择阶段只读 userInput 附件元数据，不读取完整内容。 */
  conversationAttachmentStatV4(
    params: CodezAgentConversationAttachmentStatParams,
  ): Promise<V4ConversationAttachmentStatResult>;
  /** workspace 级下行帧流（v4/conversation/frame），renderer 侧按 topic 自行路由。 */
  onDynamicConversationFrame(
    params: CodezAgentWorkspaceTarget,
  ): Event<ConversationTopicWireCandidate>;
  /** workspace 级 live telemetry 事实；connection facade 仅向可信 desktop-continuous 下游暴露。 */
  onDynamicLocalTtftFacts(
    params: CodezAgentWorkspaceTarget,
  ): Event<import("@codez/shared").LocalTtftFacts>;
  onDynamicConversationTelemetryFact(
    params: CodezAgentWorkspaceTarget,
  ): Event<ConversationTelemetryFact>;
  /** 当前窗口全部本地 live task 的 CUA 权限观察；历史、远程与 replayable 不在此事件面。 */
  onDynamicCuaPermissionObservation(): Event<CodezAgentCuaPermissionObservation>;
  // ── sessions-index 通道（列表活性）──
  subscribeSessionsIndexV4(
    params: CodezAgentSessionsIndexSubscribeParams,
  ): Promise<V4SessionsIndexSubscribeResult>;
  resyncSessionsIndexV4(
    params: CodezAgentConversationResyncParams,
  ): Promise<V4ConversationResyncResult>;
  unsubscribeSessionsIndexV4(params: CodezAgentConversationUnsubscribeParams): Promise<void>;
  /** workspace 级 sessions-index 下行帧流（与 conversation 同一通知，按 topic 前缀分流）。 */
  onDynamicSessionsIndexFrame(
    params: CodezAgentWorkspaceTarget,
  ): Event<SessionsIndexTopicWireCandidate>;
  // ── workspace-config 通道（配置目录活性；task-index syncer 消费）──
  subscribeWorkspaceConfigV4(
    params: CodezAgentWorkspaceConfigSubscribeParams,
  ): Promise<V4WorkspaceConfigSubscribeResult>;
  resyncWorkspaceConfigV4(
    params: CodezAgentConversationResyncParams,
  ): Promise<V4ConversationResyncResult>;
  unsubscribeWorkspaceConfigV4(params: CodezAgentConversationUnsubscribeParams): Promise<void>;
  /** workspace 级 workspace-config 下行帧流（与 conversation 同一通知，按 topic 前缀分流）。 */
  onDynamicWorkspaceConfigFrame(
    params: CodezAgentWorkspaceTarget,
  ): Event<WorkspaceConfigTopicWireCandidate>;
  /**
   * （CLI 重连重订）：agent 进程换代通知（超时回收/崩溃后重新拉起）。
   * v4 订阅活在 CLI 进程内存，进程换代即失效；订阅方（task-index syncer 等）
   * 收到后必须对该 workspaceKey 重发 subscribe，否则帧流静默中断。
   */
  onAgentRuntimeRestarted(listener: (event: { workspaceKey: string }) => void): IDisposable;
  /**
   * Agent client 在 service 内完成登记后发布 available，当前 client 关闭后发布 unavailable。
   * 这是被动 observer attach/detach 的唯一生命周期信号，不表达用户使用租约。
   */
  onAgentRuntimeLifecycle?: (
    listener: (event: CodezAgentRuntimeLifecycleEvent) => void,
  ) => IDisposable;
  /** 当前 desktop-local CUA turn 是否仍在执行，用于 Helper recovery 避免中途回收 Agent。 */
  hasActiveCuaOperationTurn(): boolean;
  disposeWorkspace(params: CodezAgentWorkspaceTarget): Promise<void>;
  disposeAll(): void;
}

export const ICodezAgentService = createServiceDescriptor<ICodezAgentService>(
  ServiceChannels.CodezAgent,
);
