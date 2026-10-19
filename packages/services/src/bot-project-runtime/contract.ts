import type { ICodezTaskService } from "#src/index.js";
import type { IModelSelectionService } from "#src/model-provider/providerFacadeServices.js";
import type {
  ICodezAgentService,
  CodezAgentAppRuntimePreferences,
} from "#src/codez-agent/codezAgent.js";
import type { IRemoteProjectService } from "#src/remote-projects/contract.js";
export type { ICodezTaskService, CodezAgentAppRuntimePreferences };
export type BotRemoteTarget = { workspacePath: string; workspaceIdentity: string; hostId?: string };
export type BotRuntimeSubscription = { dispose(): void };
export interface BotProjectConnection {
  /** 物理连接的代际标识；router 不拥有或关闭该连接。 */
  owner: object;
  taskService: ICodezTaskService;
  modelSelectionService: Pick<IModelSelectionService, "getView">;
  agentService: Pick<ICodezAgentService, "syncAppRuntimePreferences">;
  bindWorkspace(target: BotRemoteTarget): Promise<void>;
}
export interface BotProjectRuntimePort {
  remoteProjectService: Pick<IRemoteProjectService, "readDirectory" | "connectHost">;
  resolveOnline(hostId: string): BotProjectConnection | undefined;
  onConnectionsChanged(listener: () => void): BotRuntimeSubscription;
  readBoundTargets(): Promise<readonly BotRemoteTarget[]>;
  readRuntimePreferences(): Promise<CodezAgentAppRuntimePreferences>;
  warn(message: string): void;
}
/** 只路由现有 Source；不创建 workspace/session/Agent，不拥有 accepted queue。 */
export interface BotRemoteRuntimeService {
  isConnected(target: BotRemoteTarget): Promise<boolean>;
  ensureConnected(target: BotRemoteTarget): Promise<{ ok: boolean; message?: string }>;
  getCodezTaskService(target: BotRemoteTarget): Promise<ICodezTaskService | null>;
  getModelSelectionService(
    target: BotRemoteTarget,
  ): Promise<Pick<IModelSelectionService, "getView"> | null>;
  syncAppRuntimePreferences(preferences: CodezAgentAppRuntimePreferences): Promise<void>;
}
