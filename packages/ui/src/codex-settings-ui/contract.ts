import type { ICodexNativeProviderKeyService, ICodezAgentService } from "@codez/services";

export type {
  ICodexNativeProviderKeyService,
  ICodezAgentService,
  IServiceAccessor,
} from "@codez/services";
export type { CodexRequest } from "@codez/shared";

/** 复用原 native 设置与 catalog 入口，不暴露独立配置 Repo。 */
export type CodexSettingsRpcPort = Pick<
  ICodezAgentService,
  "codexRequest" | "readCodexCatalogModels" | "listAgentRoles"
>;
export type CodexSettingsKeyPort = ICodexNativeProviderKeyService;
