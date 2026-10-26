import {
  createRemoteProjectService,
  IRemoteProjectService,
  projectWorkspaceSettings,
  readRemoteProjectDirectory,
} from "#src/remote-projects/index.js";
export {
  createRemoteProjectConnectionAdmission,
  remoteProjectHostIdForProfile,
  remoteProjectHostIdForTarget,
  prepareRemoteServerConnection,
} from "#src/remote-projects/index.js";
import {
  createCodexGlobalRolloutSyncer,
  createProjectService,
  createTaskAutoArchiveScheduler,
  IProjectService,
  shouldRescanTaskAutoArchive,
} from "#src/project/index.js";
export { createLegacySingleRootProjectService } from "#src/project/index.js";
export { createRemoteProjectService } from "#src/remote-projects/index.js";
import {
  getCodezDataRootDir as projectDataRoot,
  getCodexRolloutScanCachePath,
} from "#src/paths.js";
import { createTaskGroupService, ITaskGroupService, groupTaskKey } from "#src/task-groups/index.js";
import { IGenUiService } from "./gen-ui/contract.js";
import { createGenUiService } from "./gen-ui/node.js";
import { channelReplyHostRequestSchema, channelReplyResultSchema } from "@codez/shared";
/* eslint-disable max-lines -- host process 服务注册和启动装配需要集中维护，拆散后会更难追踪依赖注入顺序 */
// Node.js service implementations — NOT safe to import in browser code
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  createNodeProviderRuntimePathEnv,
  NodeModelSelectionConfigRepository,
  PERSONAL_PROVIDER_CONFIG_FILE_NAME,
} from "@codez/provider-node";
import { getAppConfigDir as resolveAppConfigDir, getCodezDataRootDir } from "./paths.js";
import { createDesktopBrowserRelay } from "./codez-agent/desktopBrowserRelay.js";
import {
  createHasExistingLocalTask,
  hasAnyAgentSessionRow,
  resolveAgentSessionDbPath,
} from "./onboarding/localUsageEvidence.js";
import {
  buildLocalMediaPreviewUrl,
  type DynamicWorkflowMode,
  codexConfigResponseSchema,
  codexModelsResponseSchema,
  isProviderProvisioningAccountCredentialKey,
  type ProviderProvisioningTrigger,
} from "@codez/shared";

export {
  materializeCodezBuiltinProviderConfig,
  CODEZ_BUILTIN_PROVIDER_CONFIG_FILE_ENV,
} from "@codez/provider-node";
import { randomUUID } from "node:crypto";
import { getAppConfigDir as getContentAppConfigDir } from "#src/paths.js";
import { ICloudContentService } from "#src/cloud-content/cloudContent.js";
import { createCloudContentService } from "#src/cloud-content/cloudContentService.js";
import { IMarketingTouchService } from "#src/marketing-touch/marketingTouch.js";
import { createMarketingTouchService } from "#src/marketing-touch/marketingTouchService.js";
import { createMarketingAssetRegistry } from "#src/marketing-touch/marketingAssetRegistry.js";
import type { IChannel } from "@codez/rpc";
import {
  readTopicResourceFromRelay,
  validateTopicResourceFromRelay,
} from "./codez-agent/topicResourceRelayClient.js";
export {
  createTopicResourcePeers,
  type TopicResourcePeers,
} from "./codez-agent/topicResourcePeers.js";
export { createTopicResourceRelayChannel } from "./codez-agent/topicResourceRelayChannel.js";

export { createFileService } from "./file/fileService.js";
export {
  attributeHostProcessTree,
  createProcessResourceSampler,
  createProcessResourceTableReader,
  type HostResourceUsageAgent,
  type ProcessResourceSample,
  type ProcessResourceSampler,
} from "./process/processResourceSampler.js";
export { createMediaPreviewService } from "./media-preview/mediaPreview.js";
export { createContentBundleCache } from "#src/cloud-content/contentBundleCache.js";
export type { ContentBundle } from "#src/cloud-content/contentBundleCache.js";
export type { CreateFileServiceOptions } from "./file/fileService.js";
export {
  defaultWorkspaceFileSearchFilter,
  type WorkspaceFileSearchDecision,
  type WorkspaceFileSearchEntry,
  type WorkspaceFileSearchFilter,
} from "./file/workspaceFileMentionFilter.js";
export {
  createFsFaultInjector,
  getProcessFsFaultInjector,
  maybeThrowInjectedFsFault,
  parseFsFaultRulesFromEnvValue,
  resetProcessFsFaultInjectorForTests,
  setFsFaultInjectorForTests,
  CODEZ_E2E_FS_FAULTS_ALLOW_ENV,
  CODEZ_E2E_FS_FAULTS_ENV,
} from "./fs/fsFaultInjection.js";
export type {
  FsFaultCheckInput,
  FsFaultHit,
  FsFaultInjector,
  FsFaultOperation,
  FsFaultRuleConfig,
  InjectedFsFaultError,
} from "./fs/fsFaultInjection.js";
export {
  setDataBaseDir,
  getDataBaseDir,
  getCodezDataRootDir,
  getConversationWorkspaceDir,
  getAppConfigDir,
  getExportLogStageDir,
  getExportLogDir,
  getFeedbackRootDir,
  getFeedbackAttachmentDir,
  getFeedbackLogArchiveDir,
  getGitCheckpointIndexRootDir,
  copyDataDirectory,
  validateDataBaseDirTarget,
  CODEZ_WINDOWS_APP_INSTALL_DIR_ENV,
} from "./paths.js";
export { createGitService } from "./git/gitService.js";
export { GitCommitMessageGenerator } from "./git/gitCommitMessageGenerator.js";
export { createGitCheckpointService } from "./git/gitCheckpointService.js";
export { createCodexDesktopFileRewindService } from "./desktop-file-rewindService.js";
export { createSystemService } from "./system/systemService.js";
export { listSSHConfigAliasesFromLocalConfig } from "./system/sshConfigAlias.js";
export { createTerminalService } from "./terminal/terminalService.js";
export {
  createSettingService,
  createSettingServiceWithMigrations,
} from "./setting/settingService.js";
export { createCredentialService } from "./credential/credentialService.js";
export { createBroadcastService } from "./broadcast/broadcastService.js";
export { createCodezAgentService } from "./codez-agent/codezAgentService.js";
export { createCodezTaskServiceAdapter } from "./codez-agent/codezTaskServiceAdapter.js";
export {
  isCodexScheduledPromptCapabilitySupported,
  resolveCodexAutomationHistory,
  type CodexAutomationHistoryResolution,
} from "./codez-agent/codexAutomationAdapter.js";
export { createCodezSessionService } from "./codez-session/codezSessionService.js";
export {
  resolveDefaultCodezAgentCommand,
  CodezAgentProcessManager,
} from "./codez-agent/codezAgentProcessManager.js";
export type {
  CodezAgentCommand,
  CodezAgentCommandResolver,
  CodezAgentCommandResolverContext,
  CodezAgentProcessManagerOptions,
} from "./codez-agent/codezAgentProcessManager.js";
export { CodezProtocolClient } from "./codez-agent/codezProtocolClient.js";
export type { CodezProtocolTransport } from "./codez-agent/codezProtocolTransport.js";
export { CodezStdioTransport } from "./codez-agent/codezStdioTransport.js";
export {
  getCodezStdioTapDevLogDir,
  readCodezStdioTapDevState,
  setCodezStdioTapDevEnabled,
} from "./codez-agent/codezStdioTapDevConfig.js";
export type { CodezStdioTapDevState } from "@codez/shared";
export {
  createCuaHelperInstaller,
  requestHelperAccessibilityPermissionViaLaunchServices,
  requestHelperScreenRecordingPermissionViaLaunchServices,
} from "./cua-permission-broker/index.js";
export {
  canonicalizeCuaHelperInstallerOptions,
  createCanonicalCuaHelperInstaller,
  normalizeCuaHelperArch,
  normalizeCuaHelperArchs,
  resolveCuaPermissionUnavailableErrorKind,
} from "./cua-permission-broker/cuaHelperInstaller.js";
export type {
  CuaHelperInstaller,
  CuaHelperInstallerOptions,
} from "./cua-permission-broker/index.js";
export { createProjectWorkspaceNavigation } from "#src/project-workspace-navigation/index.js";
export { createBotsService } from "./bots/botsService.js";
export { createFileWatcherService } from "./fileWatcher/fileWatcherService.js";
export { createOAuthService } from "./oauth/oauthService.js";
export { createOAuthProviderLogoutHandler } from "./oauth/oauthProviderLogout.js";
export { OAuthCredentialRepo } from "./oauth/repo/oauthCredentialRepo.js";
export { createTelemetryCore, ensureTelemetryDeviceMid } from "./telemetry/telemetryCore.js";
export type { EnsureTelemetryDeviceMidOptions } from "./telemetry/telemetryCore.js";
export type { AccountRequestAuthResolver } from "./model-provider/accountProviderRequestAuthService.js";
export { createAccountProviderCredentialStore } from "./model-provider/accountProviderCredentialStore.js";
export type {
  AccountProviderCredentialStore,
  AccountProviderCredentialStoreOptions,
} from "./model-provider/accountProviderCredentialStore.js";
export { importLegacyPersonalProviderConfig } from "./model-provider/legacyPersonalProviderConfigImporter.js";
export {
  createAccountProviderConfigSource,
  createAccountProviderConnectionResolver,
  createCodingPlanFamilyAvailabilityResolver,
  resolveCurrentAccountAccess,
} from "./model-provider/accountProviderConnectionResolver.js";
export { bindAccountProviderInvalidation } from "./model-provider/accountProviderInvalidation.js";
export type {
  AccountProviderConfigSourceOptions,
  AccountProviderConnectionResolverOptions,
  AccountProviderConnectionSettings,
  AccountProviderFamilyAvailabilityInput,
  AccountProviderFamilyAvailabilityResolver,
  CodingPlanFamilyAvailabilityResolverOptions,
} from "./model-provider/accountProviderConnectionResolver.js";
export {
  createProviderConfigRuntime,
  ProviderConfigRuntime,
} from "./model-provider/providerConfigRuntime.js";
export type { ProviderConfigRuntimeOptions } from "./model-provider/providerConfigRuntime.js";
export {
  createProviderRuntime,
  createProviderRuntimeFromConfigRuntime,
  EmptyAccountProviderConfigSource,
  ProviderRuntime,
} from "./model-provider/providerRuntime.js";
export {
  createCodexModelSelectionService,
  type CodexModelSelectionService,
} from "./model-provider/codexModelSelectionService.js";
export type {
  ProviderRuntimeDependencies,
  ProviderRuntimeOptions,
} from "./model-provider/providerRuntime.js";
export {
  createProviderProvisioningSource,
  listProviderProvisioningCredentialKeys,
  providerRuntimeApiKeyCredentialKey,
  resolveCredentialFilePath,
  type ProviderProvisioningSource,
  type ProviderProvisioningSourceOptions,
} from "./model-provider/providerProvisioningSource.js";
export {
  createProviderProvisioningTarget,
  type ProviderProvisioningTargetOptions,
} from "./model-provider/providerProvisioningTarget.js";
export {
  CODEX_NATIVE_PROVIDER_LOCAL_ENVIRONMENT_KEY,
  codexNativeProviderKeyCredentialKey,
  codexNativeProviderKeyEnvName,
  createCodexNativeProviderKeyService,
  readCodexNativeProviderKeyEntries,
  type CodexNativeProviderKeyServiceOptions,
  type CodexNativeProviderSpawnEnv,
} from "./model-provider/codexNativeProviderKey.js";
export { ICodexNativeProviderKeyService } from "./model-provider/codexNativeProviderKeyService.js";
export {
  createModelSelectionService,
  createProviderSettingsService,
  IModelSelectionService,
  IProviderSettingsService,
} from "./model-provider/providerFacadeServices.js";
export { createAccountRequestAuthService } from "./model-provider/accountRequestAuthService.js";
export type { IAccountRequestAuthService } from "./model-provider/accountRequestAuthService.js";
export { createAccountProviderRequestAuthService } from "./model-provider/accountProviderRequestAuthService.js";
export {
  resolveAccountTeamPlanRuntimeApiKey,
  resolveAccountTeamPlanRuntimeMaterial,
} from "./model-provider/accountProviderTeamPlanRequestKey.js";
export { createAccountProjectTokenClient } from "./model-provider/accountProjectTokenClient.js";
export { createAccountProviderCredentialService } from "./model-provider/accountProviderCredentialService.js";
export { createSourceServerWorkspaceService } from "./source-server-workspace/sourceServerWorkspaceService.js";
export {
  SourceServerWorkspaceIdentityChannelServer,
  SourceServerWorkspaceIdentityMapper,
} from "./source-server-workspace/sourceServerWorkspaceIdentityChannelServer.js";
export {
  SourceServerWorkspaceAliasRepo,
  SourceServerWorkspaceIdentityConflictError,
} from "./session/sourceServerWorkspaceAliasRepo.js";
export { migrateControllerRemoteWorkspaceIdentity } from "./session/controllerRemoteIdentityMigration.js";
export type {
  ControllerRemoteIdentityMigrationOptions,
  ControllerRemoteIdentityMigrationReport,
} from "./session/controllerRemoteIdentityMigration.js";
export { createUsageStatsService } from "./usage-stats/usageStatsService.js";
// Storage：service 与 adapters 工厂；desktop host 负责组装（Worker runner 在 desktop 包内）
export { createStorageService } from "./storage/app/storageService.js";
// 组装方与工厂在同一入口取类型，避免 desktop main 为服务接口再引 browser 入口。
export type { IStorageService } from "./storage/contract.js";
export type {
  FsCleanerPort as StorageFsCleanerPort,
  RootsResolverPort as StorageRootsResolverPort,
  ScanRunnerPort as StorageScanRunnerPort,
  StorageScanProgress,
  StorageScanRunRequest,
} from "./storage/app/ports.js";
export { createFsStorageCleaner } from "./storage/adapters/fsCleaner.js";
export {
  createStorageRootsResolver,
  resolveStorageRoots,
} from "./storage/adapters/rootsResolver.js";
export { createFsVolumeProbe } from "./storage/adapters/volumeProbe.js";
export { runStorageScan } from "./storage/adapters/inProcessScanRunner.js";
export { createCodingPlanSubscriptionService } from "./coding-plan-subscription/codingPlanSubscriptionService.js";
export { createClientConfigService } from "./client-config/clientConfigService.js";
export { createClientScenesService } from "./client-scenes/clientScenesService.js";
export { createSkillsService } from "./skills/skillsService.js";
export { createSkillSyncService } from "./skill-sync/skillSyncService.js";
export { createMcpSyncService } from "./mcp-sync/mcpSyncService.js";
export { createPluginSyncService } from "./plugin-sync/pluginSyncService.js";
export { createPluginsService } from "./plugins/pluginsService.js";
export { createPluginManagementService } from "./plugins/pluginManagementService.js";
export { createSubagentsService } from "./subagents/subagentsService.js";
export { createCommandsService } from "./commands/commandsService.js";
export { createHooksService } from "./hooks/hooksService.js";
export { createMemoryService } from "./memory/memoryService.js";
export { createOutputStyleService } from "./output-style/outputStyleService.js";
export { createSettingsSyncService } from "./settings-sync/settingsSyncService.js";
export { createFeedbackDiagnosticArchive } from "./feedback/feedbackLogArchive.js";
export { createFeedbackService } from "./feedback/feedbackService.js";
export type { CreateFeedbackServiceOptions } from "./feedback/feedbackService.js";
export { createLocalPromptAttachmentTransferService } from "./prompt-attachment-transfer/promptAttachmentTransferService.js";
export {
  createLocalConversationShareArtifactSource,
  createRemoteConversationShareArtifactSource,
} from "./conversation-share/conversationShareArtifactSource.js";
export { createNodeApiClient, NodeApiClient } from "./providers/api/nodeApiClient.js";
export {
  createHostApiNetworkTransport,
  type HostApiNetworkTransport,
} from "./providers/api/nodeApiNetwork.js";
export {
  buildRuntimeProcessEnvPatch,
  captureLoginShellEnvSnapshot,
  normalizeRuntimeProcessEnv,
  prepareRuntimeProcessEnvPatch,
} from "./runtime-tools/runtimeCommandEnv.js";

// 定时任务管理与 scheduler 共用同一套 node-only 存储和 cron 语义。
export {
  AutomationRepo,
  DISPATCH_RETRY_BASE_MS,
  DISPATCH_RETRY_CAP_MS,
  DISPATCH_MAX_ATTEMPTS,
  CLAIM_STALE_MS,
  computeRetryAt,
} from "./session/automationRepo.js";
export { AutomationService, InvalidCronExprError } from "./session/automationService.js";
// Codex 原生定时任务与 scheduler 共用终态判定；仓储实现保持内部封装。
export {
  CODEX_AUTOMATION_CORRELATION_STATES,
  isTerminalCodexAutomationCorrelationState,
  type CodexAutomationCorrelationState,
  type CodexAutomationCorrelation,
} from "./session/codexAutomationCorrelation.js";
// 闲时任务与 automation 同库不同表；类型/常量全独立。
export { OffPeakTaskRepo, OFF_PEAK_CLAIM_STALE_MS } from "./session/offPeakTaskRepo.js";
// host 域终态回填 files_changed 复用现有 task diff 汇总。
export { buildTaskChangeSummary } from "./session/taskChangeSummary.js";
export { OffPeakTaskService } from "./session/offPeakTaskService.js";
export { IOffPeakTaskService } from "./session/offPeakTask.js";
export { IHighspeedCardService } from "./highspeed/highspeedCard.js";
export { createOffPeakServerClient, OffPeakServerError } from "./session/offPeakServerClient.js";
export { isOffPeakMockEnabled, startOffPeakMockGateway } from "./session/offPeakMockGateway.js";
export {
  buildOffPeakRequestAuth,
  createOffPeakOriginResolver,
  resolveOffPeakCredentials,
  resolveOffPeakCodingPlanSupport,
  resolveOffPeakMockUpstream,
  OffPeakCodingPlanUnavailableError,
  OffPeakCredentialsUnavailableError,
  OffPeakModelUnavailableError,
  OffPeakPermanentDispatchError,
} from "./session/offPeakRuntimeModel.js";
export { createServiceLogger } from "./logger/serviceLogger.js";
export {
  buildOfficialMcpAuthHeaders,
  createOfficialMcpAuthHeadersResolver,
  resolveOfficialMcpCredentials,
} from "./official-mcp/officialMcpCredentials.js";
export {
  computeAutomationNextRunAt,
  computeNextRunAt,
  computeScheduleRuleNextRunAt,
  isOneShotAutomation,
  isValidCronExpr,
} from "./session/automationCron.js";

