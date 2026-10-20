import type {
  ModelSelection,
  CodezAgentMcpServer,
  CodezAutomationScheduleRule,
  CodezMcpListMode,
} from "@codez/shared";
import type { McpAppsAppToolCallResult, McpAppsAppToolDescriptor } from "@codez/shared/mcp-apps";

export interface CodezAgentWorkspaceTarget {
  workspacePath: string;
  workspaceIdentity?: string;
  /** 远程 workspace 的运行时会话身份；只用于隔离/路由，不能替代 workspacePath。 */
  remoteSessionId?: string;
}

export interface CodezAgentPluginMutationTarget extends CodezAgentWorkspaceTarget {
  /** 仅 Host 观测使用；不会传给 CLI。 */
  telemetry?: {
    entry?:
      | "store_list"
      | "store_detail"
      | "side_pane_market"
      | "recommended_prompt"
      | "recommended_ui"
      | "component_settings";
    client_kind?: "desktop" | "mobile";
    trigger?: "user" | "automatic" | "dependency" | "restore" | "sync";
  };
}

export interface CodezAgentPluginViewParams extends CodezAgentWorkspaceTarget {
  configScope?: "user" | "workspace";
}

export interface CodezAgentListMcpServerStatusesParams extends CodezAgentWorkspaceTarget {
  mcpServers?: CodezAgentMcpServer[];
  mode?: CodezMcpListMode;
}

export interface CodezAgentAddPluginMarketplaceParams extends CodezAgentPluginMutationTarget {
  dryRun?: boolean;
  operationId?: string;
  source: string;
}

export interface CodezAgentRemovePluginMarketplaceParams extends CodezAgentPluginMutationTarget {
  marketplace: string;
}

export interface CodezAgentUpdatePluginMarketplaceParams extends CodezAgentPluginMutationTarget {
  marketplace?: string;
  operationId?: string;
}

export interface CodezAgentInstallPluginParams extends CodezAgentPluginMutationTarget {
  dryRun?: boolean;
  marketplace: string;
  operationId?: string;
  pluginName: string;
  scope?: "user" | "workspace";
}

export interface CodezAgentCancelPluginOperationParams {
  operationId: string;
}

export interface CodezAgentUninstallPluginParams extends CodezAgentPluginMutationTarget {
  marketplace?: string;
  pluginId?: string;
  pluginName?: string;
  removeCache?: boolean;
}

export interface CodezAgentUpdatePluginParams extends CodezAgentPluginMutationTarget {
  pluginId?: string;
  marketplace?: string;
}

export interface CodezAgentRestoreBuiltinPluginParams extends CodezAgentPluginMutationTarget {
  pluginId: string;
}

export interface CodezAgentConfigurePluginParams extends CodezAgentPluginMutationTarget {
  clearOptionKeys?: string[];
  dryRun?: boolean;
  options: Record<string, unknown>;
  pluginId: string;
  scope?: "user" | "workspace";
}

export interface CodezAgentResetPluginConfigParams extends CodezAgentPluginMutationTarget {
  pluginId: string;
  scope?: "user" | "workspace";
}

export interface CodezAgentValidatePluginParams extends CodezAgentWorkspaceTarget {
  marketplace?: string;
  pluginName?: string;
  source?: string;
}

export interface CodezAgentDescribePluginParams extends CodezAgentWorkspaceTarget {
  marketplace: string;
  pluginName: string;
}

export interface CodezAgentSetPluginEnabledParams extends CodezAgentPluginMutationTarget {
  enabled: boolean;
  operationId?: string;
  pluginId: string;
  scope?: "user" | "workspace";
}

// Plugin 对话引用 catalog：
// 带 sessionId → session-owned 冻结 catalog（必须路由到持有该 session 的 workspace client）；
// 不带 → workspace 当前 catalog（新建草稿 Picker）。
export interface CodezAgentPluginReferenceCatalogParams extends CodezAgentWorkspaceTarget {
  sessionId?: string;
}

// Composer Skill catalog：与 Plugin 引用相同，以 sessionId 区分 workspace 当前目录和
// resident Session runtime 快照；不参与 Settings 管理目录。
export interface CodezAgentSkillReferenceCatalogParams extends CodezAgentWorkspaceTarget {
  sessionId?: string;
}

