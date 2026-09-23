// 平台能力面收敛：设置页「插件管理」的薄服务接口。
//
// 背景：pluginManagementStore / usePluginUninstall 过去直接注入 ICodezAgentService，
// UI 层因此散布 13 个 plugins/* 旧协议词的消费点。收敛为独立薄 service 后，UI 只依赖
// 本接口；plugins/* 词表的 host 侧消费点收拢到 pluginManagementService 一处（插件的
// 事实源在 codez-cli 进程，服务实现仍经 agent 协议往返——plugins 词表的收口归属
// 插件能力面自身的协议演进，不在会话 v4 词表范围内）。
// 注意与既有 IPluginsService（已 retired 的 marketplace pluginStore 通道）区分：
// 那套接口按 pluginName+marketplace 寻址且方法语义过时，不复用避免签名冲突。
import type { Event } from "@codez/rpc";
import type {
  CodezPluginOperationProgressNotification,
  CodezPluginsConfigureResult,
  CodezPluginsCancelOperationResult,
  CodezPluginsDescribeResult,
  CodezPluginsInstallResult,
  CodezPluginsListResult,
  CodezPluginsMarketplaceMutationResult,
  CodezPluginsOverviewResult,
  CodezPluginsReferenceCatalogResult,
  CodezPluginsRestoreBuiltinResult,
  CodezPluginsSetEnabledResult,
  CodezPluginsUninstallResult,
  CodezPluginsValidateResult,
} from "@codez/shared";
import { ServiceChannels } from "@codez/shared";
import { createServiceDescriptor } from "../descriptors.js";
import type {
  CodezAgentAddPluginMarketplaceParams,
  CodezAgentConfigurePluginParams,
  CodezAgentCancelPluginOperationParams,
  CodezAgentDescribePluginParams,
  CodezAgentInstallPluginParams,
  CodezAgentPluginReferenceCatalogParams,
  CodezAgentResolveSuggestedPluginReferenceParams,
  CodezAgentResetPluginConfigParams,
  CodezAgentPluginViewParams,
  CodezAgentRemovePluginMarketplaceParams,
  CodezAgentRestoreBuiltinPluginParams,
  CodezAgentSetPluginEnabledParams,
  CodezAgentUninstallPluginParams,
  CodezAgentUpdatePluginMarketplaceParams,
  CodezAgentUpdatePluginParams,
  CodezAgentValidatePluginParams,
} from "../codez-agent/codezAgentPluginParams.js";

export interface IPluginManagementService {
  listPlugins(params: CodezAgentPluginViewParams): Promise<CodezPluginsListResult>;
  /**
   * Plugin 对话引用 catalog：
   * 带 sessionId → session-owned 冻结 catalog；不带 → workspace 当前 catalog。
   * 实现路由到 workspace 级 agent client，不走插件管理独立进程。
   */
  getPluginReferenceCatalog(
    params: CodezAgentPluginReferenceCatalogParams,
  ): Promise<CodezPluginsReferenceCatalogResult>;
  resolveSuggestedPluginReference(
    params: CodezAgentResolveSuggestedPluginReferenceParams,
  ): Promise<import("@codez/shared").CodezPluginsResolveSuggestedReferenceResult>;
  onDynamicPluginOperationProgress(
    operationId: string,
  ): Event<CodezPluginOperationProgressNotification>;
  getPluginsOverview(params: CodezAgentPluginViewParams): Promise<CodezPluginsOverviewResult>;
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
}

export const IPluginManagementService = createServiceDescriptor<IPluginManagementService>(
  ServiceChannels.PluginManagement,
);