import {
  buildServerRemoteWorkspaceIdentity,
  remoteHostIdFromWorkspaceIdentity,
} from "@codez/shared";
import { SourceServerWorkspaceAliasRepo } from "./session/sourceServerWorkspaceAliasRepo.js";
import { SourceServerWorkspaceIdentityMapper } from "./source-server-workspace/sourceServerWorkspaceIdentityChannelServer.js";
import { ServiceCollection } from "./collection.js";
import { IFileService } from "./file/file.js";
import { IMediaPreviewService } from "./media-preview/mediaPreview.js";
import { IGitService } from "./git/git.js";
import { IGitCheckpointService } from "./git/gitCheckpoint.js";
import { ISystemService } from "./system/system.js";
import { ITerminalService } from "./terminal/terminal.js";
import { ISettingService } from "./setting/setting.js";
import { IOnboardingRecordService } from "./onboarding/onboardingRecord.js";
import { ICredentialService } from "./credential/credential.js";
import { IBroadcastService } from "./broadcast/broadcast.js";
import { ICodezTaskService } from "./session/codezTaskService.js";
import { ICodezAgentService } from "./codez-agent/codezAgent.js";
import type { CuaOperationStateReporter } from "./codez-agent/cuaOperationTurnTracker.js";
import { ICodezSessionService } from "./codez-session/codezSession.js";
import {
  createUnsupportedConversationShareService,
  IConversationShareService,
  type IConversationShareService as IConversationShareServiceType,
} from "./conversation-share/conversationShare.js";
import {
  ConversationShareService,
  conversationShareConnectionScopeFactory,
} from "./conversation-share/conversationShareService.js";
import { createLocalConversationShareArtifactSource } from "./conversation-share/conversationShareArtifactSource.js";
import { SharedContextContentCopyError } from "./conversation-share/codexSharedContextContentCopy.js";
import { ConversationShareHttpClient } from "./conversation-share/conversationShareHttpClient.js";
import { IBotsService } from "./bots/bots.js";
import { IFileWatcherService } from "./fileWatcher/fileWatcher.js";
import { IOAuthService } from "./oauth/oauth.js";
import { ISourceServerWorkspaceService } from "./source-server-workspace/sourceServerWorkspace.js";
import { IUsageStatsService } from "./usage-stats/usageStats.js";
import { ICodingPlanSubscriptionService } from "./coding-plan-subscription/codingPlanSubscription.js";
import { IClientScenesService } from "./client-scenes/clientScenes.js";
import { ISkillsService } from "./skills/skills.js";
import { ISkillSyncService } from "./skill-sync/skillSync.js";
import { IMcpSyncService } from "./mcp-sync/mcpSync.js";
import { IPluginSyncService } from "./plugin-sync/pluginSync.js";
import { IPluginsService } from "./plugins/plugins.js";
import { IPluginManagementService } from "./plugins/pluginManagement.js";
import { ISubagentsService } from "./subagents/subagents.js";
import { ICommandsService } from "./commands/commands.js";
import { IHooksService } from "./hooks/hooks.js";
import { IMemoryService } from "./memory/memory.js";
import { IOutputStyleService } from "./output-style/outputStyle.js";
import { ISettingsSyncService } from "./settings-sync/settingsSync.js";
import { IFeedbackService } from "./feedback/feedback.js";
import { IPromptAttachmentTransferService } from "./prompt-attachment-transfer/promptAttachmentTransfer.js";
import { createFileService } from "./file/fileService.js";
import { createMediaPreviewService } from "./media-preview/mediaPreview.js";
import type { WorkspaceFileSearchFilter } from "./file/workspaceFileMentionFilter.js";
import { createGitService } from "./git/gitService.js";
import { GitCommitMessageGenerator } from "./git/gitCommitMessageGenerator.js";
import { createGitCheckpointService } from "./git/gitCheckpointService.js";
import { ICodexDesktopFileRewindService } from "./desktop-file-rewind.js";
import { createCodexDesktopFileRewindService } from "./desktop-file-rewindService.js";
import { createSystemService } from "./system/systemService.js";
import { createTerminalService } from "./terminal/terminalService.js";
import {
  createSettingService,
  createSettingServiceWithMigrations,
} from "./setting/settingService.js";
import { createOnboardingRecordService } from "./onboarding/onboardingRecordService.js";
import { createLegacyTeamOrganizationResolver } from "./model-provider/legacyTeamOrganizationResolver.js";
import { createObservableSettingService } from "./setting/observableSettingService.js";
import { createCredentialService } from "./credential/credentialService.js";
import { createBroadcastService } from "./broadcast/broadcastService.js";
import { createCodezAgentService } from "./codez-agent/codezAgentService.js";
import { resolveDefaultCodezAgentCommand } from "./codez-agent/codezAgentProcessManager.js";
import { usesCodexBridgeRuntime } from "./codez-agent/codexBridgeCommand.js";
import type { CodezAgentCommandResolver } from "./codez-agent/codezAgentProcessManager.js";
import { buildAgentTelemetrySpawnEnv } from "./codez-agent/agentTelemetryEnv.js";
import { resolveCodezAgentPresentationSurface } from "./codez-agent/codezAgentPresentationSurface.js";
import { createCodezTaskServiceAdapter } from "./codez-agent/codezTaskServiceAdapter.js";
import { createCodezSessionService } from "./codez-session/codezSessionService.js";
import { createCodezTaskIndexSyncer } from "./codez-agent/codezTaskIndexSyncer.js";
import { TaskIndexRepo } from "./session/taskIndexRepo.js";
import { AutomationRepo } from "#src/session/automationRepo.js";
import type { AppSettings } from "@codez/shared";
import { createBotsService } from "./bots/botsService.js";
import { BotsRepo } from "#src/bots/repo.js";
import {
  createBotProjectRuntime,
  type BotProjectConnection,
} from "#src/bot-project-runtime/index.js";
export type { BotProjectConnection } from "#src/bot-project-runtime/contract.js";
import type { SessionMessageSendRequested } from "#src/session/sessionMailbox.js";
import { createFileWatcherService } from "./fileWatcher/fileWatcherService.js";
import { createOAuthService } from "./oauth/oauthService.js";
import {
  isOAuthBusinessRequest,
  resolveOAuthBusinessCredentialValidationRequest,
  isCurrentOAuthCredentialRequest,
} from "#src/oauth/oauthUnauthorizedRequest.js";
import { createOAuthProviderLogoutHandler } from "./oauth/oauthProviderLogout.js";
import { OAuthCredentialRepo } from "./oauth/repo/oauthCredentialRepo.js";
import { readLegacyCodezConfigProviders } from "./model-provider/legacyCodezConfigProviderReader.js";
import { resolveAccountTeamPlanRuntimeMaterial } from "./model-provider/accountProviderTeamPlanRequestKey.js";
import { createAccountProviderCredentialStore } from "./model-provider/accountProviderCredentialStore.js";
import { createAccountProviderCredentialService } from "./model-provider/accountProviderCredentialService.js";
import { createAccountProviderRequestAuthService } from "./model-provider/accountProviderRequestAuthService.js";
import {
  createAccountProviderConfigSource,
  createCodingPlanFamilyAvailabilityResolver,
  resolveCurrentAccountAccess,
} from "./model-provider/accountProviderConnectionResolver.js";
import { bindAccountProviderInvalidation } from "./model-provider/accountProviderInvalidation.js";
import { AccountProviderApiClient } from "./model-provider/accountProviderApiClient.js";
import { createAccountProjectTokenClient } from "./model-provider/accountProjectTokenClient.js";
import { AccountProviderApiKeyResolver } from "./model-provider/accountProviderApiKeyResolver.js";
import { createProviderConfigRuntime } from "./model-provider/providerConfigRuntime.js";
import { fetchCodezBuiltinRemoteRelease } from "./model-provider/codezBuiltinRemoteConfig.js";
import {
  createProviderRuntimeFromConfigRuntime,
  type ProviderRuntime,
} from "./model-provider/providerRuntime.js";
import { createCodexModelSelectionService } from "./model-provider/codexModelSelectionService.js";
import {
  IModelSelectionService,
  IProviderSettingsService,
} from "./model-provider/providerFacadeServices.js";
import { createProviderSettingsConnectivityTester } from "./model-provider/providerSettingsConnectivity.js";
import {
  createProviderProvisioningSource,
  listProviderProvisioningCredentialKeys,
  PROVIDER_PROVISIONING_OAUTH_CREDENTIAL_KEYS,
  providerRuntimeApiKeyCredentialKey,
  resolveCredentialFilePath,
  type ProviderProvisioningSource,
} from "./model-provider/providerProvisioningSource.js";
import { createProviderProvisioningTarget } from "./model-provider/providerProvisioningTarget.js";
import { IProviderProvisioningTargetService } from "./model-provider/providerProvisioning.js";
import { saveProviderApiKeySource } from "./model-provider/providerKeySourceService.js";
import {
  CODEX_NATIVE_PROVIDER_LOCAL_ENVIRONMENT_KEY,
  codexNativeProviderSpawnEnvFromInstalled,
  createCodexNativeProviderKeyService,
  filterCodexNativeKeysByConfigFile,
  resolveCodexNativeProviderSpawnEnv,
} from "./model-provider/codexNativeProviderKey.js";
import { ICodexNativeProviderKeyService } from "./model-provider/codexNativeProviderKeyService.js";
import { buildOffPeakModelSelectionView } from "./model-provider/offPeakModelSelectionView.js";
import { resolveClientConfigPlatform } from "./runtime-tools/clientPlatform.js";
import {
  createAccountRequestAuthService,
  type IAccountRequestAuthService,
} from "./model-provider/accountRequestAuthService.js";
import { createSourceServerWorkspaceService } from "./source-server-workspace/sourceServerWorkspaceService.js";
import { createUsageStatsService } from "./usage-stats/usageStatsService.js";
import { createCodingPlanSubscriptionService } from "./coding-plan-subscription/codingPlanSubscriptionService.js";
import { createClientConfigService } from "./client-config/clientConfigService.js";
import { IClientConfigService } from "./client-config/clientConfig.js";
import { createClientScenesService } from "./client-scenes/clientScenesService.js";
import { createSkillsService } from "./skills/skillsService.js";
import { createSkillSyncService } from "./skill-sync/skillSyncService.js";
import { createMcpSyncService } from "./mcp-sync/mcpSyncService.js";
import {
  IPluginUiAppToolsService,
  IPluginUiSamplingService,
  createPluginUiSamplingService,
  IPluginUiBridgeService,
  createPluginUiAppToolsService,
  createPluginUiBridgeService,
} from "./plugin-ui-bridge/index.js";
import type { PluginSandboxHandle, PluginSandboxRegisterInput } from "@codez/shared/mcp-apps";
import { createPluginSyncService } from "./plugin-sync/pluginSyncService.js";
import { createPluginsService } from "./plugins/pluginsService.js";
import { createPluginManagementService } from "./plugins/pluginManagementService.js";
import { syncCodexNativeCuaSkill } from "./plugins/codexNativeCuaSkill.js";
import { createSubagentsService } from "./subagents/subagentsService.js";
import { createCommandsService } from "./commands/commandsService.js";
import { createHooksService } from "./hooks/hooksService.js";
import { createMemoryService } from "./memory/memoryService.js";
import { createOutputStyleService } from "./output-style/outputStyleService.js";
import { createSettingsSyncService } from "./settings-sync/settingsSyncService.js";
import {
  createFeedbackService,
  type CreateFeedbackServiceOptions,
} from "./feedback/feedbackService.js";
import { createLocalPromptAttachmentTransferService } from "./prompt-attachment-transfer/promptAttachmentTransferService.js";
import { createNodeApiClient } from "./providers/api/nodeApiClient.js";
import {
  createHostApiNetworkTransport,
  type HostApiNetworkTransport,
} from "./providers/api/nodeApiNetwork.js";
import type {
  RuntimeProcessLifecycleReporter,
  RuntimeTaskReporter,
} from "#src/process/runtimeProcessLifecycle.js";
import { initializeRuntimeProcessEnv } from "./runtime-tools/runtimeCommandEnv.js";
import {
  buildAgentEndpointOriginEnv,
  buildAgentRuntimeEnv,
} from "./runtime-tools/agentProxyEnv.js";
import { ensureAppCaCert } from "./runtime-tools/appCaCert.js";
import { createServiceLogger, type ServiceLogger } from "#src/logger/serviceLogger.js";
import { IOffPeakTaskService } from "./session/offPeakTask.js";
import type { HighspeedMockScenario } from "@codez/shared";
import { IHighspeedCardService } from "./highspeed/highspeedCard.js";
import {
  buildHighspeedCodingPlanAuthHeaders,
  HighspeedCardService,
  createHighspeedHttpTransport,
} from "./highspeed/highspeedCardService.js";
import { createHighspeedMockTransport } from "./highspeed/highspeedMockTransport.js";
import { OffPeakTaskService } from "./session/offPeakTaskService.js";
import { OffPeakTaskRepo } from "./session/offPeakTaskRepo.js";
import { createOffPeakServerClient } from "./session/offPeakServerClient.js";
import {
  buildOffPeakRequestAuth,
  createOffPeakOriginResolver,
  resolveOffPeakCredentials,
  resolveOffPeakCodingPlanSupport,
  resolveOffPeakMockUpstream,
} from "./session/offPeakRuntimeModel.js";
import {
  createOfficialMcpAuthHeadersResolver,
  resolveOfficialMcpCredentials,
} from "./official-mcp/officialMcpCredentials.js";
import {
  CODEZ_CODEX_UPDATE_PLAN_ENABLED_ENV_KEY,
  CODEZ_CODEX_BLOCKED_PROVIDER_IDS_ENV_KEY,
  createOfficialMcpTrustedOriginRegistry,
  OFFICIAL_MCP_DEV_TRUSTED_ORIGINS_ENV,
} from "@codez/shared";
import {
  BROKER_GENERATION_ENV,
  BROKER_SOCKET_ENV,
  BROKER_UNAVAILABLE_ENV,
  clearCuaProductHelperAgentEnvUnavailable,
  createCuaPipSessionService,
  createCuaProductMcpServerResolver,
  createProductCuaHelperHost,
  CuaHelperLifecycleManager,
  CuaProductHelperWorkspaceRegistry,
  hasCuaProductHelperAgentEnvUnavailable,
  ICuaPermissionService,
  ICuaPipSessionService,
  isCuaHelperError,
  isCuaLocalDevelopmentRuntime,
  isOfficialCuaPluginEnabledForWorkspace,
  isPotentialCodezCuaAgentMcpServer,
  isScreenCaptureProbeSuccess,
  markCuaProductHelperAgentEnvUnavailable,
  queryHelperScreenRecordingPreflightViaLaunchServices,
  reapOrphanedHelpers,
  shouldRunCuaScreenCaptureProbe,
  waitForCuaHelperStartup,
  type CuaHelperHost,
  type CuaHelperTransportHandle,
  type CuaHelperTransportRestartOptions,
  type CuaHelperTransportRestartResult,
  type ManagedCuaProductHelperHost,
  type CuaProductMcpServerResolver,
  type CuaProductMcpServerResolverContext,
  type CuaPermissionRestartOptions,
  type CuaPermissionRestartResult,
  type CuaPermissionStatusQueryOptions,
  type CuaPermissionStatusResult,
} from "#src/cua-permission-broker/index.js";
import {
  resolveCuaNodeRuntime,
  WindowsCuaDevRuntimeResolutionError,
  type CuaNodeRuntime,
  type WindowsCuaRuntime,
} from "#src/cua-permission-broker/windowsCuaDevRuntime.js";
import {
  createCanonicalCuaHelperInstaller,
  resolveCuaPermissionUnavailableErrorKind,
} from "./cua-permission-broker/cuaHelperInstaller.js";
import { WindowsCuaHelperHost } from "#src/cua-permission-broker/windowsCuaDevHelperHost.js";
import { HELPER_APP_NAME } from "@codez/codez-cua/broker/helperConstants";
import {
  CUA_CREDENTIAL_GRANT_FILE_ENV,
  attachCuaCredentialGrantPublisher,
  createCuaCredentialGrantPublisher,
  resolveCuaCredentialGrantRootDirectory,
  type CuaCredentialGrantPublisher,
} from "./codez-agent/cuaCredentialGrantPublisher.js";
import {
  DEFAULT_CODEZ_MODEL_CONTEXT_BUDGET_STRATEGY,
  CODEZ_JWT_INVALID_BROADCAST_CHANNEL,
  formatLogPrefix,
  isCredentialDecryptError,
  isStartPlanModelProviderId,
  OFF_PEAK_PROVIDER_IDS,
  BIGMODEL_PROVIDER_ID,
  type ProviderFamilyDomain,
  type ServiceAuthorityMode,
  resolveRuntimeCodezEndpointOrigin,
  resolveSafeTelemetryHostname,
  type BrowserBackendDescriptor,
  type BrowserClientMode,
  type BrowserCommand,
  isCodezCuaMcpCommand,
  isCodezCuaMcpPackageArg,
  isCodezCuaInternalFeatureEnabled,
  CODEZ_CUA_PRODUCT_HELPER_ENV_KEY,
  CODEZ_CUA_PLUGIN_AUTHORITY_ENV_KEY,
  type CodezAutomation,
  type CodezAutomationRun,
  getCapturedCodezAgentTelemetryEnv,
  CODEZ_DESKTOP_CONTEXT_PROMPT_ENABLED_ENV,
  CODEZ_NATIVE_BROWSER_CUA_BROWSER_ENV,
  CODEZ_NATIVE_BROWSER_CUA_CUA_ENV,
  CODEZ_NATIVE_BROWSER_CUA_CUA_ENABLED_ENV,
  CODEZ_NATIVE_BROWSER_CUA_ENDPOINT_ENV,
  CODEZ_NATIVE_BROWSER_CUA_TOKEN_FILE_ENV,
  CODEZ_NATIVE_BROWSER_CUA_MCP_SERVER_NAME,
  CODEZ_NATIVE_BROWSER_CUA_MCP_ENTRY_MODE,
  CODEZ_DESKTOP_MCP_SERVERS_ENV_KEY,
  ZAI_PROVIDER_ID,
  codezAccountAccessSchema,
  codezProviderAccountAccessSchema,
  CODEZ_VERSION,
  CODEZ_ENV,
  buildRuntimeCodezApiUrl,
  isRemoteWorkspaceIdentity,
} from "@codez/shared";

// 这些 conversation-share 实现依赖 Node 文件系统；仅通过 @codez/services/node 暴露，
// 防止 browser-safe 根入口把 node:* 依赖带进 renderer。
export {
  ConversationShareService,
  ConversationShareHttpClient,
  conversationShareConnectionScopeFactory,
};

import { createPluginUiAccountBindings } from "./plugin-ui-bridge/instanceAccounts.js";
interface ServiceWithDisposeAll {
  disposeAll: () => void;
}

interface ServiceWithDisposeAllAndWait {
  disposeAllAndWait: () => Promise<void>;
}

const CUA_PRODUCT_HELPER_AGENT_ENV_RETRY_MS = 30_000;
// Bug A: the Helper's first cold launch (large Node SEA + first-time Gatekeeper/notarization
// assessment) routinely exceeds the old 5s health budget; warm it is <1s. Give the cold path
// plenty of headroom.
const CUA_HELPER_HEALTH_TIMEOUT_MS = 30_000;
const CUA_PRODUCT_HELPER_SPAWN_READY_DEADLINE_MS = 1_000;

type DefaultCuaProductHelper = {
  host: ManagedCuaProductHelperHost;
  macPermissionHost?: CuaHelperHost;
  resolver: CuaProductMcpServerResolver;
  credentialGrantPublisher?: CuaCredentialGrantPublisher;
};

type ManagedDefaultCuaProductHelper = {
  helper: DefaultCuaProductHelper;
  seedContext?: CuaProductMcpServerResolverContext;
  credentialGrantPublisher: CuaCredentialGrantPublisher;
};

const cuaProductHelperAgentEnvRetryAt = new WeakMap<Pick<CuaHelperHost, "start">, number>();
const cuaProductHelperTrackedStart = new WeakMap<Pick<CuaHelperHost, "start">, Promise<unknown>>();
const cuaProductHelperReservedSpawns = new WeakSet<Pick<CuaHelperHost, "start">>();
const cuaProductHelperTransportSpawns = new WeakSet<Pick<CuaHelperHost, "start">>();

function trackCuaProductHelperStartup(
  host: Pick<CuaHelperHost, "start">,
  startup: Promise<unknown>,
): void {
  if (cuaProductHelperTrackedStart.get(host) === startup) return;
  cuaProductHelperTrackedStart.set(host, startup);
  void startup.then(
    () => {
      cuaProductHelperAgentEnvRetryAt.delete(host);
      cuaProductHelperReservedSpawns.delete(host);
      cuaProductHelperTransportSpawns.delete(host);
      if (cuaProductHelperTrackedStart.get(host) === startup) {
        cuaProductHelperTrackedStart.delete(host);
      }
    },
    () => {
      cuaProductHelperAgentEnvRetryAt.set(host, Date.now() + CUA_PRODUCT_HELPER_AGENT_ENV_RETRY_MS);
      if (cuaProductHelperReservedSpawns.delete(host)) {
        markCuaProductHelperAgentEnvUnavailable(host);
      }
      if (cuaProductHelperTransportSpawns.delete(host)) {
        markCuaProductHelperAgentEnvUnavailable(host);
      }
      if (cuaProductHelperTrackedStart.get(host) === startup) {
        cuaProductHelperTrackedStart.delete(host);
      }
    },
  );
}

function hasDisposeAll(instance: unknown): instance is ServiceWithDisposeAll {
  return (
    typeof instance === "object" &&
    instance !== null &&
    "disposeAll" in instance &&
    typeof (instance as { disposeAll?: unknown }).disposeAll === "function"
  );
}

function hasDisposeAllAndWait(instance: unknown): instance is ServiceWithDisposeAllAndWait {
  return (
    typeof instance === "object" &&
    instance !== null &&
    typeof (instance as { disposeAllAndWait?: unknown }).disposeAllAndWait === "function"
  );
}

interface ManagedCuaHelperHostDispose {
  stop(): Promise<void>;
}

// 默认 Computer Use Helper 是长生命周期的独立 TCC 授权进程（持 broker socket + Accessibility/Screen Recording）。
// 它不是 IPC 服务，不进 ServiceCollection 的 disposeAll 列表，但 host 释放时必须显式终止它，否则会以
// 已授权主体常驻、甚至在 services 重建时再起一个 → 多实例/孤儿/权限主体泄漏。用与 ServiceCollection 绑定
// 的 WeakMap 侧表登记，dispose 时统一终止（best-effort，不阻断其它资源回收）。
const managedCuaHelperHosts = new WeakMap<ServiceCollection, ManagedCuaHelperHostDispose>();
const providerRuntimes = new WeakMap<ServiceCollection, ProviderRuntime>();
const codexModelSelectionServices = new WeakMap<ServiceCollection, IModelSelectionService>();

/** legacy Provider Runtime 自行 dispose；仅 Codex 适配服务需要额外汇总释放。 */
function disposeHostModelSelectionService(services: ServiceCollection): void {
  const service = codexModelSelectionServices.get(services);
  if (!service || service === providerRuntimes.get(services)?.modelSelection) return;
  (service as { dispose?: () => void }).dispose?.();
  codexModelSelectionServices.delete(services);
}
const providerProvisioningSources = new WeakMap<ServiceCollection, ProviderProvisioningSource>();
// messageStreamShowTodos 变更触发的活动 workspace runtime 重造订阅；随服务集合释放。
const settingsRuntimeRestartDisposers = new WeakMap<ServiceCollection, (() => void)[]>();
const providerProvisioningTriggerDisposers = new WeakMap<
  ServiceCollection,
  readonly (() => void)[]
>();
// 自动归档定时扫描器不是 IPC 服务，随 services 释放时停掉定时器与设置监听。
const taskAutoArchiveDisposers = new WeakMap<ServiceCollection, () => void>();
// TaskIndexRepo / OffPeakTaskRepo 等各自持有 tasks-index.sqlite 的连接句柄；
// dispose 链必须统一关闭：Windows 上句柄悬着会让宿主回收后临时目录 rm 撞 EBUSY
// （stdioDesktopPresentationSurface 单测稳定复现），Linux 的 unlink-while-open 语义掩盖了泄漏。
// 与其它侧表一样按 ServiceCollection 登记并在 dispose 时统一 close。
const sharedSqliteRepos = new WeakMap<ServiceCollection, ReadonlyArray<{ close(): void }>>();
const accountRequestAuthServices = new WeakMap<ServiceCollection, IAccountRequestAuthService>();
export type OffPeakRequestAuthBuilder = (ticketId: string) => Promise<{
  apiKey: string;
  headers: Record<string, string>;
  accountScope?: string;
}>;
const offPeakRequestAuthBuilders = new WeakMap<ServiceCollection, OffPeakRequestAuthBuilder>();

/** Local Host 进程内能力；不会随 ServiceCollection 暴露到通用 RPC Channel。 */
export function getAccountRequestAuthService(
  services: ServiceCollection,
): IAccountRequestAuthService | undefined {
  return accountRequestAuthServices.get(services);
}

/** Local Host 进程内的 Provisioning Source；不会把凭据通过通用 RPC 暴露给 Renderer。 */
export function getProviderProvisioningSource(
  services: ServiceCollection,
): ProviderProvisioningSource | undefined {
  return providerProvisioningSources.get(services);
}

/** Local Host 私有的闲时请求鉴权装配；复用正式 Registry/Account Access 解析，不进入 RPC。 */
export function getOffPeakRequestAuthBuilder(
  services: ServiceCollection,
): OffPeakRequestAuthBuilder | undefined {
  return offPeakRequestAuthBuilders.get(services);
}
const managedHostApiNetworkTransports = new WeakMap<ServiceCollection, HostApiNetworkTransport>();

export function registerManagedCuaHelperHostForDispose(
  services: ServiceCollection,
  host: ManagedCuaHelperHostDispose,
): void {
  managedCuaHelperHosts.set(services, host);
}

export function registerHostApiNetworkTransportForDispose(
  services: ServiceCollection,
  transport: HostApiNetworkTransport,
): void {
  managedHostApiNetworkTransports.set(services, transport);
}

export function shouldEnableDefaultCuaProductHelper(
  options: {
    platform?: NodeJS.Platform;
    env?: NodeJS.ProcessEnv;
  } = {},
): boolean {
  // 这里只判断打包资源/平台是否可用；workspace 启用 admission 由
  // isCuaEnabledForContext + shouldCreateDefaultCuaProductHelper 单点持有。复用 internal gate
  // 会让配置中已开启的正式插件因环境变量缺省而永远拿不到 Helper。
  const env = options.env ?? process.env;
  const explicit = env[CODEZ_CUA_PRODUCT_HELPER_ENV_KEY]?.trim().toLowerCase();
  if (explicit === "0" || explicit === "false" || explicit === "off") return false;
  const platform = options.platform ?? process.platform;
  return platform === "darwin" || platform === "linux" || platform === "win32";
}

/**
 * 是否在当前 host 创建默认 CUA product Helper。Computer Use Helper 只能由**桌面本地** authority 创建：
 * - desktop-attached-remote 与 standalone-server 都绝不自动创建，避免远端 workspace 在错误的
 *   host 上启动 Helper，破坏 shared-host attachment 与权限边界；
 * - 已显式注入 resolver 时不重复创建。
 * 平台/环境层面的启用与否另由 shouldEnableDefaultCuaProductHelper 决定。
 */
export function shouldCreateDefaultCuaProductHelper(opts: {
  serviceAuthorityMode?: ServiceAuthorityMode;
  hasRemoteWorkspaceIdentity?: boolean;
  hasInjectedResolver: boolean;
  hasBuiltInCuaPlugin: boolean;
}): boolean {
  return (
    opts.hasBuiltInCuaPlugin &&
    opts.serviceAuthorityMode === "desktop-local" &&
    !opts.hasRemoteWorkspaceIdentity &&
    !opts.hasInjectedResolver
  );
}

export function shouldUseCuaPermissionService(opts: {
  platform?: NodeJS.Platform;
  cuaEnabled: boolean;
}): boolean {
  const platform = opts.platform ?? process.platform;
  return (platform === "darwin" || platform === "win32") && opts.cuaEnabled;
}

export function shouldRetainDefaultCuaProductHelper(): boolean {
  // CUA 开关只门控后续 Agent admission；已创建的 Helper 只在 Host/App dispose 时停止。
  return true;
}

