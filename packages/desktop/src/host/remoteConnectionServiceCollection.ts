import {
  ServiceCollection,
  IFileService,
  IMediaPreviewService,
  IGitService,
  ISystemService,
  ITerminalService,
  ISettingService,
  ICredentialService,
  IBroadcastService,
  ICodezTaskService,
  ICodezAgentService,
  ICodezSessionService,
  IFileWatcherService,
  IOAuthService,
  ICodingPlanSubscriptionService,
  IClientConfigService,
  IClientScenesService,
  ISkillsService,
  ISkillSyncService,
  IMcpSyncService,
  IPluginSyncService,
  IPluginsService,
  IPluginManagementService,
  ICommandsService,
  ISettingsSyncService,
  IPromptAttachmentTransferService,
  type IServiceAccessor,
} from "@codez/services";
import {
  createSettingService,
  createBroadcastService,
  createOAuthService,
  createOAuthProviderLogoutHandler,
  createAccountProviderCredentialStore,
  createCodingPlanSubscriptionService,
  createClientScenesService,
  createSettingsSyncService,
  createMediaPreviewService,
} from "@codez/services/node";
import type { ApiClient } from "@codez/shared";

export function createRemoteConnectionServiceCollection(params: {
  clientConfigService: IClientConfigService;
  connectionServices: IServiceAccessor;
  parentPort: Parameters<typeof createBroadcastService>[0];
  credentialService: ICredentialService;
  apiClient: ApiClient;
  remoteCodezTaskService: ICodezTaskService;
  remoteCodezSessionService: ICodezSessionService;
  promptAttachmentTransferService: IPromptAttachmentTransferService;
}): ServiceCollection {
  const handleOAuthProviderLogout = createOAuthProviderLogoutHandler({
    accountProviderCredentialStore: createAccountProviderCredentialStore({
      credentialService: params.credentialService,
    }),
  });
  // 修复原因：remote connection host 直接暴露给 renderer 的 service 集合也要包含
  // 远端文件系统相关服务；否则远端 skill 同步会命中 Unknown channel 或误回落到本机。
  return (
    new ServiceCollection()
      .register(IFileService, params.connectionServices.fileService)
      .register(
        IMediaPreviewService,
        createMediaPreviewService({
          fileService: params.connectionServices.fileService,
        }),
      )
      .register(IGitService, params.connectionServices.gitService)
      .register(ISystemService, params.connectionServices.systemService)
      .register(ITerminalService, params.connectionServices.terminalService)
      .register(ISettingService, createSettingService())
      .register(ICredentialService, params.credentialService)
      .register(IBroadcastService, createBroadcastService(params.parentPort))
      .register(ICodezTaskService, params.remoteCodezTaskService)
      .register(ICodezAgentService, params.connectionServices.codezAgentService)
      .register(ICodezSessionService, params.remoteCodezSessionService)
      .register(IPromptAttachmentTransferService, params.promptAttachmentTransferService)
      .register(IFileWatcherService, params.connectionServices.fileWatcherService)
      .register(
        IOAuthService,
        createOAuthService(params.credentialService, {
          apiClient: params.apiClient,
          onProviderLogout: handleOAuthProviderLogout,
        }),
      )
      .register(
        ICodingPlanSubscriptionService,
        createCodingPlanSubscriptionService({
          apiClient: params.apiClient,
          credentialService: params.credentialService,
        }),
      )
      .register(IClientScenesService, createClientScenesService({ apiClient: params.apiClient }))
      .register(IClientConfigService, params.clientConfigService)
      .register(ISkillsService, params.connectionServices.skillsService)
      .register(ISkillSyncService, params.connectionServices.skillSyncService)
      .register(IMcpSyncService, params.connectionServices.mcpSyncService)
      .register(IPluginSyncService, params.connectionServices.pluginSyncService)
      .register(IPluginsService, params.connectionServices.pluginsService)
      // M5 ③-3：远端设置页插件管理也必须打到远端 agent（插件目录在远端文件系统）。
      .register(IPluginManagementService, params.connectionServices.pluginManagementService)
      .register(ICommandsService, params.connectionServices.commandsService)
      .register(
        ISettingsSyncService,
        createSettingsSyncService({
          settingService: createSettingService(),
        }),
      )
  );
}