/** 插件 UI：UI 发起的 `ui://` 资源读取。 */
export interface CodezAgentReadMcpResourceParams extends CodezAgentWorkspaceTarget {
  instance: import("@codez/shared/mcp-apps").McpAppInstance;
  sessionId: string;
  pluginId: string;
  serverName: string;
  uri: string;
}

/** 插件 UI 页面发起的 `resources/read`；参数与 readMcpResource 同形，结果受 8 MiB 与 mimeType 白名单约束。 */
export type CodezAgentReadMcpResourceForUiParams = CodezAgentReadMcpResourceParams;

/** 插件 UI：UI 回调本插件工具；不进审批流，归属由 agent 侧 catalog fail closed。 */
export interface CodezAgentCallMcpToolForUiParams extends CodezAgentWorkspaceTarget {
  instance: import("@codez/shared/mcp-apps").McpAppInstance;
  sessionId: string;
  pluginId: string;
  serverName: string;
  toolName: string;
  arguments?: Record<string, unknown>;
  /** 宿主生成的调用 id，配合 cancelMcpToolCallForUi。 */
  callId: string;
}
/** 插件 UI 页面发起的 resources/list、resources/templates/list、subscribe、unsubscribe。 */
export interface CodezAgentListMcpResourcesForUiParams extends CodezAgentWorkspaceTarget {
  instance: import("@codez/shared/mcp-apps").McpAppInstance;
  sessionId: string;
  pluginId: string;
  serverName: string;
  cursor?: string;
}
/** App-Provided Tools：实例身份 = 会话 + 沙箱作用域 + 代际。 */
export interface CodezAgentAppToolInstanceForUiParams extends CodezAgentWorkspaceTarget {
  instance: import("@codez/shared/mcp-apps").McpAppInstance;
  sessionId: string;
  pluginId: string;
  serverName: string;
  scopeId: string;
  generation: number;
}
export interface CodezAgentRegisterAppToolsForUiParams extends CodezAgentAppToolInstanceForUiParams {
  tools: McpAppsAppToolDescriptor[];
}
export interface CodezAgentAppToolCallForUiParams extends CodezAgentAppToolInstanceForUiParams {
  callId: string;
}
export interface CodezAgentResolveAppToolCallForUiParams extends CodezAgentAppToolCallForUiParams {
  result?: McpAppsAppToolCallResult;
  error?: { message: string };
}
export interface CodezAgentMcpResourceSubscriptionForUiParams extends CodezAgentWorkspaceTarget {
  instance: import("@codez/shared/mcp-apps").McpAppInstance;
  sessionId: string;
  pluginId: string;
  serverName: string;
  scopeId: string;
  generation: number;
  uri: string;
}
export interface CodezAgentCancelMcpToolCallForUiParams extends CodezAgentWorkspaceTarget {
  instance: import("@codez/shared/mcp-apps").McpAppInstance;
  sessionId: string;
  pluginId: string;
  serverName: string;
  callId: string;
}
export interface CodezAgentResolveSuggestedPluginReferenceParams extends CodezAgentWorkspaceTarget {
  stableId: string;
  operationId: string;
  clientMode: "desktop-continuous" | "web-remote-replayable";
  deliveryKind: "desktop-continuous" | "web-remote-replayable";
}

// ---- 定时任务(automation)管理参数 ----

export interface CodezAgentCreateAutomationParams extends CodezAgentWorkspaceTarget {
  projectId?: string | null;
  title: string;
  cronExpr: string;
  relativeDelayMinutes?: number;
  prompt: string;
  modelSelection?: ModelSelection;
  mode?: string;
  recurring?: boolean;
  maxRuns?: number;
  endAt?: number;
  scheduleRule?: CodezAutomationScheduleRule;
}

export interface CodezAgentUpdateAutomationParams extends CodezAgentWorkspaceTarget {
  automationId: string;
  title?: string;
  cronExpr?: string;
  prompt?: string;
  modelSelection?: ModelSelection | null;
  mode?: string | null;
  recurring?: boolean;
  maxRuns?: number | null;
  endAt?: number | null;
  scheduleRule?: CodezAutomationScheduleRule | null;
  scheduleEditedByUser?: boolean;
}

export interface CodezAgentAutomationIdParams extends CodezAgentWorkspaceTarget {
  automationId: string;
}

export interface CodezAgentSetAutomationEnabledParams extends CodezAgentWorkspaceTarget {
  automationId: string;
  enabled: boolean;
}

export interface CodezAgentDeleteAutomationRunParams extends CodezAgentWorkspaceTarget {
  runId: string;
}