export function shouldEnableCuaOperationStateReporter(opts: {
  serviceAuthorityMode?: ServiceAuthorityMode;
  hasReporter: boolean;
}): boolean {
  // CUA 操作状态属于物理桌面投影；远端 workspace/server 不得把自己的 turn 投影到本机屏幕。
  return opts.hasReporter && opts.serviceAuthorityMode === "desktop-local";
}

export async function runCuaScreenCaptureReadinessProbe(
  host: Pick<CuaHelperHost, "queryScreenCaptureProbe">,
  screenRecording: "granted" | "denied" | "unknown",
  queryOptions?: CuaPermissionStatusQueryOptions,
): Promise<boolean> {
  if (!shouldRunCuaScreenCaptureProbe(screenRecording, queryOptions)) {
    return false;
  }
  try {
    return isScreenCaptureProbeSuccess(await host.queryScreenCaptureProbe());
  } catch {
    return false;
  }
}

/**
 * Screen Recording 的展示态取值：优先短命 Helper 读到的 TCC 真值，拿不到才沿用常驻 Helper 的报告。
 *
 * 为什么不能直接信常驻 Helper：macOS 撤销 Screen Recording 对**已运行进程**不生效 ——
 * 进程在退出前保留已获得的录屏能力，`CGPreflightScreenCaptureAccess()` 也继续返回撤销前的值。
 * 于是用户在系统设置里关掉授权后，常驻 broker Helper 会一直报 granted 直到它自己重启，
 * 设置页跟着显示「已授权」；而下一次 Helper 重启 CUA 就真的不可用了。
 * 授予方向同样陈旧：刚授权完常驻 Helper 仍可能报 denied。
 *
 * fail-open 是刻意的：预检失败（open 失败 / 超时 / 结果不合法）时沿用报告值，
 * 不比不做预检更糟。硬报 denied 会把已授权用户推进一次无意义的授权引导。
 */
export async function resolveCuaScreenRecordingState(
  host: Pick<CuaHelperHost, "queryScreenRecordingPreflight">,
  reported: "granted" | "denied" | "unknown",
): Promise<"granted" | "denied" | "unknown"> {
  // unknown 表示连 CGPreflight 符号都没拿到（macOS 10.15 前）。预检跑的是同一个 native 调用，
  // 换个进程也只会得到 unknown，不值得花一次 LaunchServices 冷启。
  if (reported === "unknown") return reported;
  try {
    return (await host.queryScreenRecordingPreflight()) ?? reported;
  } catch {
    return reported;
  }
}

export function createDynamicCuaProductMcpServerResolver(options: {
  isPluginEnabled: (context?: CuaProductMcpServerResolverContext) => boolean;
  getResolver: (
    context?: CuaProductMcpServerResolverContext,
  ) => CuaProductMcpServerResolver | undefined | Promise<CuaProductMcpServerResolver | undefined>;
  isResolverCurrent?: (
    resolver: CuaProductMcpServerResolver,
    context?: CuaProductMcpServerResolverContext,
  ) => boolean;
}): CuaProductMcpServerResolver {
  return {
    async resolveMcpServers(servers, context) {
      if (!options.isPluginEnabled(context)) return servers;
      const resolver = await options.getResolver(context);
      if (!resolver) return servers;
      const resolved = await resolver.resolveMcpServers(servers, context);
      // delegate 可能跨过 Helper start/health await；dispose 在等待中置 terminal 时，不能把旧代际
      // 刚注入的 socket/token 交给晚到 Agent。移除 CUA candidate，保持其它 MCP 原样。
      return options.isResolverCurrent?.(resolver, context) === false
        ? servers?.filter((server) => !isPotentialCodezCuaAgentMcpServer(server))
        : resolved;
    },
    async restart() {
      // 委托到底层真实 resolver（由 ICuaPermissionService.restartHelper 经此调用）。
      const resolver = await options.getResolver();
      if (!resolver) {
        throw new Error("Codez Computer Use is not enabled (plugin off or not product mode).");
      }
      await resolver.restart();
    },
    async restartAfterPermissionGrant(onboardingSessionId) {
      // 授权完成后的 restart 必须保留 session id，才能复用底层的幂等与时序保障。
      const resolver = await options.getResolver();
      if (!resolver) {
        throw new Error("Codez Computer Use is not enabled (plugin off or not product mode).");
      }
      await resolver.restartAfterPermissionGrant(onboardingSessionId);
    },
  };
}

let orphanHelperReaperHasRun = false;

type CreateDefaultCuaProductHelperOptions = {
  // 转发给 resolver，restart 前用来判断是否有活跃 turn（见 cuaProductMcpResolver.ts）。
  // desktop-local agent service 会提供真实的 CUA turn 状态；其他调用方没有该状态时才回退为 false。
  hasActiveTurn?: () => boolean;
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  resourcesPath?: string;
  arch?: NodeJS.Architecture;
  electronVersion?: string;
  resolveNodeRuntime?: () => Promise<CuaNodeRuntime>;
  resolveWindowsRuntime?: () => Promise<WindowsCuaRuntime>;
  createMacHost?: () => CuaHelperHost;
  createNodeHost?: (runtime: CuaNodeRuntime) => ManagedCuaProductHelperHost;
  createWindowsHost?: (runtime: WindowsCuaRuntime) => ManagedCuaProductHelperHost;
};

/**
 * Windows/Linux Helper 宿主的懒解析包装：把「解析安装包运行时」推迟到首次 start()/checkHealth()，
 * 并把解析结果缓存（含 rejection）。
 *
 * resolveWindowsCuaRuntime 可能因 missing-native-addon、artifact-integrity-mismatch、
 * incompatible-runtime-manifest 等原因失败。若只向调用方抛错而没有诊断记录，设置页的
 * 「未加载」状态无法说明具体原因。因此在这里记录一条带 reason 的
 * error 日志，且因为 rejection 被缓存、日志挂在同一条 promise 链上，重复 start() 不会刷屏。
 * 载荷只有 reason/artifact/errorName/message：解析发生在 mint token 与命名管道之前，天然不含密钥。
 */
export function createCuaNodeHelperHost(options: {
  resolveRuntime: () => Promise<WindowsCuaRuntime>;
  createHost: (runtime: WindowsCuaRuntime) => ManagedCuaProductHelperHost;
  logger?: ServiceLogger;
}): ManagedCuaProductHelperHost {
  let host: ManagedCuaProductHelperHost | undefined;
  let resolving: Promise<ManagedCuaProductHelperHost> | undefined;
  let stopped = false;
  let lifecycleEpoch = 0;
  let stopDrain: Promise<void> | undefined;
  const logResolutionFailure = (error: unknown): void => {
    if (!options.logger) return;
    const resolutionError =
      error instanceof WindowsCuaDevRuntimeResolutionError ? error : undefined;
    const artifact = resolutionError?.artifact;
    options.logger.error(undefined, "CUA Node Helper runtime resolution failed", {
      reason: resolutionError?.reason ?? "unknown",
      ...(artifact ? { artifact } : {}),
      errorName: error instanceof Error ? error.name : typeof error,
      message: error instanceof Error ? error.message : String(error),
    });
  };
  const assertActive = (epoch: number): void => {
    if (stopped || epoch !== lifecycleEpoch) {
      throw new Error("Computer Use Helper startup stopped");
    }
  };
  const getHost = async (epoch: number): Promise<ManagedCuaProductHelperHost> => {
    assertActive(epoch);
    if (host) return host;
    resolving ??= options
      .resolveRuntime()
      // catch 只包住 resolveRuntime 本身：下面 then 里的 assertActive 抛出是 stop() 竞态，不是解析失败，
      // 不能混进同一条诊断日志。
      .catch((error: unknown) => {
        logResolutionFailure(error);
        throw error;
      })
      .then((runtime) => {
        // stop() 会同步推进 epoch。运行时解析完成后必须再次检查，防止 dispose 返回后才构造并启动孤儿 Helper。
        assertActive(epoch);
        const nextHost = options.createHost(runtime);
        assertActive(epoch);
        host = nextHost;
        return nextHost;
      });
    const resolvedHost = await resolving;
    assertActive(epoch);
    return resolvedHost;
  };
  const withActiveHost = async <T>(
    operation: (activeHost: ManagedCuaProductHelperHost) => Promise<T>,
  ): Promise<T> => {
    const epoch = lifecycleEpoch;
    const activeHost = await getHost(epoch);
    assertActive(epoch);
    return operation(activeHost);
  };
  return {
    get running() {
      return host?.running ?? false;
    },
    get socketPath() {
      return host?.socketPath ?? null;
    },
    get pipSocketPath() {
      return host?.pipSocketPath ?? null;
    },
    get pluginAuthority() {
      return host?.pluginAuthority ?? null;
    },
    get generation() {
      return host?.generation;
    },
    async start() {
      return withActiveHost((activeHost) => activeHost.start());
    },
    async checkHealth(timeoutMs?: number) {
      return withActiveHost((activeHost) => activeHost.checkHealth(timeoutMs));
    },
    async waitForTransport(timeoutMs?: number) {
      return withActiveHost((activeHost) => {
        if (!activeHost.waitForTransport) {
          // 兼容旧注入 Host：没有两阶段接口时，完整 start handle 就是唯一可用 tuple。
          return activeHost.start().then((handle) => ({
            socketPath: handle.socketPath,
            pipSocketPath: handle.pipSocketPath,
            pluginAuthority: handle.pluginAuthority,
            generation: handle.generation,
          }));
        }
        return activeHost.waitForTransport(timeoutMs);
      });
    },
    async restart() {
      return withActiveHost((activeHost) => activeHost.restart());
    },
    async restartAfterCurrentStart() {
      return withActiveHost((activeHost) => activeHost.restartAfterCurrentStart());
    },
    async restartAfterCurrentStartPreservingTransport(
      restartOptions?: CuaHelperTransportRestartOptions,
    ): Promise<CuaHelperTransportRestartResult> {
      return withActiveHost((activeHost) => {
        if (activeHost.restartAfterCurrentStartPreservingTransport) {
          return activeHost.restartAfterCurrentStartPreservingTransport(restartOptions);
        }
        // 兼容旧注入 Host：wrapper 一旦暴露 preserving 接口，就必须代为提交 fresh-start
        // marker；否则开放 Helper 会在新 tuple 已启动后判定 fail-closed 契约被破坏。
        restartOptions?.beforeFreshStart?.();
        return activeHost.restartAfterCurrentStart().then((handle) => ({ handle, reused: false }));
      });
    },
    async stop() {
      if (stopDrain) return stopDrain;
      stopped = true;
      lifecycleEpoch += 1;
      const pendingResolution = resolving;
      stopDrain = (async () => {
        // 等待已开始的解析落定，确保它观察到 terminal epoch；否则 dispose 之后仍可能晚到地启动 Helper。
        await pendingResolution?.catch(() => undefined);
        await host?.stop();
      })();
      return stopDrain;
    },
  };
}

/** Compatibility wrapper for existing Windows-only callers. */
export function createWindowsCuaHelperHost(
  options: Parameters<typeof createCuaNodeHelperHost>[0],
): ManagedCuaProductHelperHost {
  return createCuaNodeHelperHost(options);
}

export function createDefaultCuaProductHelper(
  options: CreateDefaultCuaProductHelperOptions,
): DefaultCuaProductHelper | undefined {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  if (!shouldEnableDefaultCuaProductHelper({ platform, env })) {
    return undefined;
  }
  const logger = createServiceLogger("cua-product-helper");
  // Best-effort, once per process: reap Helpers orphaned by prior sessions before minting a
  // fresh one. Complements the per-Helper launcher-pid watchdog (helperMain); the reaper never
  // throws, so it cannot block startup.
  if (platform === "darwin" && !orphanHelperReaperHasRun) {
    orphanHelperReaperHasRun = true;
    reapOrphanedHelpers({ logger, env });
  }
  let macPermissionHost: CuaHelperHost | undefined;
  let host: ManagedCuaProductHelperHost;
  if (platform === "darwin") {
    const bundledHelperAppPath = resolveBundledCuaHelperAppPath();
    if (!bundledHelperAppPath) {
      logger.error(
        undefined,
        "CUA product Helper is unavailable: packaged Resources path was not resolved",
      );
      return undefined;
    }
    macPermissionHost =
      options.createMacHost?.() ??
      createProductCuaHelperHost({
        logger,
        // 根因：使用全局 process.env 会让 host 与本次 Local Host 的冻结环境分叉，
        // 预检/安装器可能因此选择另一套开发或产品策略。
        env,
        helperInstaller: createCanonicalCuaHelperInstaller({
          logger,
          env,
          bundledAppPath: bundledHelperAppPath,
        }),
        // 冲突解决原则：macOS 继续严格消费应用内置 Helper，不能退回下载源；
        // Windows 才走下方独立的安装包 runtime 解析链路。
        bundledHelperAppPath,
        // tolerate the Helper's cold first-launch instead of the 5s default.
        healthTimeoutMs: CUA_HELPER_HEALTH_TIMEOUT_MS,
        // 根因：本地 unsigned dev 模式下，ad-hoc 签名的 Helper 没有 Developer ID TeamIdentifier，
        // 通过 LaunchServices (/usr/bin/open) 冷启的独立进程无法继承宿主进程已获得的 TCC 录屏授权，
        // 会永远返回 denied 并把常驻 Helper 真实的 ScreenCaptureKit 截图成功状态覆盖掉。
        queryScreenRecordingPreflight: isCuaLocalDevelopmentRuntime(env)
          ? undefined
          : queryHelperScreenRecordingPreflightViaLaunchServices,
        // 开放 Helper 的产品策略在本仓固定为启用 PiP、禁用后台控制；调用方不再传伪动态
        // getter，避免 services 与 Helper runtime 各保存一份策略。
      });
    host = macPermissionHost;
  } else {
    host = createCuaNodeHelperHost({
      resolveRuntime:
        options.resolveNodeRuntime ??
        (platform === "win32" ? options.resolveWindowsRuntime : undefined) ??
        (() =>
          resolveCuaNodeRuntime({
            platform,
            env,
            resourcesPath: options.resourcesPath,
            arch: options.arch,
            electronVersion: options.electronVersion,
          })),
      createHost:
        options.createNodeHost ??
        (platform === "win32" ? options.createWindowsHost : undefined) ??
        ((runtime) =>
          new WindowsCuaHelperHost({
            runtime,
            logger,
          })),
      logger,
    });
  }
  const resolver = createCuaProductMcpServerResolver(host, {
    hasActiveTurn: options.hasActiveTurn,
  });
  return {
    host,
    ...(macPermissionHost ? { macPermissionHost } : {}),
    resolver,
  };
}

export const CODEZ_CUA_BUNDLED_HELPER_APP_PATH_ENV = "CODEZ_CUA_BUNDLED_HELPER_APP_PATH";

export function resolveBundledCuaHelperAppPath(
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const injectedPath = env[CODEZ_CUA_BUNDLED_HELPER_APP_PATH_ENV]?.trim();
  if (injectedPath) {
    return injectedPath;
  }
  const resourcesPath = (
    process as NodeJS.Process & { resourcesPath?: string }
  ).resourcesPath?.trim();
  return resourcesPath ? join(resourcesPath, "cua-helper", HELPER_APP_NAME) : undefined;
}

export { isOfficialCuaPluginEnabledForWorkspace };

export function hasGlobalCliCodezCuaServer(env: NodeJS.ProcessEnv = process.env): boolean {
  const home = env.HOME?.trim() || homedir();
  const configPath = join(home, ".codez", "cli", "config.json");
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(configPath, "utf8"));
  } catch {
    return false;
  }
  if (!isRecord(parsed)) return false;
  if (isRecord(parsed.features) && parsed.features.mcp === false) return false;
  if (!isRecord(parsed.mcp) || !isRecord(parsed.mcp.servers)) return false;
  return Object.entries(parsed.mcp.servers).some(([name, config]) =>
    isGlobalCliCodezCuaServer(name, config),
  );
}

