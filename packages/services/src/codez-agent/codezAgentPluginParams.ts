import type {
  CodezAgentMcpServer,
  CodezAutomationScheduleRule,
  CodezMcpListMode,
  ModelSelection,
} from "@codez/shared";

export interface CodezAgentWorkspaceTarget {
  workspacePath: string;
  workspaceIdentity?: string;
  /** 远程 workspace 的运行时会话身份；只用于隔离/路由，不能替代 workspacePath。 */
  remoteSessionId?: string;
}

export interface CodezAgentPluginViewParams extends CodezAgentWorkspaceTarget {
  configScope?: "user" | "workspace";
}

export interface CodezAgentListMcpServerStatusesParams extends CodezAgentWorkspaceTarget {
  mcpServers?: CodezAgentMcpServer[];
  mode?: CodezMcpListMode;
}

export interface CodezAgentAddPluginMarketplaceParams extends CodezAgentWorkspaceTarget {
  dryRun?: boolean;
  operationId?: string;
  source: string;
}

export interface CodezAgentRemovePluginMarketplaceParams extends CodezAgentWorkspaceTarget {
  marketplace: string;
}

export interface CodezAgentUpdatePluginMarketplaceParams extends CodezAgentWorkspaceTarget {
  marketplace?: string;
  operationId?: string;
}

export interface CodezAgentInstallPluginParams extends CodezAgentWorkspaceTarget {
  dryRun?: boolean;
  marketplace: string;
  operationId?: string;
  pluginName: string;
  scope?: "user" | "workspace";
}

export interface CodezAgentCancelPluginOperationParams {
  operationId: string;
}

export interface CodezAgentUninstallPluginParams extends CodezAgentWorkspaceTarget {
  marketplace?: string;
  pluginId?: string;
  pluginName?: string;
  removeCache?: boolean;
}

export interface CodezAgentUpdatePluginParams extends CodezAgentWorkspaceTarget {
  pluginId?: string;
  marketplace?: string;
}

export interface CodezAgentRestoreBuiltinPluginParams extends CodezAgentWorkspaceTarget {
  pluginId: string;
}

export interface CodezAgentConfigurePluginParams extends CodezAgentWorkspaceTarget {
  clearOptionKeys?: string[];
  dryRun?: boolean;
  options: Record<string, unknown>;
  pluginId: string;
  scope?: "user" | "workspace";
}

export interface CodezAgentResetPluginConfigParams extends CodezAgentWorkspaceTarget {
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

export interface CodezAgentSetPluginEnabledParams extends CodezAgentWorkspaceTarget {
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
export interface CodezAgentResolveSuggestedPluginReferenceParams extends CodezAgentWorkspaceTarget {
  stableId: string;
  operationId: string;
  clientMode: "desktop-continuous" | "web-remote-replayable";
  deliveryKind: "desktop-continuous" | "web-remote-replayable";
}

// ---- 定时任务(automation)管理参数 ----

export interface CodezAgentCreateAutomationParams extends CodezAgentWorkspaceTarget {
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