function isGlobalCliCodezCuaServer(name: string, config: unknown): boolean {
  if (!isRecord(config)) return false;
  if (config.enabled === false) return false;
  if (typeof config.type === "string" && config.type !== "stdio") return false;
  if (name === "computer-use") return true;
  // 与 desktop/services resolver 和 CLI bootstrap 共用 @codez/shared 的单一事实源，避免第三处
  // 判定漂移：git/.git/本地路径形态的 codez-cua 若这里漏判，全局 CLI env 注入不会带 broker
  // socket/token，agent 会回退成 Python/uvx 自己持有 macOS TCC（违反 product broker 边界）。
  if (typeof config.command === "string" && isCodezCuaMcpCommand(config.command)) {
    return true;
  }
  return (
    Array.isArray(config.args) &&
    config.args.some((arg) => typeof arg === "string" && isCodezCuaMcpPackageArg(arg))
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function buildCuaBrokerCredentialEnv(
  transport: Pick<CuaHelperTransportHandle, "socketPath" | "pluginAuthority" | "generation">,
): Record<string, string> {
  return {
    [BROKER_SOCKET_ENV]: transport.socketPath,
    [CODEZ_CUA_PLUGIN_AUTHORITY_ENV_KEY]: transport.pluginAuthority,
    [BROKER_GENERATION_ENV]: String(transport.generation ?? 0),
  };
}

export async function buildCuaProductHelperAgentEnv(
  host:
    | (Pick<CuaHelperHost, "start"> &
        Partial<
          Pick<CuaHelperHost, "running" | "checkHealth" | "reservedTransport"> & {
            waitForTransport(timeoutMs?: number): Promise<CuaHelperTransportHandle>;
          }
        >)
    | undefined,
  logger = createServiceLogger("cua-product-helper"),
): Promise<Record<string, string>> {
  if (!host) return {};
  if (hasCuaProductHelperAgentEnvUnavailable(host)) {
    if (host.running && host.checkHealth) {
      try {
        await host.checkHealth(CUA_PRODUCT_HELPER_SPAWN_READY_DEADLINE_MS);
        clearCuaProductHelperAgentEnvUnavailable(host);
      } catch {
        // helper 仍在恢复（冷启动 / 轮换在途）——不阻塞，交给下一次 demand boundary。
      }
    }
    if (hasCuaProductHelperAgentEnvUnavailable(host)) {
      return {
        [BROKER_UNAVAILABLE_ENV]:
          "broker_unavailable: recovered Helper credentials are waiting for a future spawn",
      };
    }
  }
  const retryAt = cuaProductHelperAgentEnvRetryAt.get(host);
  try {
    if (host.running && host.checkHealth) {
      await host.checkHealth(1000);
      cuaProductHelperAgentEnvRetryAt.delete(host);
      if (hasCuaProductHelperAgentEnvUnavailable(host)) {
        return {
          [BROKER_UNAVAILABLE_ENV]:
            "broker_unavailable: recovered Helper credentials are waiting for a future spawn",
        };
      }
    } else if (retryAt && Date.now() < retryAt) {
      return {
        [BROKER_UNAVAILABLE_ENV]: "broker_unavailable: helper startup retry is deferred",
      };
    }
    const startup = host.start();
    trackCuaProductHelperStartup(host, startup);
    if (host.waitForTransport) {
      const transport = await waitForCuaHelperStartup(
        host.waitForTransport(CUA_PRODUCT_HELPER_SPAWN_READY_DEADLINE_MS),
        CUA_PRODUCT_HELPER_SPAWN_READY_DEADLINE_MS,
      );
      if (hasCuaProductHelperAgentEnvUnavailable(host)) {
        return {
          [BROKER_UNAVAILABLE_ENV]:
            "broker_unavailable: recovered Helper credentials are waiting for a future spawn",
        };
      }
      cuaProductHelperTransportSpawns.add(host);
      cuaProductHelperAgentEnvRetryAt.delete(host);
      return buildCuaBrokerCredentialEnv(transport);
    }
    const reserved = host.reservedTransport;
    if (reserved && !hasCuaProductHelperAgentEnvUnavailable(host)) {
      cuaProductHelperReservedSpawns.add(host);
      cuaProductHelperAgentEnvRetryAt.delete(host);
      return buildCuaBrokerCredentialEnv(reserved);
    }
    const handle = await waitForCuaHelperStartup(
      startup,
      CUA_PRODUCT_HELPER_SPAWN_READY_DEADLINE_MS,
    );
    if (hasCuaProductHelperAgentEnvUnavailable(host)) {
      return {
        [BROKER_UNAVAILABLE_ENV]:
          "broker_unavailable: recovered Helper credentials are waiting for a future spawn",
      };
    }
    cuaProductHelperAgentEnvRetryAt.delete(host);
    return buildCuaBrokerCredentialEnv(handle);
  } catch (error) {
    const isCallerTimeout = isCuaHelperError(error) && error.code === "caller_timeout";
    if (isCallerTimeout) {
      const reserved = host.reservedTransport;
      if (reserved && !hasCuaProductHelperAgentEnvUnavailable(host)) {
        cuaProductHelperReservedSpawns.add(host);
        cuaProductHelperAgentEnvRetryAt.delete(host);
        return buildCuaBrokerCredentialEnv(reserved);
      }
    }
    markCuaProductHelperAgentEnvUnavailable(host);
    if (!isCallerTimeout) {
      cuaProductHelperAgentEnvRetryAt.set(host, Date.now() + CUA_PRODUCT_HELPER_AGENT_ENV_RETRY_MS);
    }
    logger.warn(
      undefined,
      `Computer Use Helper broker_unavailable; disabling workspace codez-cua MCP server for this agent spawn (${cuaHelperStartErrorDetail(error)})`,
    );
    return {
      [BROKER_UNAVAILABLE_ENV]: isCallerTimeout
        ? "broker_unavailable: helper broker warming up"
        : `broker_unavailable: ${cuaHelperStartErrorDetail(error)}`,
    };
  }
}

function cuaHelperStartErrorDetail(error: unknown): string {
  return isCuaHelperError(error)
    ? `${error.code}: ${error.message}`
    : error instanceof Error
      ? error.message
      : String(error);
}

/**
 * 创建包含所有本地服务的 ServiceCollection
 *
 * @param options.parentPort - Electron host process 的 parentPort，
 *        用于 BroadcastService 跨窗口中转。传 null 则广播为空操作。
 */
export function createLocalServices(options: {
  /** 已鉴权 Desktop stdio 连接提供的私有回查频道；不作为公共 service 暴露。 */
  topicResourceRelayChannel?: (request: unknown) => IChannel;
  parentPort?: Parameters<typeof createBroadcastService>[0];
  /** Desktop Window Host 提供当前 Source 身份和线路，其他宿主不推断 Desktop 状态。 */
  resolveBotRemoteWorkspace?: (target: {
    workspacePath: string;
    workspaceIdentity: string;
  }) => Promise<{ workspacePath: string; workspaceIdentity: string } | null>;
  /** Host 装配层注入的设置权威；与网络 transport 必须来自同一 Window Host 生命周期。 */
  settingService?: ISettingService;
  setWorkspaceProjection?: ReturnType<
    typeof createSettingServiceWithMigrations
  >["setWorkspaceProjection"];
  /** 与注入的本地 Setting 共用写队列；外部远端 Setting 不传，由其权威 Host 完成迁移。 */
  prepareLegacyAccountConnections?: ReturnType<
    typeof createSettingServiceWithMigrations
  >["prepareLegacyAccountConnections"];
  /** 注入后由 ServiceCollection 接管释放，并供 Host 其它 app-managed 下载复用。 */
  hostApiNetworkTransport?: HostApiNetworkTransport;
  /** Desktop Host 注入 Main 推送的实时界面语言，供 Codez endpoint 的 X-Client-Language；远端 server 不注入。 */
  resolveClientLanguage?: () => string | undefined;
  /** Desktop Host 请求 Main 登记 Agent 已授权的精确本地视频路径。 */
  authorizeLocalMediaPreviewPath?: (path: string) => Promise<string>;
  /**
   * 动态工作流用户选择变化后的转发口（docs/dynamic-workflow/launch.md「The user's choice」）：
   * Desktop Host 把本机设置里的选择推给本窗口所有在线的 desktop-attached remote Host。
   */
  forwardDynamicWorkflowUserMode?: (mode: DynamicWorkflowMode | undefined) => void;
  /** Desktop Host 请求 Main 登记已校验的插件 UI HTML，换取沙箱句柄。 */
  registerPluginSandbox?: (input: PluginSandboxRegisterInput) => Promise<PluginSandboxHandle>;
  feedback?: Partial<
    Omit<CreateFeedbackServiceOptions, "apiClient" | "credentialService" | "oauthService">
  >;
  reportPluginTelemetryEvent?: (
    event: import("@codez/shared").RendererTelemetryEventPayload,
  ) => void | Promise<void>;
  processLifecycleReporter?: RuntimeProcessLifecycleReporter;
  taskRuntimeReporter?: RuntimeTaskReporter;
  /** workspace 文件搜索默认使用内置过滤器；后续规则来源只需在 Host 装配时注入最终实现。 */
  workspaceFileSearchFilter?: WorkspaceFileSearchFilter;
  forwardSessionMessageSendRequested?: (
    request: SessionMessageSendRequested,
  ) => Promise<void> | void;
  /** desktop local host 在 manual run 落库后直接派发，不经过 scheduler 正常路径。 */
  onAutomationManualRunRequested?: (params: {
    automation: CodezAutomation;
    run: CodezAutomationRun;
  }) => Promise<void>;
  /** 闲时任务翻 schedulable 后请求宿主立即唤醒 scheduler（desktop host 注入 parentPort 转发）。 */
  onOffPeakSchedulerWakeRequested?: () => void;
  // 注入点：默认 resolver 已能覆盖 dev/桌面/SSH 远端三类形态；
  // 测试或特殊宿主想强制走自定义 binary/参数时从这里注入。
  codezAgentCommandResolver?: CodezAgentCommandResolver;
  /** Desktop Main 提前异步采集的本机 runtime 环境；Local Host 注入后不再同步启动 login shell。 */
  runtimeProcessEnvPatch?: Record<string, string>;
  /** Desktop Main 提供的稳定 Browser/CUA native MCP availability facts。 */
  nativeBrowserCua?: {
    browserAvailable: boolean;
    cuaAvailable: boolean;
  };
  /** Main 当前窗口授予的临时 MCP 清单；仅用于本地默认 Codex bridge。 */
  desktopCodexMcpServers?: import("@codez/shared").DesktopCodexMcpServer[];
  /**
   * 桌面浏览器 MCP 的运行时持有器（spec: codex-desktop-native-browser-cua「Global enable
   * toggle」）：Main 推送的清单/可用性事实会即时更新，优先于 InitLocal 快照；
   * resolveSpawnEnv 每次 spawn 现读，保证开关切换后下一次 spawn 不再使用旧注册。
   */
  desktopBrowserMcpStateSource?: () => {
    servers: readonly import("@codez/shared").DesktopCodexMcpServer[];
    nativeBrowserCua?: { browserAvailable: boolean; cuaAvailable: boolean };
  };
  /** 本地桌面上次 workspace 缺失时，仅用于 Agent 子进程 spawn.cwd 兜底。 */
  codezAgentSpawnFallbackCwd?: string;
  /** desktop-attached remote server 从 Desktop Host 收到的一次性 Agent 网络配置。 */
  remoteAgentNetwork?: {
    httpProxy?: string;
    noProxy?: string;
  };
  /** 所属 Environment 的 Codez Built-in Provider Config 物理路径。 */
  codezBuiltinProviderConfigFilePath: string;
  /** HTTP Server 只有在调用方明确配置认证时才暴露跨 Environment Provisioning target。 */
  providerProvisioningTargetEnabled?: boolean;
  /** R3 Source Server Core 等受桌面控制的远端守护进程，允许接收连接期内存临时 Key。 */
  ephemeralRuntimeKeysEnabled?: boolean;
  /** Desktop Host 私有通知；只在 Source 成功持久化后请求 Main 调度远端镜像。 */
  onProviderProvisioningSourceChanged?: (
    trigger: Exclude<ProviderProvisioningTrigger, "environment-online">,
  ) => void;
  serviceAuthorityMode?: ServiceAuthorityMode;
  /** 可信 Server Core 注入，区分物理持库 Host 与历史 workspace canonical route。 */
  projectStorageHostId?: string;
  sourceServerWorkspaceService?: ISourceServerWorkspaceService;
  resolveProjectHostService?: (hostId: string) => Promise<IProjectService>;
  /** Bot 复用窗口已有 Source 连接；不经 main 创建 workspace attachment。 */
  resolveBotProjectConnection?: (hostId: string) => BotProjectConnection | undefined;
  remoteProjectConnection?: Pick<
    Parameters<typeof createRemoteProjectService>[0],
    "connectHost" | "readConnectionStates"
  >;
  cuaProductMcpServerResolver?: CuaProductMcpServerResolver;
  createDefaultCuaProductHelper?: (
    options: CreateDefaultCuaProductHelperOptions,
  ) => DefaultCuaProductHelper | undefined;
  agentTelemetry?: {
    getDeviceMid?: () => string | undefined;
    runtimeSurface?: "desktop_local_host" | "remote_workspace_host";
  };
  /** browser-use 执行桥（host→main WebContentsView+CDP）；desktop host 注入，缺省则 browser 不可用。 */
  browserControlExecutor?: {
    list(input: {
      requestId: string;
      sessionId: string;
      turnId?: string;
      workspaceKey: string;
      workspacePath: string;
      workspaceIdentity?: string;
      remoteSessionId?: string;
      clientMode: BrowserClientMode;
      sessionContext: "live" | "cached";
    }): Promise<BrowserBackendDescriptor[]>;
    execute(input: {
      requestId: string;
      browserId?: string;
      browserGeneration?: number;
      sessionId: string;
      turnId?: string;
      workspaceKey: string;
      workspacePath: string;
      workspaceIdentity?: string;
      remoteSessionId?: string;
      clientMode: BrowserClientMode;
      sessionContext: "live" | "cached";
      command: BrowserCommand;
    }): Promise<{ ok: boolean; [k: string]: unknown }>;
  };
  /** Windows desktop-local Host 的 CUA turn 状态投影；其它 authority 会在装配层拒绝。 */
  cuaOperationStateReporter?: CuaOperationStateReporter;
}): ServiceCollection {
  const isDesktopAttachedRemote = options?.serviceAuthorityMode === "desktop-attached-remote";
  const acceptsRemoteEphemeralKeys =
    isDesktopAttachedRemote || options?.ephemeralRuntimeKeysEnabled === true;
  // 远端 relay：仅 desktop-attached-remote 装配；窗口 Host 经 RPC 授予/撤销能力，
  // 本地与独立 server 永远不创建（spec: codex-desktop-native-browser-cua「Remote workspace relay」）。
  const desktopBrowserRelay = isDesktopAttachedRemote
    ? createDesktopBrowserRelay({ dataDirectory: getCodezDataRootDir() })
    : undefined;
  // host / remote server 以前直接沿用当前进程环境启动后续服务。
  // GUI 启动的 desktop、SSH/WSL/Docker 拉起的 remote server 往往拿不到用户 login shell 里的 PATH，
  // 导致 bun 这类只在 shell profile 里追加的命令在 Codez Agent/终端里不可见。
  // 这里在所有本地服务启动前统一修正运行时环境，并顺带把内置 rg 注入 PATH，
  // 让 Codez Agent、终端、认证 runtime 共用同一套命令解析结果。
  initializeRuntimeProcessEnv(options?.runtimeProcessEnvPatch);

  const desktopContextPromptEnabledRaw =
    process.env[CODEZ_DESKTOP_CONTEXT_PROMPT_ENABLED_ENV]?.trim();
  const desktopContextPromptEnabled =
    desktopContextPromptEnabledRaw === "1"
      ? true
      : desktopContextPromptEnabledRaw === "0"
        ? false
        : undefined;
  const presentationSurface = resolveCodezAgentPresentationSurface({
    runtimeSurface: options?.agentTelemetry?.runtimeSurface,
    serviceAuthorityMode: options?.serviceAuthorityMode,
    desktopContextPromptEnabled,
  });
  const usesDefaultCodexDesktopBridge = usesCodexBridgeRuntime({
    desktopDefault: !isDesktopAttachedRemote && presentationSurface === "desktop",
    customCommandResolver: Boolean(
      options.codezAgentCommandResolver &&
      options.codezAgentCommandResolver !== resolveDefaultCodezAgentCommand,
    ),
  });
  const nativeBrowserCua = options?.nativeBrowserCua;

  // app 自签 CA：首次启动生成一份根 CA（幂等），供 agent 子进程经 NODE_EXTRA_CA_CERTS 信任、
  // 出口代理用其私钥重签。生成失败不应阻断启动（例如只读文件系统），仅记录日志后继续。
  try {
    ensureAppCaCert();
  } catch (error) {
    console.error(formatLogPrefix("appCaCert", process.pid), "ensure app CA cert failed:", error);
  }

  const localSettings = options?.settingService ? null : createSettingServiceWithMigrations();
  const settingService = createObservableSettingService(
    options?.settingService ?? localSettings!.service,
  );
  const resolveCurrentCodezEndpointOrigin = async () =>
    resolveRuntimeCodezEndpointOrigin(process.env, {
      overrideOrigin: (await settingService.get()).codezEndpointOrigin,
    });
  let invalidateProjectTokens = () => {};
  let invalidatePluginUiAccounts: (() => void) | undefined;
  const provisioningOAuthKeys = new Set<string>(PROVIDER_PROVISIONING_OAUTH_CREDENTIAL_KEYS);
  const credentialService = createCredentialService({
    onDidMutate: ({ key }) => {
      if (key === "oauth:active_provider" || /^oauth:[^:]+:user_info$/.test(key))
        invalidatePluginUiAccounts?.();
      if (provisioningOAuthKeys.has(key)) invalidateProjectTokens();
      if (provisioningOAuthKeys.has(key)) {
        options.onProviderProvisioningSourceChanged?.("credential");
      }
    },
  });
  // 临时模型 Key 由目标 Host 进程独占；Main、Renderer 和远端 Credential Store 均不持有。
  const installedRuntimeApiKeys = new Map<string, string>();
  // Codex 原生自定义供应商的本机临时 Key（spec: codex-provider-runtime-env-key）：
  // 远端 Host 只保存 Window Host 逐连接安装到内存的 envName→value；断线/进程退出即消失。
  // rotationActive 期间全部托管供应商 fail-closed，直到 install 携带最新事实解除。
  const installedCodexNativeKeys = new Map<string, { providerId: string; value: string | null }>();
  let codexNativeKeyRotationActive = false;
  const accountProviderCredentialStore = createAccountProviderCredentialStore({
    credentialService,
  });
  const broadcastService = createBroadcastService(options?.parentPort ?? null);
  const gitCheckpointService = createGitCheckpointService();
  const hostApiNetworkTransport =
    options?.hostApiNetworkTransport ??
    createHostApiNetworkTransport(async () => {
      const settings = await settingService.get();
      return {
        httpProxy: settings.httpProxy,
        noProxy: settings.httpProxyNoProxy,
        caCertPath: settings.httpProxyCaCertPath,
      };
    });
  const codezJwtLogoutHandlerRef: {
    current: ((input: string | URL, headers: Headers) => void) | null;
  } = { current: null };
  const apiClient = createNodeApiClient({
    fetchImpl: hostApiNetworkTransport.fetch,
    onZcodeJwtInvalid: (input, headers) => codezJwtLogoutHandlerRef.current?.(input, headers),
    isZcodeJwtRequest: (input, headers) =>
      isCurrentOAuthCredentialRequest({ input, headers, credentialService }),
    isBusinessUnauthorizedRequest: (input, _headers) =>
      isOAuthBusinessRequest({ input, credentialService }),
    resolveBusinessCredentialValidationRequest: (input, headers) =>
      resolveOAuthBusinessCredentialValidationRequest({ input, headers, credentialService }),
    resolveCodezEndpointOrigin: resolveCurrentCodezEndpointOrigin,
    resolveClientLanguage: options?.resolveClientLanguage,
  });
  const systemService = createSystemService({
    agentRuntimeMode: usesDefaultCodexDesktopBridge ? "codex" : "legacy",
  });
  // onboarding 资格与任务列表共用同一份全局 tasks-index；repo 懒加载数据库，提前构造不会
  // 增加启动 I/O，后续 session syncer 也继续复用这一实例。
  const taskIndexRepo = new TaskIndexRepo(undefined, options?.projectStorageHostId);
  // onboarding 完成记录：userId 由登录态补全（apikey/未登录为 null），见 docs/onboarding-record-spec.md。
  const onboardingEvidenceLogger = createServiceLogger("onboardingRecordService");
  const onboardingRecordService = createOnboardingRecordService({
    loadUserId: async () => (await oauthCredentialRepo.loadActiveUserProfile())?.id ?? null,
    // 老用户使用证据不能只查 tasks-index：索引是 session 同步器的衍生投影，同步器在
    // agent/provider 就绪后才回填，而判定在登录完成、主界面挂载时执行，早于回填——
    // 2026-10 线上误弹：索引重建后登录瞬间判定看到空索引，老用户被当成新用户弹出引导
    // （取证：判定时刻全部历史任务行还在 WAL 未落库）。会话库与旧版快照目录是磁盘级
    // 持久事实，与同步时序无关；includeDeleted 让清空过任务列表的存量用户也不失去
    // 资格。会话证据必须查 cli/db/db.sqlite 的 session 表（评审 CR-01：cli/sessions
    // 是工作流输出目录，且文件存在性不代表有会话）。
    hasExistingLocalTask: createHasExistingLocalTask({
      listIndexTasks: () => taskIndexRepo.listTaskMetas({ includeDeleted: true }),
      // 解析结果 null（相对路径/project 覆盖等无法镜像的配置）→ 跳过会话证据源，
      // 继续旧版快照检查；不得猜默认路径，否则自定义会话库的存量用户被漏判。
      // 跳过/命中各留一条 debug（评审 SG-02）：判定每登录一次至多一条，线上复核
      // "走了哪个证据源"有据可依；不记录完整路径，避免 home 路径进日志。
      hasAgentSessionRow: async () => {
        const sessionDbPath = await resolveAgentSessionDbPath();
        if (sessionDbPath === null) {
          onboardingEvidenceLogger.debug(
            "onboarding 会话证据源跳过：会话库路径不可镜像（相对路径或 project 级覆盖）",
          );
          return false;
        }
        const hasRow = await hasAnyAgentSessionRow(sessionDbPath);
        onboardingEvidenceLogger.debug("onboarding 会话证据源已查询", { hasRow });
        return hasRow;
      },
      resolveLegacyTaskSessionsDir: () => join(resolveAppConfigDir(), "sessions"),
    }),
  });
  let handleOAuthProviderLogout: ReturnType<typeof createOAuthProviderLogoutHandler> | null = null;
  const oauthCredentialRepo = new OAuthCredentialRepo(credentialService, {
    onCorruptOAuthSessionCleared: async (providers) => {
      // telemetry 之外的后台路径可能先读到损坏 OAuth 凭据。
      // 这类恢复也必须等价于 logout，复用同一 handler 清理派生模型 provider key。
      // 账号刷新 resolver 也可能读到损坏 token；等待下一轮刷新会让当前轮循环等待自身。
      // OAuth 删除已经完成，派生刷新交回原 Account Source 队列，后台只观察失败。
      void Promise.all(
        providers.map((provider) => handleOAuthProviderLogout?.(provider) ?? Promise.resolve()),
      ).catch((error: unknown) => {
        createServiceLogger("oauth-credential-recovery").warn(
          "refresh derived providers after corrupt OAuth cleanup failed",
          { error },
        );
      });
    },
  });
  const projectTokenClient = createAccountProjectTokenClient(apiClient, credentialService);
  invalidateProjectTokens = () => projectTokenClient.clear();
  const accountProviderApiKeyRemoteClient = new AccountProviderApiClient(apiClient);
  const accountProviderApiKeyResolver = new AccountProviderApiKeyResolver(
    accountProviderApiKeyRemoteClient.fetchRemoteData.bind(accountProviderApiKeyRemoteClient),
    projectTokenClient,
  );
  const accountProviderCredentialService = createAccountProviderCredentialService({
    async loadOAuthAccessToken(family) {
      const oauthProviderId = family === "zai" ? ZAI_PROVIDER_ID : BIGMODEL_PROVIDER_ID;
      return (await oauthCredentialRepo.loadTokenSet(oauthProviderId))?.accessToken ?? null;
    },
    resolveProviderMaterial: (
      family,
      accessToken,
      accountIdentity,
      rejectedProjectTokenFingerprint,
    ) =>
      accountProviderApiKeyResolver.resolveProviderMaterial(
        family === "zai" ? ZAI_PROVIDER_ID : BIGMODEL_PROVIDER_ID,
        accessToken,
        accountIdentity,
        rejectedProjectTokenFingerprint,
      ),
  });
  const resolveLegacyTeamOrganization = createLegacyTeamOrganizationResolver({
    apiClient,
    loadOAuthTokenSet: (family) =>
      oauthCredentialRepo.loadTokenSet(family === "zai" ? ZAI_PROVIDER_ID : BIGMODEL_PROVIDER_ID),
  });
  const readAccountProviderSettings = async () => {
    // 迁移只在账号事实入口协调。ApiClient 的代理/端点仍读普通 Setting，不递归等待迁移。
    // 外部注入的 Setting（远端 attachment）由其所属 Host 管理，不读取本机旧文件。
    const prepare =
      options?.prepareLegacyAccountConnections ?? localSettings?.prepareLegacyAccountConnections;
    const unresolvedFamilies = (await prepare?.(resolveLegacyTeamOrganization)) ?? [];
    const settings = await settingService.get();
    return {
      providerFamilyDomain: settings.providerFamilyDomain ?? null,
      selections: settings.providerFamilyConnectionSelections ?? {},
      unresolvedFamilies,
    };
  };
  const loadAccountIdentity = async (family: ProviderFamilyDomain) => {
    const oauthProviderId = family === "zai" ? ZAI_PROVIDER_ID : BIGMODEL_PROVIDER_ID;
    return (await oauthCredentialRepo.loadUserProfile(oauthProviderId))?.id ?? null;
  };
  const accountRequestAuthService = createAccountRequestAuthService(
    createAccountProviderRequestAuthService({
      resolveCurrentAccountAccess: (access) =>
        resolveCurrentAccountAccess({
          access,
          readSettings: readAccountProviderSettings,
          loadAccountIdentity,
        }),
      loadOAuthTokenSet: (providerId) => oauthCredentialRepo.loadTokenSet(providerId),
      async loadIndividualPlanMaterial(providerId, family, rejectedProjectTokenFingerprint) {
        const oauthProviderId = family === "zai" ? ZAI_PROVIDER_ID : BIGMODEL_PROVIDER_ID;
        const accountIdentity = (await oauthCredentialRepo.loadUserProfile(oauthProviderId))?.id;
        if (!accountIdentity) return null;
        return accountProviderCredentialService.loadCodingPlanMaterial({
          providerId,
          family,
          accountIdentity,
          rejectedProjectTokenFingerprint,
        });
      },
      resolveTeamPlanMaterial: async (access, rejectedProjectTokenFingerprint) => {
        const accountIdentity = await loadAccountIdentity(access.family);
        if (!accountIdentity) return null;
        return resolveAccountTeamPlanRuntimeMaterial({
          apiClient,
          credentialService,
          access,
          accountIdentity,
          tokenClient: projectTokenClient,
          rejectedProjectTokenFingerprint,
        });
      },
    }),
  );
  const providerConfigLog = createServiceLogger("provider-config");
  const clientConfigPlatform = resolveClientConfigPlatform();
  const providerConfigRuntime = createProviderConfigRuntime({
    codezBuiltinFilePath: options.codezBuiltinProviderConfigFilePath,
    codezBuiltinEnvironment: {
      environmentConfigRoot: resolveAppConfigDir(),
      platform: clientConfigPlatform,
      appVersion: CODEZ_VERSION,
      resolveEndpointOrigin: resolveCurrentCodezEndpointOrigin,
      onRefreshResult: (event) => {
        if (event.result === "updated")
          providerConfigLog.info(undefined, "Codez Built-in CDN 配置已更新", event);
        else providerConfigLog.debug(undefined, "Codez Built-in 刷新检查", event);
      },
      fetchRelease: (endpointOrigin, signal) =>
        fetchCodezBuiltinRemoteRelease({
          apiClient,
          endpointOrigin,
          signal,
          appVersion: CODEZ_VERSION,
          platform: clientConfigPlatform,
        }),
    },
    onCodezBuiltinRefreshError: (error) => {
      providerConfigLog.warn(undefined, "Codez Built-in Config 远端刷新失败", {
        error,
      });
    },
    onPersonalConfigRecovery: (event) => {
      providerConfigLog.warn(
        undefined,
        "Personal Provider Config 加载失败，已保留磁盘状态并以内存空配置降级",
        {
          error: event.error,
        },
      );
    },
    onPersonalConfigPollingError: (error) => {
      // 轮询错误只在进入失败状态时回调一次；下一轮仍会自行重试，避免持续故障刷盘。
      providerConfigLog.warn(undefined, "Personal Provider Config 轮询暂时失败，将继续重试", {
        error,
      });
    },
    // 已发布 config.json 保存的是 Codez 用户配置；清理第三方 ACP 不能移除这条升级路径。
    // Repository 仅在新 Personal 配置不存在时导入，并保留旧文件以便回滚。
    readLegacyProviders: () => readLegacyCodezConfigProviders(),
  });
  const accountProviderConfigSource = createAccountProviderConfigSource({
    configSource: providerConfigRuntime.configService,
    readSettings: readAccountProviderSettings,
    async loadCodingPlanApiKey(providerId, family, accountIdentity, forceRefresh) {
      if (isStartPlanModelProviderId(providerId)) return null;
      return accountProviderCredentialService.loadCodingPlanApiKey({
        providerId,
        family,
        accountIdentity,
        forceRefresh,
      });
    },
    loadAccountIdentity,
    resolveFamilyAvailability: createCodingPlanFamilyAvailabilityResolver({
      apiClient,
      credentialService,
    }),
  });
  const accountProviderRuntimeLog = createServiceLogger("account-provider-runtime");
  const modelSelectionConfiguredDefaultSource = new NodeModelSelectionConfigRepository({
    personalRepository: providerConfigRuntime.personalRepository,
  });
  const providerProvisioningSource = createProviderProvisioningSource({
    personalRepository: providerConfigRuntime.personalRepository,
    settingService,
    credentialFilePath: resolveCredentialFilePath(resolveAppConfigDir()),
    personalConfigFilePath: join(resolveAppConfigDir(), PERSONAL_PROVIDER_CONFIG_FILE_NAME),
    credentialService,
  });
  const providerProvisioningDisposers = [
    () => installedRuntimeApiKeys.clear(),
    providerConfigRuntime.configService.onDidChange((reason) => {
      // 每个 Window Host 都会轮询同一文件；只把本进程成功提交的 updated
      // 作为同步触发，避免其它 Host 的 poll-changed 把一次保存重复计入多个代际。
      if (reason === "personal:updated") {
        options.onProviderProvisioningSourceChanged?.("personal-config");
      }
    }),
    settingService.onDidUpdate((event) => {
      if (
        event.keys.includes("providerFamilyDomain") ||
        event.keys.includes("providerFamilyConnectionSelections")
      ) {
        options.onProviderProvisioningSourceChanged?.("account-settings");
      }
    }),
  ];
  const disposeAccountProviderInvalidation = bindAccountProviderInvalidation({
    onDidUpdateSetting: (listener) => settingService.onDidUpdate(listener),
    refresh: (reason) => accountProviderConfigSource.refresh(reason),
  });
  const accountProviderRefreshErrorDispose = accountProviderConfigSource.onDidRefreshError(
    (event) => {
      accountProviderRuntimeLog.warn(undefined, "account provider source refresh failed", {
        error: event.error,
        reasons: event.reasons,
      });
    },
  );
  let providerConnectivityAgentService:
    | Pick<ICodezAgentService, "testModelConnectivity">
    | undefined;
  const providerRuntime = createProviderRuntimeFromConfigRuntime({
    configRuntime: providerConfigRuntime,
    accountSource: accountProviderConfigSource,
    modelSelectionConfiguredDefaultSource,
    disposeModelSelectionConfiguredDefaultSource: () =>
      modelSelectionConfiguredDefaultSource.dispose(),
    testConnectivity: createProviderSettingsConnectivityTester({
      testModelConnectivity: async (input) => {
        if (!providerConnectivityAgentService) {
          throw new Error("Agent Service 尚未完成模型连通性测试装配");
        }
        return providerConnectivityAgentService.testModelConnectivity(input);
      },
    }),
    disposeAccountSource: () => {
      disposeAccountProviderInvalidation();
      accountProviderRefreshErrorDispose();
      accountProviderConfigSource.dispose();
    },
  });
  const providerSettingsService: IProviderSettingsService = {
    ...providerRuntime.providerSettings,
    deletePersonalProvider: async (providerId) => {
      if (isDesktopAttachedRemote) {
        return providerRuntime.providerSettings.deletePersonalProvider(providerId);
      }
      const key = providerRuntimeApiKeyCredentialKey(providerId);
      const previous = await credentialService.load(key);
      if (previous !== null) await credentialService.delete(key);
      try {
        return await providerRuntime.providerSettings.deletePersonalProvider(providerId);
      } catch (error) {
        if (previous !== null) await credentialService.save(key, previous);
        throw error;
      }
    },
    saveApiKeySource: async (input) => {
      if (isDesktopAttachedRemote || usesDefaultCodexDesktopBridge) {
        throw new Error("当前 Environment 不支持本机临时 API Key 保存");
      }
      await codezAgentService.disposeActiveWorkspaceRuntimes({
        reason: "provider-key-source-change",
        includeLegacy: true,
      });
      return saveProviderApiKeySource(
        {
          providerSettings: providerRuntime.providerSettings,
          credentials: credentialService,
        },
        input,
      );
    },
  };
  handleOAuthProviderLogout = createOAuthProviderLogoutHandler({
    accountProviderCredentialStore,
    refreshAccountProviders: (reason: string) => accountProviderConfigSource.refresh(reason),
  });
  const sourceServerWorkspaceService =
    options.sourceServerWorkspaceService ?? createSourceServerWorkspaceService();
  // 官方 Server MCP 的凭证解析源。MCP 调用的身份头与 MCP 额度查询（/api/v1/mcp/usage）
  // 必须共用这一份实现，否则两处对"当前选中的 Coding Plan 连接"的判定会分叉。
  // 额度侧注入的是凭证解析而非 resolveHeaders：归属校验需要 providerFamily，
  // 而身份头里没有 family；身份头仍由同一个 buildOfficialMcpAuthHeaders 构造。
  const officialMcpCredentialSource = {
    resolve: () =>
      resolveOfficialMcpCredentials({
        accountRequestAuthService,
        credentialService,
        modelSelectionService: providerRuntime.modelSelection,
      }),
  };
  // mcpSync/hooks 里引用 codezAgentService 的闭包是惰性调用，声明顺序不影响初始化。
  const skillsService = createSkillsService({ isDesktopRuntime: true });
  const mcpSyncService = createMcpSyncService({
    // mcp/list 的 host 消费点收拢到 mcpSync 服务；真实状态检查仍在 agent 进程。
    listMcpServerStatuses: (params) => codezAgentService.listMcpServerStatuses(params),
  });
  const pluginSyncService = createPluginSyncService();
  const pluginUiAccounts = createPluginUiAccountBindings({
    async readAccount() {
      const provider = await oauthCredentialRepo.loadActiveProvider();
      const profile = provider ? await oauthCredentialRepo.loadUserProfile(provider) : null;
      return [provider, profile?.id ?? null];
    },
    open: (params) => codezAgentService.openMcpUiInstance(params),
    close: (params) => codezAgentService.closeMcpUiInstance(params),
  });
  invalidatePluginUiAccounts = () => pluginUiAccounts.invalidate();
  const pluginUiBridgeService = createPluginUiBridgeService({
    reportTelemetryEvent: options?.reportPluginTelemetryEvent,
    openInstance: (params) => pluginUiAccounts.open(params),
    closeInstance: (params) => pluginUiAccounts.close(params),
    validateInstance: (params) => codezAgentService.validateMcpUiInstance(params),
    recycleInstance: (params) => codezAgentService.recycleMcpUiInstance(params),
    // 插件 UI：资源读取与 UI 工具调用都发生在 session 所在的 agent 进程；host 只做校验与登记。
    readMcpResource: (params) => codezAgentService.readMcpResource(params),
    callMcpToolForUi: (params) => codezAgentService.callMcpToolForUi(params),
    cancelMcpToolCallForUi: (params) => codezAgentService.cancelMcpToolCallForUi(params),
    readMcpResourceForUi: (params) => codezAgentService.readMcpResourceForUi(params),
    listMcpResourcesForUi: (params) => codezAgentService.listMcpResourcesForUi(params),
    listMcpResourceTemplatesForUi: (params) =>
      codezAgentService.listMcpResourceTemplatesForUi(params),
    subscribeMcpResourceForUi: (params) => codezAgentService.subscribeMcpResourceForUi(params),
    unsubscribeMcpResourceForUi: (params) => codezAgentService.unsubscribeMcpResourceForUi(params),
    listPluginUiSurfaces: (params) => codezAgentService.listPluginUiSurfaces(params),
    registerSandbox: options?.registerPluginSandbox,
  });
  // App-Provided Tools：页面工具登记与模型调用的认领 / 回传都发生在 session 所在的 agent 进程。
  const pluginUiSamplingService = createPluginUiSamplingService({
    sample: (params) => codezAgentService.sampleMcpApp(params),
    cancelSampling: (params) => codezAgentService.cancelMcpAppSampling(params),
  });
  const pluginUiAppToolsService = createPluginUiAppToolsService({
    registerAppToolsForUi: (params) => codezAgentService.registerAppToolsForUi(params),
    unregisterAppToolsForUi: (params) => codezAgentService.unregisterAppToolsForUi(params),
    claimAppToolCallForUi: (params) => codezAgentService.claimAppToolCallForUi(params),
    resolveAppToolCallForUi: (params) => codezAgentService.resolveAppToolCallForUi(params),
  });
  const subagentsService = createSubagentsService({
    isDesktopRuntime: true,
  });
  const commandsService = createCommandsService({ isDesktopRuntime: true });
  const hooksService = createHooksService({
    grantWorkspaceHookTrust: (params) => codezAgentService.grantWorkspaceHookTrust(params),
  });
  const memoryService = createMemoryService();
  // 只要当前进程已经装配 Provider Runtime，就由该 Environment 自己的 Selection View
  // 决定执行就绪状态。Desktop-attached remote 也读取远端自己的 Config/Account Facts。
  const modelSelectionReadinessSource = providerRuntime.modelSelection;
  const agentAccountProviderConfigSource = accountProviderConfigSource;
  // ===== Computer Use Helper lifecycle 层（port 自 feat）=====
  const cuaProductHelperWorkspaceRegistry = new CuaProductHelperWorkspaceRegistry();
  // P1-a mitigation：createDefaultCuaProductHelper() 在 codezAgentService 存在之前就要组装 resolver，
  // 但"是否有活跃 turn"这个信号只有 codezAgentService 建好之后才能查询。用前向引用占位——resolver 真正
  // 调用 hasActiveTurn() 发生在后续某次 resolveMcpServers（异步），那时 hasActiveTurnRef 早已被赋值。
  // 先用前向引用连接 agent service 的 CUA turn tracker，避免在活跃 CUA 请求中途重启 Helper；
  // service 创建完成后再赋值。Helper recovery 始终不能回收 Agent。
  let hasActiveTurnRef: (() => boolean) | undefined;
  const isCuaEnabledForContext = (context?: CuaProductMcpServerResolverContext): boolean =>
    // internal feature 只为开发路径 bypass 持久化配置；正式产品由官方插件 workspace
    // enablement 决定。插件 discovery 始终保留，不再把缺省关闭误作“插件不存在”。
    isCodezCuaInternalFeatureEnabled(process.env) ||
    isOfficialCuaPluginEnabledForWorkspace({
      env: process.env,
      workingDirectory: context?.workspacePath,
    });
  const defaultCuaProductHelperLifecycle =
    new CuaHelperLifecycleManager<ManagedDefaultCuaProductHelper>(async (managed) => {
      const publisher = managed.credentialGrantPublisher;
      if (publisher) {
        // 先置 dispose fence，阻止晚到的 cold-start 在 Helper stop 后写入授权。
        await publisher.dispose();
      }
      await managed.helper.host.stop();
    });
  const createManagedDefaultCuaProductHelper = (
    context?: CuaProductMcpServerResolverContext,
  ): Promise<ManagedDefaultCuaProductHelper | undefined> => {
    const helper = (options?.createDefaultCuaProductHelper ?? createDefaultCuaProductHelper)({
      // 转发活跃-turn 查询（前向引用，codezAgentService 建好后赋值）。
      hasActiveTurn: () => hasActiveTurnRef?.() ?? false,
    });
    if (!helper) return Promise.resolve(undefined);
    const logger = createServiceLogger("cua-product-helper");
    return createCuaCredentialGrantPublisher({
      grantRootDirectory: resolveCuaCredentialGrantRootDirectory(resolveAppConfigDir()),
      logger,
    }).then((credentialGrantPublisher) => {
      attachCuaCredentialGrantPublisher(helper.host, credentialGrantPublisher);
      helper.credentialGrantPublisher = credentialGrantPublisher;

      // 历史默认装配启动 10 秒周期 watchdog；空闲期一次 broker_info 超时就会在后台
      // 调用 resolver.restart()。Helper 不是 Agent runtime owner，且无需在没有 CUA 需求时自愈；
      // 健康检查保留在 spawn env / resolver request boundary，避免后台 timer 干扰其他模块。
      return {
        helper,
        credentialGrantPublisher,
        ...(context ? { seedContext: context } : {}),
      };
    });
  };
  const getOrCreateDefaultCuaProductHelper = async (
    context?: CuaProductMcpServerResolverContext,
  ): Promise<DefaultCuaProductHelper | undefined> => {
    const managed = await defaultCuaProductHelperLifecycle.acquire({
      isAdmitted: () =>
        shouldCreateDefaultCuaProductHelper({
          serviceAuthorityMode: options?.serviceAuthorityMode,
          hasRemoteWorkspaceIdentity: Boolean(context?.workspaceIdentity?.trim()),
          hasInjectedResolver: Boolean(options?.cuaProductMcpServerResolver),
          hasBuiltInCuaPlugin: isCuaEnabledForContext(context),
        }),
      shouldRetainCurrent: shouldRetainDefaultCuaProductHelper,
      create: () => createManagedDefaultCuaProductHelper(context),
    });
    return managed?.helper;
  };
  const isDefaultCuaProductHelperCurrent = (helper: DefaultCuaProductHelper): boolean =>
    defaultCuaProductHelperLifecycle.peek()?.helper === helper;

  // enabled 与 onCuaPipSessionLifecycle 是否挂上，都由 serviceAuthorityMode 单点决定；
  // 提出来命名，避免下面的启动期诊断与真实取值漂移。
  const cuaPipSessionEnabled =
    process.platform === "darwin" && options?.serviceAuthorityMode === "desktop-local";
  const cuaPipSessionService = createCuaPipSessionService({
    enabled: cuaPipSessionEnabled,
    resolveCredentials: async () => {
      const helper = defaultCuaProductHelperLifecycle.peek()?.helper;
      if (!helper || !isDefaultCuaProductHelperCurrent(helper)) return undefined;
      const host = helper.host;
      const transport =
        host.running && host.pipSocketPath && host.pluginAuthority
          ? {
              pipSocketPath: host.pipSocketPath,
              pluginAuthority: host.pluginAuthority,
              generation: host.generation,
            }
          : host.reservedTransport;
      if (
        !transport?.pipSocketPath ||
        !transport.pluginAuthority ||
        !Number.isSafeInteger(transport.generation) ||
        (transport.generation ?? -1) < 0
      ) {
        return undefined;
      }
      return {
        pipSocketPath: transport.pipSocketPath,
        capability: transport.pluginAuthority,
        generation: transport.generation!,
      };
    },
  });
  // 启动期就把 PiP 投递链的接线状态写出来。dev 实测 PiP 事件一条都没投，而
  // 「enabled=false」与「lifecycle 回调没挂（tracker 整体 undefined、accept 全程 no-op）」
  // 这两种成因在运行期都不产生任何日志，只能靠这行在启动时分辨——重启即可判定，
  // 不必先跑一轮 CUA。scope 沿用 cua-pip-session：已验证该 logger 的 info 会进宿主日志。
  createServiceLogger("cua-pip-session").info(undefined, "[cua-pip-session] wiring resolved", {
    enabled: cuaPipSessionEnabled,
    platform: process.platform,
    serviceAuthorityMode: options?.serviceAuthorityMode ?? null,
    lifecycleWired: options?.serviceAuthorityMode === "desktop-local",
  });
  // Computer Use Helper macOS 权限状态服务：renderer 经 host RPC 查询当前 Helper 的运行态与权限，并在
  // 用户授权后从明确入口精确重启一次 Helper。重启**必须走 resolver.restart()**（不是裸 host.restart），
  // 因为 resolver 优先复用既有 socket/token；裸 host.restart() 可能 fresh 新凭据，使已有 Agent
  // 继续持有旧 transport，无法连接新的 broker。
  const cuaPermissionService: ICuaPermissionService = {
    async getStatus(
      workspacePath: string,
      workspaceIdentity?: string,
      queryOptions?: CuaPermissionStatusQueryOptions,
    ): Promise<CuaPermissionStatusResult> {
      if (process.platform !== "darwin" && process.platform !== "win32") {
        return {
          available: false,
          reason: "CUA permissions are only available on macOS and Windows.",
        };
      }
      const context = workspacePath ? { workspacePath, workspaceIdentity } : undefined;
      // 插件关闭只门控后续 Agent；权限页刷新不得进入 acquire，否则会把仍被已有 Agent 使用的 Helper 停掉。
      if (
        !shouldUseCuaPermissionService({
          cuaEnabled: isCuaEnabledForContext(context),
        })
      ) {
        return {
          available: false,
          reason: "Codez Computer Use is not enabled (plugin off or not product mode).",
        };
      }
      // 权限页与 Agent 必须消费同一个受管 Host tuple；旧 standalone 分支会分别铸造
      // socket/capability，既无法认证也无法被生命周期 owner 回收。
      try {
        // acquire/create 里的 Helper 启动失败（如 Gatekeeper 拒杀）也要落到 catch，
        // 才能把 errorKind 带给 UI；过去它在 try 外抛出，被上层吞成笼统不可用。
        const helper = await getOrCreateDefaultCuaProductHelper(context);
        const host = helper?.macPermissionHost;
        if (!helper || !host || !isDefaultCuaProductHelperCurrent(helper)) {
          return {
            available: false,
            reason: "Codez Computer Use Helper is unavailable.",
          };
        }
        const report = await host.queryPermissionStatus();
        if (!helper || !isDefaultCuaProductHelperCurrent(helper)) {
          return {
            available: false,
            reason: "Codez Computer Use lifecycle is disposed.",
          };
        }
        // Screen Recording 的真值必须来自一个新进程：撤销对已运行的常驻 Helper 不生效，
        // 它会一直报撤销前的 granted。拿不到真值时 fail-open 沿用 report 值。
        const screenRecording = await resolveCuaScreenRecordingState(host, report.screen_recording);
        if (!isDefaultCuaProductHelperCurrent(helper)) {
          return {
            available: false,
            reason: "Codez Computer Use lifecycle is disposed.",
          };
        }
        // 真实 screen-capture 探针：TCC screen_recording === "granted" 只说明系统记录了授权，并不保证
        // WindowServer 已对本进程放行像素（wallpaper-frame / SR-not-live 背离）。只有真的抓到非空像素
        // 才算 screen 端到端可用——UI 的"就绪/自动关闭"据此判定。fail-closed：探测抛错/超时一律 false。
        // 用预检后的 state 做门控：预检已判 denied 时没有必要再花一次抓屏。
        const screenCaptureProbeOk = await runCuaScreenCaptureReadinessProbe(
          host,
          screenRecording,
          queryOptions,
        );
        if (!isDefaultCuaProductHelperCurrent(helper)) {
          return {
            available: false,
            reason: "Codez Computer Use lifecycle is disposed.",
          };
        }
        const reportedOwnerDisplayName =
          typeof report.owner?.display_name === "string" ? report.owner.display_name : undefined;
        return {
          grantOwner: report.grant_owner,
          grantOwnerDisplayName: reportedOwnerDisplayName ?? report.grant_owner,
          accessibility: report.accessibility,
          accessibilityProbeOk:
            (report as { accessibility_probe_ok?: boolean }).accessibility_probe_ok === true ||
            (report.accessibility_probe?.ok === true &&
              report.accessibility_probe?.classification === "functional"),
          screenRecording,
          screenCaptureProbeOk,
        };
      } catch (error) {
        const errorKind = resolveCuaPermissionUnavailableErrorKind(error);
        return {
          available: false,
          reason: `Could not read Computer Use Helper permission status: ${
            error instanceof Error ? error.message : String(error)
          }`,
          ...(errorKind ? { errorKind } : {}),
        };
      }
    },
    async restartHelper(
      workspacePath: string,
      workspaceIdentity?: string,
      restartOptions?: CuaPermissionRestartOptions,
    ): Promise<CuaPermissionRestartResult> {
      if (process.platform !== "darwin") {
        return {
          ok: false,
          reason: "CUA permissions are only available on macOS.",
        };
      }
      const context = workspacePath ? { workspacePath, workspaceIdentity } : undefined;
      // 与 getStatus 一致：插件关闭时不触碰现有 Helper，避免设置页动作改变已有 Agent runtime。
      if (
        !shouldUseCuaPermissionService({
          cuaEnabled: isCuaEnabledForContext(context),
        })
      ) {
        return {
          ok: false,
          reason: "Codez Computer Use is not enabled (plugin off or not product mode).",
        };
      }
      // 走 resolver.restart()，让 host 尽可能复用 transport；不得通过 disposeWorkspace
      // 重建正在运行的 Agent。
      const helper = await getOrCreateDefaultCuaProductHelper(context);
      const resolver =
        helper && helper.macPermissionHost && isDefaultCuaProductHelperCurrent(helper)
          ? helper.resolver
          : undefined;
      if (!resolver) {
        return {
          ok: false,
          reason: "Codez Computer Use is not enabled (plugin off or not product mode).",
        };
      }
      try {
        if (restartOptions?.reason === "permission_granted") {
          await resolver.restartAfterPermissionGrant(restartOptions.onboardingSessionId);
        } else {
          await resolver.restart();
        }
        if (!helper || !isDefaultCuaProductHelperCurrent(helper)) {
          return {
            ok: false,
            reason: "Codez Computer Use lifecycle is disposed.",
          };
        }
        return { ok: true };
      } catch (error) {
        return {
          ok: false,
          reason: `Failed to restart Codez Computer Use: ${
            error instanceof Error ? error.message : String(error)
          }`,
        };
      }
    },
  };
  // 动态工作流的用户选择（docs/dynamic-workflow/launch.md「The user's choice」）：本机设置文件是唯一来源，
  // 每次使用时读取。desktop-attached remote Host 读不到桌面的设置，选择由 desktop 推送
  // （codezAgentService.syncDynamicWorkflowUserMode），这里不注入。读取失败按「跟随」处理。
  const resolveDynamicWorkflowUserMode = isDesktopAttachedRemote
    ? undefined
    : async () => (await settingService.get()).dynamicWorkflowMode;
  const codingPlanSubscriptionService = createCodingPlanSubscriptionService({
    apiClient,
    credentialService,
    ...(resolveDynamicWorkflowUserMode ? { resolveDynamicWorkflowUserMode } : {}),
    resolveOffPeakModelSelectionView: async () => {
      await providerRuntime.start();
      return buildOffPeakModelSelectionView(providerRuntime.registryService.getView());
    },
  });
  // OffPeakTaskService 单例在下方 DI register IIFE 中创建（晚于 agent service）；
  // 用前向引用 holder 惰性绑定——offPeak/create 协议请求只会发生在服务集合装配完成后。
  let offPeakTaskServiceForAgent: OffPeakTaskService | undefined;
  // desktop-attached-remote 装配不暴露 Off-Peak 工具面（远程不在支持范围）。
  const offPeakToolWiring =
    usesDefaultCodexDesktopBridge || options?.serviceAuthorityMode === "desktop-attached-remote"
      ? {}
      : {
          resolveOffPeakClientConfig: () => codingPlanSubscriptionService.getOffPeakClientConfig(),
          resolveOffPeakTaskService: () => offPeakTaskServiceForAgent,
        };
  const setWorkspaceProjection =
    options?.setWorkspaceProjection ?? localSettings?.setWorkspaceProjection;
  setWorkspaceProjection?.(async (settings) => {
    const db = await taskIndexRepo.getOrganizationDatabase();
    const repository = await taskIndexRepo.getProjectRepository();
    db.exec("BEGIN");
    try {
      const directory =
        !options?.projectStorageHostId || options.projectStorageHostId === "local"
          ? readRemoteProjectDirectory(db)
          : { hosts: [], entries: [] };
      const projection = projectWorkspaceSettings(
        repository.readTree({ includeTasks: false }).projects,
        directory,
        settings,
      );
      db.exec("COMMIT");
      return projection;
    } catch (error) {
      if (db.isTransaction) db.exec("ROLLBACK");
      throw error;
    }
  });
  const publishProjectChange = async () => {
    // SQLite 已提交；旧字段只能在设置 owner 的锁内从最新目录派生。
    if (setWorkspaceProjection) await settingService.update({});
    await broadcastService.send({ channel: "state:projects", payload: {} });
  };
  const remoteProjectService = createRemoteProjectService({
    ...options?.remoteProjectConnection,
    controller: !options?.projectStorageHostId || options.projectStorageHostId === "local",
    database: () => taskIndexRepo.getOrganizationDatabase(),
    afterChange: publishProjectChange,
  });
  const codexGlobalRolloutSyncer =
    usesDefaultCodexDesktopBridge && !isDesktopAttachedRemote
      ? createCodexGlobalRolloutSyncer({
          taskIndexRepo,
          resolveWorkspaceIdentity:
            options?.projectStorageHostId && options.projectStorageHostId !== "local"
              ? async (workspacePath) =>
                  (await sourceServerWorkspaceService.resolveWorkspace({ workspacePath }))
                    .canonicalWorkspaceKey
              : undefined,
          afterChange: publishProjectChange,
          // 解析事实缓存放在 Codez 数据目录：重启后未变化的历史 rollout 不再重复 head/tail 解析。
          scanCacheFilePath: getCodexRolloutScanCachePath(),
        })
      : null;
  const projectService = createProjectService({
    directories: {
      home: async () => (await systemService.info()).homedir,
      read: (params) => fileService.readdir(params),
    },
    ownerHostId: options?.projectStorageHostId,
    resolveHost: options?.resolveProjectHostService,
    repository: async () => {
      await codexGlobalRolloutSyncer?.syncNow();
      return taskIndexRepo.getProjectRepository();
    },
    workspaceDirectory: join(projectDataRoot(), "workspace"),
    afterChange: publishProjectChange,
  });
  const taskGroupService = createTaskGroupService({
    database: () => taskIndexRepo.getOrganizationDatabase(),
    resolveTasks: async (refs) => {
      // 只读所属 Host 的权威目录；项目路由不会为分组建立连接或启动 Agent。
      const hostIds = [...new Set(refs.map((task) => task.hostId))];
      const results = await Promise.all(
        hostIds.map(async (hostId) => {
          const tree = await projectService.readTree({ hostId, includeDeletedTasks: true });
          const facts = new Map(
            [
              ...tree.tasks,
              ...(tree.deletedTasks ?? []).map((task) => ({ ...task, deleted: true })),
            ].map((task) => [groupTaskKey(task), task]),
          );
          return refs
            .filter((ref) => ref.hostId === hostId)
            .flatMap((ref) => {
              const fact = facts.get(groupTaskKey(ref));
              return fact && fact.hostId === ref.hostId && fact.workspacePath === ref.workspacePath
                ? [{ ...fact, ...ref }]
                : [];
            });
        }),
      );
      return results.flat();
    },
    afterChange: () => broadcastService.send({ channel: "state:task-groups", payload: {} }),
  });
  const prepareProjectExecution = async (projectId: string) => ({
    ...(await projectService.prepareSession({ projectId })),
    hostId: options?.projectStorageHostId ?? "local",
    workspaceIdentity: undefined,
  });
  // ConversationShareService 需要已创建的 Agent service，而 Codex 命令需要 Host 授权的
  // shared-context reader。这个 forward holder 只在服务集合装配完成后被绑定；装配期命令
  // 不可能到达，未绑定时 fail closed。
  let conversationShareContentCopyReader:
    | IConversationShareService["readSharedContextContentCopy"]
    | undefined;
  const codezAgentService = createCodezAgentService({
    prepareProjectExecution,
    nativeProjectHostId: options?.projectStorageHostId ?? "local",
    prepareSessionCreation: async (target) =>
      (await taskIndexRepo.getProjectRepository()).reserveCreatedTask({
        task: { ...target, taskId: target.sessionId },
        projectId: target.projectId,
        additionalDirectories: target.additionalDirectories,
      }).additionalDirectories,
    resolveSessionDirectories: async (target) => {
      const directories = await projectService.resolveSessionDirectories({
        ...target,
        taskId: target.sessionId,
      });
      // 原因：从单目录视图打开外部 Codex A+B 会话时，NULL 归属的 [] 不代表
      // 用户要求缩权；省略原生 resume 覆盖才能恢复 Codex 自己持久化的 roots。
      return usesDefaultCodexDesktopBridge && directories.projectId === null
        ? undefined
        : directories.additionalDirectories;
    },
    resolveSessionProjectId: async (target) =>
      (await projectService.resolveSessionDirectories({ ...target, taskId: target.sessionId }))
        .projectId,
    safeDesktopFileRewindOwner: usesDefaultCodexDesktopBridge && !isDesktopAttachedRemote,
    ...(agentAccountProviderConfigSource
      ? { accountProviderConfigSource: agentAccountProviderConfigSource }
      : {}),
    accountRequestAuthService,
    ...(modelSelectionReadinessSource ? { modelSelectionReadinessSource } : {}),
    // desktop-attached-remote 的 ConversationShare reader 是 unsupported wrapper；
    // 注入“函数存在”会让能力投影误报 degraded。只在真实授权 reader 所在的
    // Desktop-local/legacy assembly 提供该 owner fact。
    ...(isDesktopAttachedRemote
      ? {}
      : {
          readSharedContextContentCopy: (input) => {
            if (!conversationShareContentCopyReader) {
              throw new SharedContextContentCopyError(
                "capability_missing",
                "Codex shared-context content copy is unavailable",
              );
            }
            return conversationShareContentCopyReader(input);
          },
          supportsSharedContextContentCopy: true as const,
        }),
    authorizeLocalMediaPreviewPath: options?.authorizeLocalMediaPreviewPath,
    ...offPeakToolWiring,
    // 动态工作流灰度：与 Off-Peak 不同，
    // 这里不按 serviceAuthorityMode 裁剪——SSH/WSL/Docker 的 desktop-attached-remote Host
    // 是它自己那些 workspace 的唯一裁决者，灰度开启时远程 workspace 同样提供工作流。
    resolveDynamicWorkflowClientConfig: usesDefaultCodexDesktopBridge
      ? undefined
      : () => codingPlanSubscriptionService.getDynamicWorkflowClientConfig(),
    ...(resolveDynamicWorkflowUserMode ? { resolveDynamicWorkflowUserMode } : {}),
    forwardDynamicWorkflowUserMode: options?.forwardDynamicWorkflowUserMode,
    commandResolver: options?.codezAgentCommandResolver,
    presentationSurface,
    onAutomationManualRunRequested: options?.onAutomationManualRunRequested,
    // createLocalServices 虽然暴露了 reporter 注入点，旧装配却没有继续传给
    // CodezAgentProcessManager，导致 host 永远不向 main 上报 Agent spawn/exit，进程监控器
    // 因而看不到实际运行的 Agent，也无法验证只读到可写升级是否复用同一进程。
    processLifecycleReporter: options?.processLifecycleReporter,
    spawnFallbackCwd: options?.codezAgentSpawnFallbackCwd,
    // browser-use：host→main 执行桥透传给 agent service 的 onRequest browserExecute 路由。
    browserControlExecutor: options?.browserControlExecutor,
    // 机器人凭据只归属于授权 Host；远端独立服务不能借用本机配置扩大读取范围。
    channelReplyExecutor: async (value) => {
      const request = channelReplyHostRequestSchema.parse(value);
      if (
        options?.topicResourceRelayChannel &&
        (isDesktopAttachedRemote || request.remoteSessionId)
      )
        return channelReplyResultSchema.parse(
          await options.topicResourceRelayChannel(request).call("reply", request),
        );
      if (isDesktopAttachedRemote) throw new Error("Desktop channel reply peer unavailable");
      const bots = services.getOptional(IBotsService);
      if (!bots?.replyToChannel) throw new Error("Bot channel reply unavailable");
      return bots.replyToChannel(request);
    },
    topicResourceExecutor: async (request, signal) => {
      if (
        options?.topicResourceRelayChannel &&
        (isDesktopAttachedRemote || request.remoteSessionId)
      )
        return readTopicResourceFromRelay(
          options.topicResourceRelayChannel(request),
          request,
          signal,
        );
      if (isDesktopAttachedRemote) throw new Error("Desktop topic resource peer unavailable");
      const bots = services.getOptional(IBotsService);
      if (!bots?.readTopicResource) throw new Error("Topic resource service is unavailable");
      return bots.readTopicResource({ ...request, signal });
    },
    topicResourceValidator: async (request, signal) => {
      if (
        options?.topicResourceRelayChannel &&
        (isDesktopAttachedRemote || request.remoteSessionId)
      )
        return validateTopicResourceFromRelay(
          options.topicResourceRelayChannel(request),
          request,
          signal,
        );
      if (isDesktopAttachedRemote) throw new Error("Desktop topic resource peer unavailable");
      const bots = services.getOptional(IBotsService);
      if (!bots?.validateTopicResource)
        throw new Error("Topic resource authorization is unavailable");
      return bots.validateTopicResource({ ...request, signal });
    },
    ...(desktopBrowserRelay ? { desktopBrowserRelay } : {}),
    // 官方 Server MCP 身份头：host 是唯一身份权威，Agent 经反向请求索取。
    // Provider 存在性读取正式 Model Selection View；不恢复旧 Provider Snapshot。
    officialMcpAuthHeadersResolver: createOfficialMcpAuthHeadersResolver({
      accountRequestAuthService,
      credentialService,
      modelSelectionService: providerRuntime.modelSelection,
    }),
    // host 是身份权威边界：provenance/origin 必须在这里再校验一次，不能只依赖 agent
    // adapter 的 fetch wrapper。判定实现与 CLI 侧共用 @codez/shared 的同一份，避免分叉。
    // origin 解析复用 resolveCurrentCodezEndpointOrigin——与闲时任务同口径（含 settings
    // 覆盖），否则会出现"闲时任务能连、官方 MCP 连不上"。
    // dev 开关必须同样传入，否则本地自测会被 host 单方面拒绝。
    officialMcpTrustedOrigins: createOfficialMcpTrustedOriginRegistry({
      devTrustedOriginsRaw: process.env[OFFICIAL_MCP_DEV_TRUSTED_ORIGINS_ENV],
      resolveCodezApiOrigin: resolveCurrentCodezEndpointOrigin,
    }),
    cuaOperationStateReporter: shouldEnableCuaOperationStateReporter({
      serviceAuthorityMode: options?.serviceAuthorityMode,
      hasReporter: Boolean(options?.cuaOperationStateReporter),
    })
      ? options?.cuaOperationStateReporter
      : undefined,
    // Codez 只发布 turn/session 事实；面板 terminal policy 由 producer coordinator 决定。
    ...(options?.serviceAuthorityMode === "desktop-local"
      ? {
          onCuaPipSessionLifecycle: (_workspace, event) => {
            void cuaPipSessionService.publishLifecycle(event);
          },
        }
      : {}),
    // 设置页的 HTTP 代理、No Proxy + 自定义 CA 按 spawn 时读取注入 agent 子进程 env，
    // 覆盖模型 API / MCP / Bash 出口流量并信任用户显式配置的证书；改动后下次启动 agent 生效。
    resolveSpawnEnv: async (context) => {
      const [settings] = await Promise.all([
        settingService.get(),
        usesDefaultCodexDesktopBridge ? Promise.resolve() : providerRuntime.start(),
      ]);
      const agentNetwork =
        isDesktopAttachedRemote && options?.remoteAgentNetwork
          ? options.remoteAgentNetwork
          : {
              httpProxy: settings.httpProxy,
              noProxy: settings.httpProxyNoProxy,
            };
      const networkEnv = buildAgentRuntimeEnv({
        httpProxy: agentNetwork.httpProxy,
        noProxy: agentNetwork.noProxy,
        caCertPath: settings.httpProxyCaCertPath,
      });
      // 远端 workspace 身份或非本地 Host 绝不拉起或暴露本机 CUA Helper。
      const isRemoteWorkspaceContext =
        isDesktopAttachedRemote ||
        options?.serviceAuthorityMode !== "desktop-local" ||
        Boolean(
          context?.workspaceIdentity?.trim() &&
          (context.workspaceIdentity.trim() !== context.workspacePath?.trim() ||
            isRemoteWorkspaceIdentity(context.workspaceIdentity.trim())),
        );
      // 与 helper 创建同一个门控（isCuaEnabledForContext：dev/internal 特性 OR 官方插件 enablement），
      // 避免 dev mode 下 helper 建了但 resolveSpawnEnv 漏注入 broker env 的割裂。
      const cuaPluginEnabled = !isRemoteWorkspaceContext && isCuaEnabledForContext(context);
      // 所有平台都先取得 Local Host 的单一 owner；macOS 旧分支在没有 host 时自行铸造
      // socket/capability，却没有对应 launcher，runtime 会永久缓存一组无人监听的凭据。
      const peekedHelper = defaultCuaProductHelperLifecycle.peek()?.helper;
      const helper = !cuaPluginEnabled
        ? undefined
        : peekedHelper && isDefaultCuaProductHelperCurrent(peekedHelper)
          ? peekedHelper
          : await getOrCreateDefaultCuaProductHelper(context);
      // setting.get / 生命周期队列都可能跨过 host dispose。仅凭调用前的 enabled 会让延迟恢复的
      // resolveSpawnEnv 在 terminal fence 后重新启动 Helper；必须在真正构造 env 前校验代际。
      const cuaProductHelperHost =
        helper && isDefaultCuaProductHelperCurrent(helper) ? helper.host : undefined;
      // 等待 Helper 启动前登记。Registry 只记录尝试过 admission 的 workspace，
      // 供后续配置/生命周期 bookkeeping 使用；recovery 只清理 marker，不回收已有 Agent。
      cuaProductHelperWorkspaceRegistry.setEnabled(context, Boolean(cuaProductHelperHost));
      let cuaProductHelperEnv: Record<string, string> = {};
      if (cuaProductHelperHost && helper) {
        const candidateEnv = await buildCuaProductHelperAgentEnv(
          cuaProductHelperHost,
          createServiceLogger("cua-product-helper"),
        );
        if (isDefaultCuaProductHelperCurrent(helper)) {
          cuaProductHelperEnv = candidateEnv;
        } else {
          cuaProductHelperWorkspaceRegistry.setEnabled(context, false);
          cuaProductHelperEnv = {
            [BROKER_UNAVAILABLE_ENV]: "broker_unavailable: helper lifecycle is disposed",
          };
        }
      } else if (cuaPluginEnabled) {
        cuaProductHelperEnv = {
          [BROKER_UNAVAILABLE_ENV]: defaultCuaProductHelperLifecycle.disposed
            ? "broker_unavailable: helper lifecycle is disposed"
            : "broker_unavailable: managed Helper host is unavailable",
        };
      }
      const cuaActive = Boolean(
        cuaProductHelperEnv[BROKER_SOCKET_ENV]?.trim() &&
        cuaProductHelperEnv[CODEZ_CUA_PLUGIN_AUTHORITY_ENV_KEY]?.trim(),
      );
      // Codex 拥有账号、配置与工具；旧 Provider/Zai/CUA/Subagent 准备不能成为其启动前置条件。
      // PATH 仍由 initializeRuntimeProcessEnv 统一准备，身份与 transport 仍由进程管理器注入。
      if (usesDefaultCodexDesktopBridge) {
        if (!isRemoteWorkspaceContext && options?.serviceAuthorityMode === "desktop-local") {
          await syncCodexNativeCuaSkill(cuaPluginEnabled, process.env).catch(() => undefined);
        }
        // 本机临时 Key 在 spawn 边界现读（本地读 Credential Store；远端读本进程内
        // 逐连接安装的内存事实）。缺值注入 undefined 显式屏蔽继承变量，并把供应商
        // 列入 bridge 的 fail-closed 名单；名单只含 provider id，不含任何 Key 材料。
        const codexNativeKeyMaterial = acceptsRemoteEphemeralKeys
          ? codexNativeProviderSpawnEnvFromInstalled(
              installedCodexNativeKeys,
              codexNativeKeyRotationActive,
            )
          : await resolveCodexNativeProviderSpawnEnv({
              credentialService,
              environmentKey: CODEX_NATIVE_PROVIDER_LOCAL_ENVIRONMENT_KEY,
            });
        // 官方插件的 ZCode 专有 HTTP MCP 通过 bearer_token_env_var 从进程环境取 token；
        // 仅在已登录 z.ai 时注入，token 不落盘、不进入物化文件（spec: codex-zcode-plugin-compatibility）。
        const zaiOfficialMcpToken = (
          await credentialService
            .load(`oauth:${ZAI_PROVIDER_ID}:access_token`)
            .catch(() => undefined)
        )?.trim();
        return {
          ...networkEnv,
          ...codexNativeKeyMaterial.env,
          [CODEZ_CODEX_BLOCKED_PROVIDER_IDS_ENV_KEY]:
            codexNativeKeyMaterial.blockedProviderIds.join(","),
          ...(zaiOfficialMcpToken ? { CODEZ_ZAI_OFFICIAL_MCP_TOKEN: zaiOfficialMcpToken } : {}),
          // codex bridge 的 update_plan 工具注册在 app-server 配置加载期，只能随进程启动注入；
          // 开关变更由下方 messageStreamShowTodos 订阅统一释放活动 workspace 后生效。
          ...(settings.messageStreamShowTodos === true
            ? { [CODEZ_CODEX_UPDATE_PLAN_ENABLED_ENV_KEY]: "1" }
            : {}),
          // spec: codex-desktop-native-browser-cua「Remote workspace relay」「Global enable toggle」。
          // 本地：清单来自 Main 授权（InitLocal 快照 + Main 推送的运行时持有器，spawn 时现读）；
          // 远端：仅当 relay 已被窗口 Host 授予时由本进程自建 remote-local 注册——
          // endpoint/tokenFile 都指向远端 relay，窗口 token 不出桌面进程。
          // 其余场景一律显式清空/置 0，防止 bridge 从继承环境注册桌面工具或误报可用性。
          ...(() => {
            if (isDesktopAttachedRemote) {
              const relayDescriptor = desktopBrowserRelay?.activeDescriptor();
              const remoteBridgePath = process.env.CODEZ_CODEX_BRIDGE_PATH?.trim();
              if (!relayDescriptor || !remoteBridgePath) {
                return {
                  [CODEZ_DESKTOP_MCP_SERVERS_ENV_KEY]: "",
                  [CODEZ_NATIVE_BROWSER_CUA_BROWSER_ENV]: "0",
                  [CODEZ_NATIVE_BROWSER_CUA_CUA_ENV]: "0",
                  [CODEZ_NATIVE_BROWSER_CUA_CUA_ENABLED_ENV]: "0",
                };
              }
              return {
                [CODEZ_DESKTOP_MCP_SERVERS_ENV_KEY]: JSON.stringify([
                  {
                    name: CODEZ_NATIVE_BROWSER_CUA_MCP_SERVER_NAME,
                    command: process.execPath,
                    args: [remoteBridgePath, CODEZ_NATIVE_BROWSER_CUA_MCP_ENTRY_MODE],
                    env: {
                      [CODEZ_NATIVE_BROWSER_CUA_ENDPOINT_ENV]: relayDescriptor.endpoint,
                      [CODEZ_NATIVE_BROWSER_CUA_TOKEN_FILE_ENV]: relayDescriptor.tokenFile,
                      [CODEZ_NATIVE_BROWSER_CUA_BROWSER_ENV]: "1",
                      [CODEZ_NATIVE_BROWSER_CUA_CUA_ENV]: "0",
                      [CODEZ_NATIVE_BROWSER_CUA_CUA_ENABLED_ENV]: "0",
                    },
                  },
                ]),
                [CODEZ_NATIVE_BROWSER_CUA_BROWSER_ENV]: "1",
                [CODEZ_NATIVE_BROWSER_CUA_CUA_ENV]: "0",
                [CODEZ_NATIVE_BROWSER_CUA_CUA_ENABLED_ENV]: "0",
              };
            }
            const liveState = options?.desktopBrowserMcpStateSource?.();
            const localServers =
              options?.serviceAuthorityMode === "desktop-local"
                ? (liveState?.servers ?? options.desktopCodexMcpServers)
                : undefined;
            const localFacts = liveState?.nativeBrowserCua ?? nativeBrowserCua;
            const mergedServers = localServers?.map((server) =>
              server.name === CODEZ_NATIVE_BROWSER_CUA_MCP_SERVER_NAME
                ? {
                    ...server,
                    env: {
                      // Main 只拥有 browser 授权；CUA 环境由当前 Local Host 独占写入。
                      ...Object.fromEntries(
                        Object.entries(server.env).filter(([key]) => !key.startsWith("CODEZ_CUA_")),
                      ),
                      [CODEZ_NATIVE_BROWSER_CUA_BROWSER_ENV]: localFacts?.browserAvailable
                        ? "1"
                        : "0",
                      [CODEZ_NATIVE_BROWSER_CUA_CUA_ENABLED_ENV]: cuaPluginEnabled ? "1" : "0",
                      [CODEZ_NATIVE_BROWSER_CUA_CUA_ENV]: cuaActive ? "1" : "0",
                      // 授权文件只落在 MCP server env；bridge 每次调用现读完整 tuple，
                      // 原始凭据不进入完整 Agent 环境变量。
                      ...(helper?.credentialGrantPublisher
                        ? {
                            [CUA_CREDENTIAL_GRANT_FILE_ENV]:
                              helper.credentialGrantPublisher.grantFilePath,
                          }
                        : {}),
                      ...(cuaActive
                        ? {
                            [BROKER_SOCKET_ENV]: cuaProductHelperEnv[BROKER_SOCKET_ENV]!,
                            [CODEZ_CUA_PLUGIN_AUTHORITY_ENV_KEY]:
                              cuaProductHelperEnv[CODEZ_CUA_PLUGIN_AUTHORITY_ENV_KEY]!,
                            ...(cuaProductHelperEnv[BROKER_GENERATION_ENV]
                              ? {
                                  [BROKER_GENERATION_ENV]:
                                    cuaProductHelperEnv[BROKER_GENERATION_ENV],
                                }
                              : {}),
                          }
                        : {}),
                    },
                  }
                : server,
            );
            return {
              [CODEZ_DESKTOP_MCP_SERVERS_ENV_KEY]: mergedServers?.length
                ? JSON.stringify(mergedServers)
                : "",
              ...(localFacts
                ? {
                    [CODEZ_NATIVE_BROWSER_CUA_BROWSER_ENV]: localFacts.browserAvailable ? "1" : "0",
                    [CODEZ_NATIVE_BROWSER_CUA_CUA_ENABLED_ENV]: cuaPluginEnabled ? "1" : "0",
                    [CODEZ_NATIVE_BROWSER_CUA_CUA_ENV]:
                      cuaActive || localFacts.cuaAvailable ? "1" : "0",
                  }
                : {}),
            };
          })(),
        };
      }
      // 内置 Subagent 的旧覆盖必须在 CLI 独立读取之前导入，不能等待设置页操作。
      if (!isDesktopAttachedRemote) await subagentsService.prepareRuntimeState(context);
      const telemetryEnv = getCapturedCodezAgentTelemetryEnv();
      const telemetryConfigured = Boolean(
        telemetryEnv.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT || telemetryEnv.OTEL_EXPORTER_OTLP_ENDPOINT,
      );
      const telemetryProfile = telemetryConfigured
        ? await oauthCredentialRepo.loadActiveUserProfile().catch(() => null)
        : null;
      const telemetryDeviceMid = telemetryConfigured
        ? options?.agentTelemetry?.getDeviceMid?.()?.trim()
        : undefined;
      // Host 是旧配置迁移的唯一写入者。Agent spawn 前等待初始化完成，避免 Worker
      // 先拿到尚不存在的 provider_config.json 并发布短暂空 Registry。
      await providerConfigRuntime.start();
      const runtimeApiKeys = acceptsRemoteEphemeralKeys
        ? [...installedRuntimeApiKeys].map(([name, value]) => ({ name, value }))
        : (await providerProvisioningSource.readRuntimeApiKeys()).keys;
      return {
        ...networkEnv,
        ...Object.fromEntries(runtimeApiKeys.map(({ name, value }) => [name, value])),
        // 把 host 解析出的权威 origin（含 settings 覆盖）下发给 agent，否则 agent 侧只按
        // env 推导，test env + 自定义端点时两侧信任判定的输入分叉、官方 MCP 整体 fail closed。
        ...buildAgentEndpointOriginEnv(await resolveCurrentCodezEndpointOrigin()),
        // broker 凭据（socket/token）注入 agent spawn env，让内置 codez-cua plugin 的
        // computer-use MCP server 经 __codez-plugin-host 恢复 token 后连上 broker。
        ...cuaProductHelperEnv,
        ...buildAgentTelemetrySpawnEnv({
          deviceMid: telemetryDeviceMid,
          runtimeSurface: options?.agentTelemetry?.runtimeSurface ?? "remote_workspace_host",
          telemetryEnv,
          userId: telemetryProfile?.id,
        }),
        ...createNodeProviderRuntimePathEnv({
          // Built-in Active 路径按当前 Endpoint 隔离，不能通过同步的固定路径
          // getter 读取；Agent spawn 必须等待本轮 Endpoint Source 完成解析和物化。
          codezBuiltinFilePath: await providerConfigRuntime.resolveCodezBuiltinActiveFilePath(),
          personalFilePath: join(resolveAppConfigDir(), PERSONAL_PROVIDER_CONFIG_FILE_NAME),
        }),
      };
    },
    ...(!isDesktopAttachedRemote
      ? { readSubagentRuntimeConfig: subagentsService.readRuntimeConfig }
      : {}),
    ...(isDesktopAttachedRemote
      ? { sessionRuntimePreferencesAuthority: "external" as const }
      : {
          sessionRuntimePreferencesAuthority: "local" as const,
          resolveSessionRuntimePreferences: async (scope) => {
            // 预算已统一，不能把可选远端配置作为本地/手机 shared-host 建会话的前置条件。
            const settings = await settingService.get();
            const modelContextBudgetStrategy = DEFAULT_CODEZ_MODEL_CONTEXT_BUDGET_STRATEGY;
            return {
              askUserQuestionAutoResolutionEnabled:
                settings.askUserQuestionAutoResolutionEnabled !== false,
              nativeSearchEnhancementsEnabled: settings.nativeSearchEnhancementsEnabled !== false,
              toolSearchMode: settings.toolSearchMode ?? "off",
              memoryEnabled: settings.memoryEnabled === true,
              // 完整记忆偏好随会话 materialization 下发；与热更新共用同一事实源。
              memoryUseEnabled: settings.memoryUseEnabled !== false,
              memoryExtractionEnabled: settings.memoryExtractionEnabled !== false,
              memoryExtractionModel: settings.memoryExtractionModel ?? null,
              modelContextBudgetStrategy,
              // user-execution 只消费 Shell；共享默认策略是统一 result schema 的兼容占位，
              // 不会覆盖 runtime-materialization 阶段已经固定的 strategy。
              ...(scope === "user-execution" && settings.integratedTerminalShell
                ? { integratedTerminalShell: settings.integratedTerminalShell }
                : {}),
            };
          },
        }),
  });
  providerConnectivityAgentService = codezAgentService;
  // Helper health probe 短暂超时不应在 Computer Use turn 中途回收 Agent。resolver 会把 restart
  // 推迟到下一个 request/turn 边界；若 broker 确实已失效，当前 turn 会自然失败并由下一次请求恢复。
  hasActiveTurnRef = () => codezAgentService.hasActiveCuaOperationTurn();
  // desktop-continuous UI 直接订阅 codezSessionService，绕开 Codez task adapter 的
  // mapServiceEvent 路径，导致 task_complete 永远不会写回 sqlite，侧边栏 spinner 不停。
  // 在 services 层装配一个共享的 taskIndexRepo + syncer，session 任意入口都会唤醒
  // shadow 订阅，把 runtime 终态收敛进 sqlite。
  const codezTaskIndexSyncer = createCodezTaskIndexSyncer({
    agentService: codezAgentService,
    taskIndexRepo,
    onTaskRowsCreated: () => {
      void publishProjectChange().catch(() => {});
    },
  });
  // 自动归档只由这里的定时扫描触发（启动首轮 + 每小时 + 设置变更补扫）；readTree 与任务点击
  // 都不再执行 archiveInactive。判据仍排除 syncer 观察到的非终态会话，不为扫描启动 CLI。
  const taskAutoArchiveScheduler = createTaskAutoArchiveScheduler({
    readPolicy: async () => {
      const settings = await settingService.get();
      if (!settings.taskAutoArchiveEnabled) return null;
      const days = Math.max(1, Math.floor(settings.taskAutoArchiveOlderThanDays ?? 30));
      return {
        cutoff: Date.now() - days * 86_400_000,
        activeTasks: codezTaskIndexSyncer.activeTaskRefs(),
      };
    },
    repository: () => taskIndexRepo.getProjectRepository(),
    afterChange: publishProjectChange,
  });
  // The plugin can be toggled at runtime. Do not let a previously created resolver continue
  // health-checking/restarting Helper after disable, and create it lazily after enable.
  // 动态 resolver：isPluginEnabled 与 helper 创建用同一个 isCuaEnabledForContext 门控（dev mode 一致），
  // 避免开发场景下 resolver pass-through 而 helper 已建的割裂。
  const defaultCuaProductMcpServerResolver = createDynamicCuaProductMcpServerResolver({
    isPluginEnabled: (context) => isCuaEnabledForContext(context),
    getResolver: async () => {
      // peek-only——resolver 属托管 host 体系，host 未建时返回 undefined（懒启动下
      // CUA 经 node_repl + 稳定 socket，不依赖此 resolver）；绝不在此 acquire。
      const helper = defaultCuaProductHelperLifecycle.peek()?.helper;
      return helper && isDefaultCuaProductHelperCurrent(helper) ? helper.resolver : undefined;
    },
    isResolverCurrent: (resolver) =>
      defaultCuaProductHelperLifecycle.peek()?.helper.resolver === resolver,
  });
  const cuaProductMcpServerResolver =
    options?.cuaProductMcpServerResolver ?? defaultCuaProductMcpServerResolver;
  const codezSessionService = createCodezSessionService({
    agentService: codezAgentService,
    taskIndexSyncer: codezTaskIndexSyncer,
    cuaProductMcpServerResolver,
  });
  const gitCommitMessageGenerator = new GitCommitMessageGenerator({
    currentModelProvider: {
      async readCurrentModel(workspace) {
        if (usesDefaultCodexDesktopBridge) {
          // Git 辅助也必须使用目标 cwd 的原生配置；旧 View 会启动 Provider Runtime 并误拦截 Codex。
          const [rawConfig, rawModels] = await Promise.all([
            codezAgentService.codexRequest({
              ...workspace,
              request: {
                method: "config/read",
                params: { cwd: workspace.workspacePath, includeLayers: false },
              },
            }),
            codezAgentService.codexRequest({
              ...workspace,
              request: {
                method: "model/list",
                params: { includeHidden: false },
              },
            }),
          ]);
          const { config } = codexConfigResponseSchema.parse(rawConfig);
          const catalog = codexModelsResponseSchema.parse(rawModels);
          const cursors = new Set<string>();
          while (catalog.nextCursor) {
            const cursor = catalog.nextCursor;
            if (cursors.has(cursor) || cursors.size >= 100) {
              throw new Error("Invalid Codex model pagination cursor");
            }
            cursors.add(cursor);
            const page = codexModelsResponseSchema.parse(
              await codezAgentService.codexRequest({
                ...workspace,
                request: {
                  method: "model/list",
                  params: { includeHidden: false, cursor },
                },
              }),
            );
            catalog.data.push(...page.data);
            catalog.nextCursor = page.nextCursor;
          }
          const configuredModel =
            typeof config.model === "string" ? config.model.trim() : undefined;
          const model = catalog.data.find(
            (entry) =>
              !entry.hidden &&
              (configuredModel ? entry.model === configuredModel : entry.isDefault),
          );
          // custom provider 的配置模型可能不在发现目录；保留有效配置，不伪造模型能力。
          const modelId = configuredModel || model?.model;
          if (!modelId) return null;
          const providerId =
            typeof config.model_provider === "string"
              ? config.model_provider.trim() || "openai"
              : "openai";
          const effort =
            (typeof config.model_reasoning_effort === "string"
              ? config.model_reasoning_effort.trim()
              : undefined) || model?.defaultReasoningEffort;
          return {
            providerId,
            modelId,
            ...(effort ? { options: { reasoningLevel: effort } } : {}),
          };
        }
        // Git sidecar 属于目标 Environment；初始模型直接读取同一 Host View，
        // 不再通过临时 Agent workspace state 反推模型与 reasoning。
        return (await providerRuntime.modelSelection.getView()).preferredSelection ?? null;
      },
    },
    textGenerator: {
      async generateText(params) {
        return await codezAgentService.generateWorkspaceText({
          ...(params.signal ? { signal: params.signal } : {}),
          workspacePath: params.workspacePath,
          ...(params.workspaceIdentity ? { workspaceIdentity: params.workspaceIdentity } : {}),
          selection: params.selection,
          prompt: params.prompt,
          querySource: params.querySource,
        });
      },
    },
    logger: createServiceLogger("git-commit-message"),
    capabilityChecker: {
      canGenerateWorkspaceText: (params) => codezAgentService.canGenerateWorkspaceText(params),
    },
  });
  const gitService = createGitService({
    commitMessageGenerator: gitCommitMessageGenerator,
  });
  // task wrapper 由 Codez task service adapter 提供；核心 session 状态由 Codez agent server 维护。
  const codezTaskService = createCodezTaskServiceAdapter({
    codezAgentService,
    taskIndexRepo,
    taskIndexSyncer: codezTaskIndexSyncer,
    settingService,
    cuaProductMcpServerResolver,
    agentRuntimeMode: usesDefaultCodexDesktopBridge ? "codex" : "legacy",
  });
  const botsRepo = new BotsRepo();
  const botLog = createServiceLogger("bots");
  const botRemoteWorkspaceService = options.resolveBotProjectConnection
    ? createBotProjectRuntime({
        remoteProjectService,
        resolveOnline: options.resolveBotProjectConnection,
        onConnectionsChanged: (listener) =>
          broadcastService.onMessage((event) => {
            if (event.channel === "state:projects") listener();
          }),
        readBoundTargets: async () =>
          Object.values((await botsRepo.readState()).bots).flatMap((context) =>
            context.workspaceIdentity
              ? [
                  {
                    workspacePath: context.workspacePath,
                    workspaceIdentity: context.workspaceIdentity,
                    hostId: context.hostId,
                  },
                ]
              : [],
          ),
        readRuntimePreferences: async () => {
          const settings = await settingService.get();
          return {
            askUserQuestionAutoResolutionEnabled:
              settings.askUserQuestionAutoResolutionEnabled !== false,
            modelIoFullRetentionEnabled: settings.modelIoFullRetentionEnabled === true,
          };
        },
        warn: (message) => botLog.warn(message),
      })
    : undefined;
  const oauthService = createOAuthService(credentialService, {
    apiClient,
    onProviderLogout: handleOAuthProviderLogout,
  });
  const codezJwtLogoutLogger = createServiceLogger("codez-jwt-logout");
  codezJwtLogoutHandlerRef.current = (input, headers) => {
    // 条件退出本身已串行去重；不能丢弃等待旧候选期间到来的新凭据 401。
    void oauthService
      .logoutIfCurrentCredentialRequest(input, headers)
      .then((invalidated) => {
        // 401 分类后可能已完成新登录；只有队列内真正清理的旧会话才广播过期。
        if (invalidated) {
          void broadcastService.send({
            channel: CODEZ_JWT_INVALID_BROADCAST_CHANNEL,
            payload: {},
          });
        }
      })
      .catch((error) => {
        codezJwtLogoutLogger.warn("Codez JWT logout failed", { error });
      });
  };
  // Desktop Host 曾从 Settings View 再扫描一次 Account Provider，既绕开
  // Registry 的 entitlement/executable 事实，也在多个套餐同时可见时无法唯一选择。
  // 闲时服务与 Host 派发必须共享同一个 Registry-backed 凭据解析闭包。
  const offPeakCredentialResolverDeps = {
    credentialService,
    accountRequestAuthService,
    resolveAccountProvider: async () => {
      await providerRuntime.start();
      // start 缓存的是首次就绪；账号后到或切换后必须读 Registry 最近完成的快照。
      const snapshot = providerRuntime.registryService.getSnapshot()!;
      const providers = snapshot.resolution.registryProviders.filter(
        (candidate) =>
          candidate.config.access.type === "zhipu-account" &&
          (candidate.config.access.mode === "individual-coding-plan" ||
            candidate.config.access.mode === "team-coding-plan"),
      );
      if (providers.length !== 1) return null;
      const provider = providers[0]!;
      const config = provider.config;
      const staticAccess = codezProviderAccountAccessSchema.parse(config.access.toJSON());
      const access = await accountRequestAuthService.resolveAccessCurrent(staticAccess);
      if (!access) return null;
      return {
        providerId: provider.providerId,
        access: codezAccountAccessSchema.parse(access),
        ...(config.api?.baseUrl ? { baseURL: config.api.baseUrl } : {}),
      };
    },
  };
  const buildOffPeakRequestAuthForTicket: OffPeakRequestAuthBuilder = async (ticketId) =>
    buildOffPeakRequestAuth({
      credentials: await resolveOffPeakCredentials(offPeakCredentialResolverDeps),
      ticketId,
    });
  const fileService = createFileService({
    workspaceFileSearchFilter: options?.workspaceFileSearchFilter,
  });
  const mediaPreviewService = createMediaPreviewService({
    fileService,
    authorizeLocalMediaPreviewPath: options?.authorizeLocalMediaPreviewPath,
    createLocalMediaPreviewUrl: buildLocalMediaPreviewUrl,
  });
  const conversationShareClient = new ConversationShareHttpClient({
    // 分享运行时始终走真实 API；测试/Mock 场景应在 service 单测或 Web fixture 中显式注入，
    // 不能让开发环境默认生成仅存在于进程内存的 mock-share 链接。
    apiClient,
    baseUrl: buildRuntimeCodezApiUrl(process.env, "/api/v1"),
    tokenProvider: async (): Promise<string | null> => {
      const activeProvider = await oauthCredentialRepo.getActiveProvider();
      if (!activeProvider) {
        return null;
      }
      const tokenSet = await oauthCredentialRepo.loadTokenSet(activeProvider);
      return tokenSet?.codezJwtToken ?? tokenSet?.accessToken ?? null;
    },
  });
  const conversationShareService: IConversationShareServiceType = isDesktopAttachedRemote
    ? createUnsupportedConversationShareService({
        message: "Conversation publishing is not available for remote workspaces",
      })
    : new ConversationShareService({
        codezAgentService,
        codezSessionService,
        client: conversationShareClient,
        artifactSource: createLocalConversationShareArtifactSource(),
      });
  conversationShareContentCopyReader = (input) =>
    conversationShareService.readSharedContextContentCopy(input);
  // 注册链上的懒工厂（如 OffPeak）会各自创建 tasks-index sqlite repo；先收集到本数组，
  // services 集合建好后在 return 前统一登记进 sharedSqliteRepos 侧表
  const sqliteReposToClose: Array<{ close(): void }> = [];
  const marketingAssets = createMarketingAssetRegistry({
    allowLoopback: CODEZ_ENV === "test" || process.env.NODE_ENV === "development",
  });
  // Codex bridge 模式：账号/配置/模型目录由 Codex 持有，legacy Provider Registry 不启动。
  // Bot、Automation 与移动 Web 都经 IModelSelectionService 解析 Submission 模型——
  // 用 Codex 原生目录（config/read + model/list）适配同一合同；legacy 模式保持原视图。
  const hostModelSelectionService: IModelSelectionService = usesDefaultCodexDesktopBridge
    ? createCodexModelSelectionService({
        send: (params) => codezAgentService.codexRequest(params),
        readCatalogProviderMap: (target) => codezAgentService.readCodexCatalog(target),
      })
    : providerRuntime.modelSelection;
  const supportsDesktopFileRewindOwner = usesDefaultCodexDesktopBridge && !isDesktopAttachedRemote;
  const codexDesktopFileRewindService = supportsDesktopFileRewindOwner
    ? createCodexDesktopFileRewindService({
        agentService: codezAgentService,
        isRegisteredOwner: () => supportsDesktopFileRewindOwner,
        rootDir: getCodezDataRootDir(),
      })
    : undefined;
  const services = new ServiceCollection()
    .register(
      IMarketingTouchService,
      createMarketingTouchService({
        apiClient,
        getToken: () => credentialService.load("codezjwttoken"),
        getDeviceMid: () => options?.agentTelemetry?.getDeviceMid?.(),
        baseUrl: buildRuntimeCodezApiUrl(process.env, "/"),
        appVersion: CODEZ_VERSION,
        onSnapshot: (snapshot) => marketingAssets.accept(snapshot),
      }),
    )
    .register(IFileService, fileService)
    .register(IMediaPreviewService, mediaPreviewService)
    .register(
      ICloudContentService,
      createCloudContentService({
        publishedAssets: marketingAssets,
        cacheRoot: join(getContentAppConfigDir(), "cache", "content-bundles", randomUUID()),
      }),
    )
    .register(IGitService, gitService)
    .register(IGitCheckpointService, gitCheckpointService)
    .register(ISystemService, systemService)
    .register(ITerminalService, createTerminalService({ settingService }))
    .register(ISettingService, settingService)
    .register(IOnboardingRecordService, onboardingRecordService)
    .register(ICredentialService, credentialService)
    .register(IBroadcastService, broadcastService)
    .register(ICodezTaskService, codezTaskService)
    .register(ICodezAgentService, codezAgentService)
    .register(ICodezSessionService, codezSessionService)
    .register(IProjectService, projectService)
    .register(ITaskGroupService, taskGroupService)
    .register(IRemoteProjectService, remoteProjectService)
    .register(ICuaPermissionService, cuaPermissionService)
    .register(ICuaPipSessionService, cuaPipSessionService)
    .register(IConversationShareService, conversationShareService)
    .register(
      IBotsService,
      createBotsService({
        repo: botsRepo,
        projectService,
        remoteProjectService,
        ownerHostId: options?.projectStorageHostId ?? "local",
        credentialService,
        codezTaskService,
        broadcastService,
        settingService,
        modelSelectionService: hostModelSelectionService,
        remoteWorkspaceService: botRemoteWorkspaceService
          ? { ...botRemoteWorkspaceService, resolveWorkspace: options?.resolveBotRemoteWorkspace }
          : undefined,
        // 远端与本地 Bot 都读取所属 Environment 的 Model Selection View。
        // 远端启动期不再轮询旧 Preset，避免重新制造一套模型候选事实。
        runStartupBackgroundTasks: !isDesktopAttachedRemote,
      }),
    )
    .register(IFileWatcherService, createFileWatcherService())
    .register(IOAuthService, oauthService)
    .register(ISourceServerWorkspaceService, sourceServerWorkspaceService)
    .register(
      IUsageStatsService,
      createUsageStatsService({
        apiClient,
        accountRequestAuthService,
        credentialService,
        codezAgentService,
        officialMcpCredentialSource,
      }),
    )
    .register(ICodingPlanSubscriptionService, codingPlanSubscriptionService)
    .register(
      IClientConfigService,
      createClientConfigService({
        apiClient,
        resolveRequestContext: async () => ({
          endpointOrigin: await resolveCurrentCodezEndpointOrigin(),
          appVersion: CODEZ_VERSION,
          platform: `${process.platform}-${process.arch}`,
        }),
      }),
    )
    .register(IClientScenesService, createClientScenesService({ apiClient }))
    .register(
      IOffPeakTaskService,
      (() => {
        // 闲时任务编排服务（与 automation 服务面独立）：
        // 单例属主在本集合，renderer 经 ProxyChannel 直连，host 派发经 getOptional 取同一实例。
        const offPeakLogger = createServiceLogger("off-peak");
        const resolveCredentials = () => resolveOffPeakCredentials(offPeakCredentialResolverDeps);
        const originResolver = createOffPeakOriginResolver({
          logger: offPeakLogger,
          resolveUpstream: () => resolveOffPeakMockUpstream(offPeakCredentialResolverDeps),
        });
        const offPeakTaskRepo = new OffPeakTaskRepo();
        // OffPeakTaskRepo 也持有 tasks-index.sqlite 连接；收集到链前数组，services 建好后统一登记
        // （工厂在注册链求值期执行，此时 services 常量尚未初始化，不能直接引用）
        sqliteReposToClose.push(offPeakTaskRepo);
        const offPeakTaskService = new OffPeakTaskService({
          prepareProjectExecution,
          repo: offPeakTaskRepo,
          client: createOffPeakServerClient({
            resolveOrigin: originResolver.resolveOrigin,
            resolveCredentials,
            logger: offPeakLogger,
          }),
          resolveCodingPlanSupport: () =>
            resolveOffPeakCodingPlanSupport(offPeakCredentialResolverDeps),
          resolveTelemetryProviderName: async () =>
            resolveSafeTelemetryHostname(await originResolver.resolveOrigin()),
          resolveModelSelection: async (input) => {
            await providerRuntime.start();
            const support = await resolveOffPeakCodingPlanSupport(offPeakCredentialResolverDeps);
            const providerId = support.supported
              ? OFF_PEAK_PROVIDER_IDS[support.providerFamily]
              : undefined;
            const provider = providerId
              ? providerRuntime.registryService
                  .getView()
                  .providers.find((candidate) => candidate.providerId === providerId)
              : undefined;
            const modelId = input.modelId ?? provider?.models[0]?.modelId;
            if (!provider || !modelId) {
              return {
                ok: false as const,
                validation: {
                  ok: false as const,
                  code: "provider-not-found" as const,
                  providerId: OFF_PEAK_PROVIDER_IDS.zai,
                },
              };
            }
            // 旧行没有 Provider 身份；只能复用当前账号凭据链已裁定的 Account Family，
            // 不能靠 Registry/JSON 顺序在 Z.ai 与 BigModel 间猜测。
            const selection = {
              providerId: provider.providerId,
              modelId,
              ...(input.reasoningLevel
                ? { options: { reasoningLevel: input.reasoningLevel } }
                : {}),
            };
            const validation = providerRuntime.registryService.validateSelection(selection);
            return validation.ok
              ? { ok: true as const, selection }
              : { ok: false as const, validation };
          },
          logger: offPeakLogger,
          requestSchedulerWake: options?.onOffPeakSchedulerWakeRequested,
          stopRunningTask: async (params) => {
            await codezTaskService.stopGeneration({
              taskId: params.conversationId,
              workspacePath: params.workspacePath,
              ...(params.workspaceIdentity ? { workspaceIdentity: params.workspaceIdentity } : {}),
            });
          },
          onDispose: () => {
            void originResolver.close().catch(() => undefined);
          },
        });
        offPeakTaskService.startSync();
        // 回写前向引用，供 codezAgentService 的 offPeak/create、offPeak/list 协议 handler 调用。
        offPeakTaskServiceForAgent = offPeakTaskService;
        return offPeakTaskService;
      })(),
    )
    .register(
      IHighspeedCardService,
      (() => {
        const origin = resolveRuntimeCodezEndpointOrigin(process.env);
        const rawMockScenario = process.env.CODEZ_HIGHSPEED_MOCK_SCENARIO;
        const mockScenarios = new Set<HighspeedMockScenario>([
          "hit-fast",
          "miss",
          "hit-after-timeout",
          "hit-invalid-model",
          "hit-queue-edit",
          "existing-foreign-task-card",
          "expired-card",
        ]);
        const mockScenario = mockScenarios.has(rawMockScenario as HighspeedMockScenario)
          ? (rawMockScenario as HighspeedMockScenario)
          : null;
        const resolveHighspeedLoginHeaders = async (): Promise<Record<string, string>> => {
          const jwt = (await credentialService.load("codezjwttoken"))?.trim() ?? "";
          if (!jwt) throw new Error("highspeed request requires codez jwt");
          return {
            Authorization: /^Bearer\s/i.test(jwt) ? jwt : `Bearer ${jwt}`,
          };
        };
        const transport = mockScenario
          ? createHighspeedMockTransport({ scenario: mockScenario })
          : createHighspeedHttpTransport({
              drawUrl: `${origin}/api/v1/highspeed/draw`,
              healthyBaseUrl: `${origin}/api/v1/highspeed/`,
              logger: createServiceLogger("highspeed"),
              drawHeaders: async () => {
                const credentials = await resolveOffPeakCredentials(offPeakCredentialResolverDeps, {
                  allowMockCredentials: false,
                });
                const codingPlanAuthorization =
                  (
                    await credentialService.load(`oauth:${credentials.providerFamily}:access_token`)
                  )?.trim() ?? "";
                return buildHighspeedCodingPlanAuthHeaders({
                  codezJwt: credentials.jwt,
                  codingPlanAuthorization,
                  targetType:
                    credentials.organizationId && credentials.projectId ? "TEAM" : "PERSONAL",
                  ...(credentials.organizationId
                    ? { organizationId: credentials.organizationId }
                    : {}),
                  ...(credentials.projectId ? { projectId: credentials.projectId } : {}),
                });
              },
              healthyHeaders: resolveHighspeedLoginHeaders,
            });
        return new HighspeedCardService({
          transport,
          // 普通 mock 只验证抽卡 UI，不依赖隐藏执行 Provider；目录外模型与队列编辑场景
          // 必须走真实 Highspeed execution Selection，才能覆盖创建期退回和队列模型隔离。
          inferenceMode:
            mockScenario &&
            mockScenario !== "hit-invalid-model" &&
            mockScenario !== "hit-queue-edit"
              ? "session-default"
              : "highspeed",
          // 规则 11：draw 只对 Coding Plan 用户开放；mock 场景放行以便本地验证。
          resolveCodingPlanSupported: mockScenario
            ? async () => true
            : async () =>
                (await resolveOffPeakCodingPlanSupport(offPeakCredentialResolverDeps)).supported,
          // 规则 14：会话模型必须属于所选 Coding Plan Provider 的模型目录（Built-in Provider
          // Config 投影）才发起新 draw；mock 场景放行以便本地验证。
          resolveModelCovered: mockScenario
            ? async () => true
            : async (providerId, modelId) => {
                const view = await providerRuntime.modelSelection.getView();
                const provider = view.providers.find((item) => item.providerId === providerId);
                return provider?.models.some((model) => model.modelId === modelId) ?? false;
              },
          // 加速推理与 draw 走同一 highspeed 网关、同一 Coding Plan 双 JWT 契约：必须携带
          // codez JWT + Coding Plan 业务 JWT + Team 身份头。此前只发 codez JWT + 卡 ID，网关
          // 无法校验 Coding Plan 权益，返回 401 auth_failed。与 draw 头复用同一次 selected
          // connection 解析，避免把 ZAI 身份的卡打到 BigModel 加速 Provider。
          resolveInferenceAuth: async () => {
            const credentials = await resolveOffPeakCredentials(offPeakCredentialResolverDeps, {
              allowMockCredentials: false,
            });
            const codingPlanAuthorization =
              (
                await credentialService.load(`oauth:${credentials.providerFamily}:access_token`)
              )?.trim() ?? "";
            return {
              codezJwt: credentials.jwt,
              family: credentials.providerFamily,
              codingPlanAuthorization,
              targetType: credentials.organizationId && credentials.projectId ? "TEAM" : "PERSONAL",
              ...(credentials.organizationId ? { organizationId: credentials.organizationId } : {}),
              ...(credentials.projectId ? { projectId: credentials.projectId } : {}),
            };
          },
        });
      })(),
    )
    .register(ISkillsService, skillsService)
    .register(ISkillSyncService, createSkillSyncService())
    .register(IMcpSyncService, mcpSyncService)
    .register(
      IGenUiService,
      createGenUiService({ registerSandbox: options?.registerPluginSandbox }),
    )
    .register(IPluginUiBridgeService, pluginUiBridgeService)
    .register(IPluginUiSamplingService, pluginUiSamplingService)
    .register(IPluginUiAppToolsService, pluginUiAppToolsService)
    // 合并 MCP/Plugin Management 服务装配时误删了 plugin-sync 注册，
    // RemoteServiceAccess 仍会请求该频道，导致本地候选枚举超时、远端同步无法开始。
    .register(IPluginSyncService, pluginSyncService)
    .register(IPluginsService, createPluginsService({ isDesktopRuntime: true }))
    // 设置页插件管理薄服务——plugins/* 旧协议词的 host 侧唯一消费点。
    .register(
      IPluginManagementService,
      createPluginManagementService({
        codezAgentService,
        reportTelemetryEvent: options?.reportPluginTelemetryEvent,
        disposeActiveWorkspaceRuntimes: (params) =>
          codezAgentService.disposeActiveWorkspaceRuntimes(params),
        codexNativeCuaMode:
          usesDefaultCodexDesktopBridge && options?.serviceAuthorityMode === "desktop-local",
      }),
    )
    .register(ISubagentsService, subagentsService)
    .register(ICommandsService, createCommandsService({ isDesktopRuntime: true }))
    .register(
      IHooksService,
      createHooksService({
        grantWorkspaceHookTrust: (params) => codezAgentService.grantWorkspaceHookTrust(params),
      }),
    )
    .register(IMemoryService, createMemoryService())
    .register(IOutputStyleService, createOutputStyleService())
    .register(ISettingsSyncService, createSettingsSyncService({ settingService }))
    .register(
      IFeedbackService,
      createFeedbackService({
        ...options?.feedback,
        apiClient,
        credentialService,
        oauthService,
      }),
    )
    .register(IPromptAttachmentTransferService, createLocalPromptAttachmentTransferService());

  // 即使初始配置关闭也必须登记 lifecycle disposer：terminal fence 需要早于任意延迟 setting/acquire
  // 恢复，不能把"当前还没有 Helper"误当成"不需要生命周期所有者"。dispose 时串行 stop host。
  registerManagedCuaHelperHostForDispose(services, {
    stop: async () => {
      await defaultCuaProductHelperLifecycle.dispose();
    },
  });
  registerHostApiNetworkTransportForDispose(services, hostApiNetworkTransport);
  // disposer 注册完成后才排预热。若 createLocalServices 中途抛错，不能留下一个无人持有、却会在当前
  // 调用栈结束后才创建的高权限 Helper；若返回后立即 dispose，terminal fence 会先于 acquire 生效。
  // Helper 懒启动：不预热——Helper 由 SDK 首次 CUA 调用拉起（spawn env 注入
  // 稳定 socket），或用户显式授权流（restartHelper）拉起。启动即零 Helper 常驻。

  // Rewind is Desktop-local only. Registering `undefined` would create a channel-map entry
  // even though `getOptional` resolves it as absent, so registration itself must be conditional.
  if (codexDesktopFileRewindService)
    services.register(ICodexDesktopFileRewindService, codexDesktopFileRewindService);

  accountRequestAuthServices.set(services, accountRequestAuthService);
  offPeakRequestAuthBuilders.set(services, buildOffPeakRequestAuthForTicket);

  providerRuntimes.set(services, providerRuntime);
  codexModelSelectionServices.set(services, hostModelSelectionService);
  providerProvisioningSources.set(services, providerProvisioningSource);
  providerProvisioningTriggerDisposers.set(services, providerProvisioningDisposers);
  // desktop-attached-remote 的组织态在远端 Host 库里，由远端自己的扫描器归档；本机不扫。
  if (!isDesktopAttachedRemote) {
    const stopSettingsRescan = settingService.onDidUpdate((event) => {
      if (shouldRescanTaskAutoArchive(event.keys)) {
        void taskAutoArchiveScheduler.scan().catch(() => {});
      }
    });
    taskAutoArchiveScheduler.start();
    codexGlobalRolloutSyncer?.start();
    taskAutoArchiveDisposers.set(services, () => {
      stopSettingsRescan();
      taskAutoArchiveScheduler.dispose();
      codexGlobalRolloutSyncer?.dispose();
    });
  }
  settingsRuntimeRestartDisposers.set(services, [
    settingService.onDidUpdate((event) => {
      // update_plan 的工具注册发生在 app-server 配置加载期，进程内热切换不存在；
      // 设置变更后释放本 Host 全部活动 workspace runtime，下一次使用时按新值拉起。
      // 进行中的 turn 会被打断，与切换模型的 workspace 重启语义一致。
      if (!event.keys.includes("messageStreamShowTodos")) return;
      void codezAgentService
        .disposeActiveWorkspaceRuntimes({ reason: "messageStreamShowTodos" })
        .catch((error: unknown) => {
          createServiceLogger("settings-runtime-restart").warn(
            undefined,
            "restart workspace runtimes for messageStreamShowTodos failed",
            { message: error instanceof Error ? error.message : String(error) },
          );
        });
    }),
  ]);
  services
    .register(IProviderSettingsService, providerSettingsService)
    .register(IModelSelectionService, hostModelSelectionService);
  if (!isDesktopAttachedRemote) {
    // Renderer 面只暴露「保存/提交/回滚」命令与是否已配置；Key 值由本 Host 进程私有读写。
    services.register(
      ICodexNativeProviderKeyService,
      createCodexNativeProviderKeyService({
        environmentKey: CODEX_NATIVE_PROVIDER_LOCAL_ENVIRONMENT_KEY,
        credentialService,
        disposeLocalRuntimes: () =>
          codezAgentService.disposeActiveWorkspaceRuntimes({
            reason: "codex-provider-key-change",
          }),
      }),
    );
  }
  if (isDesktopAttachedRemote || options.providerProvisioningTargetEnabled === true) {
    services.register(
      IProviderProvisioningTargetService,
      createProviderProvisioningTarget({
        providerRuntime,
        personalRepository: providerConfigRuntime.personalRepository,
        accountProviderSource: accountProviderConfigSource,
        credentialService,
        settingService,
        personalConfigFilePath: join(resolveAppConfigDir(), PERSONAL_PROVIDER_CONFIG_FILE_NAME),
        stateFilePath: join(resolveAppConfigDir(), "runtime", "provider", "provisioning.json"),
        listProvisioningCredentialKeys: () =>
          listProviderProvisioningCredentialKeys(resolveCredentialFilePath(resolveAppConfigDir())),
        installRuntimeApiKeys: acceptsRemoteEphemeralKeys
          ? async (keys) => {
              const changed =
                keys.length !== installedRuntimeApiKeys.size ||
                keys.some(({ name, value }) => installedRuntimeApiKeys.get(name) !== value);
              if (changed) {
                await codezAgentService.disposeActiveWorkspaceRuntimes({
                  reason: "remote-runtime-key-change",
                  includeLegacy: true,
                });
              }
              installedRuntimeApiKeys.clear();
              for (const { name, value } of keys) installedRuntimeApiKeys.set(name, value);
            }
          : undefined,
        codexNativeKeys: acceptsRemoteEphemeralKeys
          ? {
              beginRotation: async () => {
                codexNativeKeyRotationActive = true;
                // 先停止旧 Agent：原生配置热刷新不更新进程环境，旧进程不得继续以旧 Key 接单。
                await codezAgentService.disposeActiveWorkspaceRuntimes({
                  reason: "codex-provider-key-rotation",
                });
              },
              install: async (keys) => {
                const codexConfigTomlPath = join(
                  process.env.CODEX_HOME?.trim() || join(homedir(), ".codex"),
                  "config.toml",
                );
                // 只安装远端配置仍引用的条目；外部改写/删除的引用静默失效，不做磁盘回写。
                const filtered = await filterCodexNativeKeysByConfigFile(keys, codexConfigTomlPath);
                const changed =
                  filtered.length !== installedCodexNativeKeys.size ||
                  filtered.some((key) => {
                    const current = installedCodexNativeKeys.get(key.envName);
                    return (
                      !current ||
                      current.providerId !== key.providerId ||
                      current.value !== key.value
                    );
                  });
                installedCodexNativeKeys.clear();
                for (const key of filtered) {
                  installedCodexNativeKeys.set(key.envName, {
                    providerId: key.providerId,
                    value: key.value,
                  });
                }
                codexNativeKeyRotationActive = false;
                if (changed) {
                  await codezAgentService.disposeActiveWorkspaceRuntimes({
                    reason: "codex-provider-key-change",
                  });
                }
              },
            }
          : undefined,
      }),
    );
  }
  const log = createServiceLogger("provider-runtime");
  // 旧装配无条件预热会在 Codex 登录前读取 Zai 账号并启动配置同步；原生默认路径保持按需服务。
  if (!usesDefaultCodexDesktopBridge)
    void providerRuntime.start().then(
      () => {
        const snapshot = providerRuntime.registryService.getSnapshot()!;
        log.info("Provider Registry 已就绪", {
          configRevision: snapshot.sourceRevisions.config,
          providerCount: snapshot.registry.providers.length,
        });
      },
      (error: unknown) => {
        log.error("Provider 配置事实初始化失败", error);
      },
    );

  // 见 sharedSqliteRepos 声明处注释：登记全部 tasks-index sqlite 句柄，dispose 链统一关闭
  sqliteReposToClose.push(taskIndexRepo);
  sharedSqliteRepos.set(services, sqliteReposToClose);
  return services;
}

export function createTelemetryUserIdLoader(
  credentialService: Pick<ICredentialService, "load">,
): () => Promise<string> {
  const log = createServiceLogger("telemetry-user-id");
  return async () => {
    try {
      const activeProvider = (await credentialService.load("oauth:active_provider"))?.trim() ?? "";
      if (!activeProvider) {
        return "";
      }

      const rawUserInfo = await credentialService.load(`oauth:${activeProvider}:user_info`);
      return readTelemetryOAuthUserId(rawUserInfo);
    } catch (error) {
      if (!isCredentialDecryptError(error)) {
        throw error;
      }

      // Bugfix: telemetry 只是只读 userId 上报入口，不能抢在 host OAuthService 前
      // 对损坏凭据做半套清理；否则会漏掉派生模型 provider key 的 logout 收口。
      log.warn(undefined, "skip telemetry user id: OAuth credential decrypt failed", error);
      return "";
    }
  };
}

/** 仅给同一事件账号返回当前 Codez JWT；不缓存、不修改登录凭据。 */
export function createTelemetryAuthorizationLoader(
  credentialService: Pick<ICredentialService, "load">,
): (userId: string) => Promise<string | null> {
  return async (userId) => {
    if (!userId) return null;
    try {
      const provider = (await credentialService.load("oauth:active_provider"))?.trim();
      if (provider !== "zai" && provider !== "bigmodel") return null;
      const readUserId = async () =>
        readTelemetryOAuthUserId(await credentialService.load(`oauth:${provider}:user_info`));
      if ((await readUserId()) !== userId) return null;
      const jwt = (await credentialService.load("codezjwttoken"))?.trim();
      // 退出/切账号可能发生在异步读取期间；禁止将旧身份的 token 附到其他账号事件上。
      if (
        (await credentialService.load("oauth:active_provider"))?.trim() !== provider ||
        (await readUserId()) !== userId
      )
        return null;
      return jwt && /^[\x21-\x7e]+$/.test(jwt) ? `Bearer ${jwt}` : null;
    } catch {
      return null;
    }
  };
}

export function createTelemetryMarketingParamsLoader(
  credentialService: ICredentialService,
): () => Promise<import("@codez/shared").OAuthLoginAttribution | null> {
  // 恢复原因：固定返回 null 会丢掉已保存的渠道归因，数仓应读取 OAuth 的同一份事实。
  const repo = new OAuthCredentialRepo(credentialService);
  return () => repo.loadLoginAttribution();
}

function readTelemetryOAuthUserId(rawUserInfo: string | null): string {
  if (!rawUserInfo) {
    return "";
  }

  try {
    const parsed = JSON.parse(rawUserInfo) as {
      id?: unknown;
      user_id?: unknown;
    };
    const id = typeof parsed.id === "string" ? parsed.id : "";
    const userId = typeof parsed.user_id === "string" ? parsed.user_id : "";
    return id.trim() || userId.trim();
  } catch {
    return "";
  }
}

export function disposeServiceResources(services: ServiceCollection): void {
  const content = services.getOptional(ICloudContentService);
  if (content && hasDisposeAllAndWait(content)) void content.disposeAllAndWait().catch(() => {});
  (
    services.getOptional(IGenUiService) as (IGenUiService & { dispose?(): void }) | undefined
  )?.dispose?.();
  // Bugfix: host process 退出前以前没有统一遍历本地服务做资源回收，
  // terminal/task wrapper 这类会拉起子进程的服务只能等宿主进程自己结束，时序上可能留下短暂残留。
  // 这里集中调用各服务的本地 disposeAll 钩子，把“退出 app = 回收所有托管资源”落成机械动作。
  const disposableServices = [
    services.getOptional(ITerminalService),
    services.getOptional(ICodezTaskService),
    services.getOptional(ICodezAgentService),
    services.getOptional(ICodezSessionService),
    services.getOptional(IBotsService),
    services.getOptional(IFileWatcherService),
    services.getOptional(ISubagentsService),
    services.getOptional(IOffPeakTaskService),
  ].filter((service) => service !== undefined);

  for (const service of disposableServices) {
    if (hasDisposeAll(service)) {
      service.disposeAll();
    }
  }

  // 同步 best-effort：终止托管的 Computer Use Helper（不 await，避免阻断同步 dispose 路径）。
  const managedCuaHelperHost = managedCuaHelperHosts.get(services);
  if (managedCuaHelperHost) {
    void managedCuaHelperHost.stop().catch(() => {});
  }
  // 关闭共享 tasks-index sqlite 句柄（Windows 上悬着句柄会让后续目录清理撞 EBUSY）
  for (const repo of sharedSqliteRepos.get(services) ?? []) repo.close();
  sharedSqliteRepos.delete(services);
  disposeHostModelSelectionService(services);
  providerRuntimes.get(services)?.dispose();
  for (const dispose of providerProvisioningTriggerDisposers.get(services) ?? []) dispose();
  providerProvisioningTriggerDisposers.delete(services);
  for (const dispose of settingsRuntimeRestartDisposers.get(services) ?? []) dispose();
  settingsRuntimeRestartDisposers.delete(services);
  providerProvisioningSources.delete(services);
  taskAutoArchiveDisposers.get(services)?.();
  taskAutoArchiveDisposers.delete(services);
  managedHostApiNetworkTransports.get(services)?.dispose();
}

export async function disposeServiceResourcesAndWait(services: ServiceCollection): Promise<void> {
  (
    services.getOptional(IGenUiService) as (IGenUiService & { dispose?(): void }) | undefined
  )?.dispose?.();
  // app 关闭时 host 需要等 agent 进程树完成 graceful + force 清理。
  // 旧的同步 dispose 会在 host 退出时丢掉强杀 timer，导致 codez-cli/app-server 变成孤儿进程。
  const disposableServices = [
    services.getOptional(ICloudContentService),
    services.getOptional(ITerminalService),
    services.getOptional(ICodezTaskService),
    services.getOptional(ICodezAgentService),
    services.getOptional(ICodezSessionService),
    services.getOptional(IBotsService),
    services.getOptional(IFileWatcherService),
    services.getOptional(ISubagentsService),
    services.getOptional(IOffPeakTaskService),
  ].filter((service) => service !== undefined);

  for (const service of disposableServices) {
    if (hasDisposeAllAndWait(service)) {
      await service.disposeAllAndWait();
    } else if (hasDisposeAll(service)) {
      service.disposeAll();
    }
  }

  // 等待托管的 Computer Use Helper 终止（best-effort）：Helper 是长生命周期高权限进程，服务释放语义必须显式
  // 收口它，不能只靠 launcher-pid watchdog / 进程退出兜底。
  const managedCuaHelperHost = managedCuaHelperHosts.get(services);
  if (managedCuaHelperHost) {
    await managedCuaHelperHost.stop().catch(() => {});
  }
  // 关闭共享 tasks-index sqlite 句柄（同 disposeServiceResources，异步收口路径也要释放）
  for (const repo of sharedSqliteRepos.get(services) ?? []) repo.close();
  sharedSqliteRepos.delete(services);
  disposeHostModelSelectionService(services);
  providerRuntimes.get(services)?.dispose();
  for (const dispose of providerProvisioningTriggerDisposers.get(services) ?? []) dispose();
  providerProvisioningTriggerDisposers.delete(services);
  for (const dispose of settingsRuntimeRestartDisposers.get(services) ?? []) dispose();
  settingsRuntimeRestartDisposers.delete(services);
  providerProvisioningSources.delete(services);
  taskAutoArchiveDisposers.get(services)?.();
  taskAutoArchiveDisposers.delete(services);
  await managedHostApiNetworkTransports
    .get(services)
    ?.disposeAndWait()
    .catch(() => {});
}

/** 所有应用入口在开放 RPC / 调度器前等待；失败不启动业务写者。 */
export async function migrateApplicationStorage(
  settings?: Pick<AppSettings, "lastWorkspaceSession" | "recentProjects">,
  hostId?: string,
): Promise<{ backupSkipped: boolean }> {
  const automations = new AutomationRepo();
  const offPeak = new OffPeakTaskRepo();
  const tasks = new TaskIndexRepo(settings, hostId);
  try {
    await automations.ensureReady();
    await offPeak.ensureReady();
    await tasks.ensureReady();
    return {
      backupSkipped:
        tasks.migrationBackupSkipped ||
        automations.migrationBackupSkipped ||
        offPeak.migrationBackupSkipped,
    };
  } finally {
    tasks.close();
    offPeak.close();
    automations.close();
  }
}

export { bindRemoteProjectIdentities } from "#src/project/index.js";

export { startupStorage } from "#src/startup-storage/index.js";

/** 独立 Server 共用迁移屏障与身份装配；入口不得以 local owner 开放远端项目 RPC。 */
export async function createServerHostServices(options: {
  topicResourceRelayChannel?: NonNullable<
    Parameters<typeof createLocalServices>[0]
  >["topicResourceRelayChannel"];
  sourceServerId: string;
  codezBuiltinProviderConfigFilePath: string;
  providerProvisioningTargetEnabled?: boolean;
  ephemeralRuntimeKeysEnabled?: boolean;
}) {
  const projectStorageHostId = remoteHostIdFromWorkspaceIdentity(
    buildServerRemoteWorkspaceIdentity({ serverId: options.sourceServerId, workspacePath: "/" }),
  );
  if (!projectStorageHostId) throw new Error("Invalid Source Server storage identity");
  await migrateApplicationStorage(await createSettingService().get(), projectStorageHostId);
  const workspaceAliasRepo = new SourceServerWorkspaceAliasRepo();
  const workspaceIdentityMapper = new SourceServerWorkspaceIdentityMapper();
  const sourceServerWorkspaceService = createSourceServerWorkspaceService(workspaceAliasRepo, {
    defaultWorkspaceIdentity: (workspacePath) =>
      buildServerRemoteWorkspaceIdentity({ serverId: options.sourceServerId, workspacePath }),
    onResolved: ({ workspacePath, canonicalWorkspaceKey }) => {
      workspaceIdentityMapper.register({
        stableIdentity: buildServerRemoteWorkspaceIdentity({
          serverId: options.sourceServerId,
          workspacePath,
        }),
        canonicalIdentity: canonicalWorkspaceKey,
      });
    },
  });
  const migrationFailedPathCount = await workspaceAliasRepo.getFailedPathCount();
  const services = createLocalServices({
    codezBuiltinProviderConfigFilePath: options.codezBuiltinProviderConfigFilePath,
    providerProvisioningTargetEnabled: options.providerProvisioningTargetEnabled,
    ephemeralRuntimeKeysEnabled: options.ephemeralRuntimeKeysEnabled,
    serviceAuthorityMode: "standalone-server",
    topicResourceRelayChannel: options.topicResourceRelayChannel,
    projectStorageHostId,
    sourceServerWorkspaceService,
  });
  return { services, workspaceIdentityMapper, migrationFailedPathCount };
}

export { scopeConversationShareServiceForAttachment } from "./conversation-share/conversationShareConnectionScope.js";
export { localRuntimeNetworkCapture } from "./codez-agent/localRuntimeNetworkCapture.js";
