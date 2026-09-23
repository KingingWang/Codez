/* eslint-disable max-lines -- Bot service 的共享测试桩集中维护协议、任务和模型 registry 能力。 */
import { afterEach, vi } from "vitest";
import type {
  CodezConfigOption,
  BotsConfigFile,
  BotsStateFile,
  Locale,
  ModelSelection,
  CodezTaskMode,
  CodezSessionSettingsState,
} from "@codez/shared";
import {
  CODEZ_MODEL_REASONING_SEPARATOR,
  CODEZ_PROTOCOL_NAME,
  CODEZ_PROTOCOL_VERSION,
  botsConfigFileSchema,
} from "@codez/shared";
export { botsConfigFileSchema };
import type { ICodezSessionService } from "../src/codez-session/codezSession.js";
import type { ICodezTaskService } from "../src/session/codezTaskService.js";
import type { IBroadcastService } from "../src/broadcast/broadcast.js";
import type { ICredentialService } from "../src/credential/credential.js";
import type { ISettingService } from "../src/setting/setting.js";
import { createBotsService as createBotsServiceImpl } from "../src/bots/botsService.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

export const defaultUserCommands = {
  status: true,
  new: true,
  workspace: true,
  model: true,
  thoughtLevel: true,
  sandboxMode: true,
  approvalPolicy: true,
  reply: true,
};

export function createMemoryRepo(config: BotsConfigFile, state?: BotsStateFile) {
  let currentConfig = config;
  let currentState = state ?? { version: 3 as const, bots: {} };
  return {
    async readConfig() {
      return currentConfig;
    },
    async writeConfig(nextConfig: BotsConfigFile) {
      currentConfig = nextConfig;
      return currentConfig;
    },
    async readState() {
      return currentState;
    },
    async writeState(nextState: BotsStateFile) {
      currentState = nextState;
      return currentState;
    },
  };
}

export function createLegacyTaskService(): ICodezTaskService {
  return {
    listTasks: vi.fn(async () => []),
    listDeletedTaskIds: vi.fn(async () => []),
    createTask: vi.fn(async () => ({
      taskId: "task-1",
      title: "Task 1",
      workspacePath: "/tmp/workspace",
      workspaceIdentity: "ssh://host/tmp/workspace",
      provider: "glm",
    })),
    sendPrompt: vi.fn(async () => undefined),
    setMode: vi.fn(async () => undefined),
    setConfigOption: vi.fn(async () => []),
    setModel: vi.fn(async () => []),
    getTaskConfigOptions: vi.fn(async () => []),
    getTaskModelSelection: vi.fn(async () => ({
      providerId: "glm",
      modelId: "glm-4.6",
      options: { reasoningLevel: "high" },
    })),
    getTaskSnapshot: vi.fn(async () => null),
    getTaskTokenUsage: vi.fn(async (params: { taskId: string }) => ({
      sessionId: params.taskId,
      totalTokens: 0,
      inputTokens: 0,
      outputTokens: 0,
      reasoningTokens: 0,
      cacheCreationTokens: 0,
      cacheReadTokens: 0,
      modelRequestCount: 0,
      modelErrorCount: 0,
      inputBaselineBySource: {},
    })),
    resumeTask: vi.fn(async () => ({
      taskId: "task-1",
      title: "Task 1",
      workspacePath: "/tmp/workspace",
      workspaceIdentity: "ssh://host/tmp/workspace",
      provider: "glm",
    })),
    switchAgent: vi.fn(async () => ({
      meta: {
        taskId: "task-1",
        title: "Task 1",
        workspacePath: "/tmp/workspace",
        workspaceIdentity: "ssh://host/tmp/workspace",
        provider: "glm",
      },
      provider: "glm",
      sessionId: "session-1",
      reusedBinding: false,
    })),
    respondPermission: vi.fn(async () => true),
    respondElicitation: vi.fn(async () => true),
    stopGeneration: vi.fn(async () => undefined),
    onDynamicStreamEvent: vi.fn(() => () => ({ dispose() {} })),
  } as unknown as ICodezTaskService;
}

export function createCredentialService(values: Record<string, string> = {}): ICredentialService {
  return {
    load: vi.fn(async (key: string) => values[key] ?? null),
    save: vi.fn(async (key: string, value: string) => {
      values[key] = value;
    }),
    delete: vi.fn(async (key: string) => {
      delete values[key];
    }),
  };
}

export function createBroadcastService(): IBroadcastService {
  return {
    send: vi.fn(async () => undefined),
    onMessage: vi.fn(),
  } as unknown as IBroadcastService;
}

export function createSettingService(settings: {
  recentProjects?: string[];
  lastWorkspaceSession?: Array<
    | { kind: "local"; workspacePath: string }
    | (Record<string, unknown> & {
        kind: "remote";
        workspacePath: string;
        workspaceIdentity?: string;
      })
  >;
  locale?: Locale;
  enabledBuiltinAgentCliProviders?: Array<"claude" | "opencode" | "gemini" | "codex" | "glm">;
}): ISettingService {
  return {
    get: vi.fn(async () => ({
      recentProjects: settings.recentProjects ?? [],
      lastWorkspaceSession: settings.lastWorkspaceSession ?? [],
      locale: settings.locale ?? "en-US",
      enabledBuiltinAgentCliProviders: settings.enabledBuiltinAgentCliProviders ?? ["glm"],
    })),
    update: vi.fn(async () => undefined),
    updateDataBaseDir: vi.fn(async () => undefined),
    ensureDefaultProject: vi.fn(async (path: string) => ({ path, created: false })),
  } as unknown as ISettingService;
}

export function createModelSelectionService(providers: readonly TestModelSelectionProvider[] = []) {
  return {
    getView: vi.fn(async (input?: { selection: ModelSelection | null }) => ({
      revision: 1,
      // 服务桩显式支持按输入返回结果；账号转换/失效分支由各自用例注入权威结果。
      ...(input ? { effectiveSelection: input.selection } : {}),
      providers: providers.map((provider) => ({
        providerId: provider.id,
        // 名称是 View 元数据；放进旧 config.label 会让展示测试错误回落到 ID。
        providerName: provider.name,
        config: {},
        models: provider.models.map((model) => ({
          modelId: typeof model === "string" ? model : model.id,
          config: typeof model === "string" ? {} : (model.config ?? {}),
        })),
      })),
      preferredSelection: providers[0]?.models[0]
        ? {
            providerId: providers[0].id,
            modelId:
              typeof providers[0].models[0] === "string"
                ? providers[0].models[0]
                : providers[0].models[0].id,
          }
        : undefined,
    })),
  };
}

export interface TestModelSelectionProvider {
  id: string;
  models: readonly (string | { id: string; config?: Record<string, unknown> })[];
  name: string;
}

function parseModelSelectionForTest(value: string): ModelSelection {
  const separatorIndex = value.indexOf("/");
  if (separatorIndex <= 0) {
    return { providerId: "glm", modelId: value || "default" };
  }
  const providerId = value.slice(0, separatorIndex);
  const rawModelId = value.slice(separatorIndex + 1);
  const reasoningSeparatorIndex = rawModelId.indexOf(CODEZ_MODEL_REASONING_SEPARATOR);
  if (reasoningSeparatorIndex <= 0 || reasoningSeparatorIndex >= rawModelId.length - 1) {
    return { providerId, modelId: rawModelId };
  }
  return {
    providerId,
    modelId: rawModelId.slice(0, reasoningSeparatorIndex),
    variant: rawModelId.slice(reasoningSeparatorIndex + 1),
  };
}

function normalizeCodezModeForTest(value: unknown): CodezTaskMode {
  switch (value) {
    case "plan":
    case "build":
    case "yolo":
    case "auto":
      return value;
    case "read-only":
      return "plan";
    case "full-access":
    case "agent-full-access":
      return "yolo";
    default:
      return "build";
  }
}

function readSelectOption(
  configOptions: readonly CodezConfigOption[],
  category: string,
): (CodezConfigOption & { type: "select" }) | undefined {
  return configOptions.find(
    (option): option is CodezConfigOption & { type: "select" } =>
      option.type === "select" && (option.category === category || option.id === category),
  );
}

export function createCodezSessionSettingsFromConfigOptions(
  configOptions: readonly CodezConfigOption[] = [],
): CodezSessionSettingsState {
  const modelOption = readSelectOption(configOptions, "model");
  const currentModelValue =
    typeof modelOption?.currentValue === "string"
      ? modelOption.currentValue
      : (modelOption?.options?.[0]?.value ?? "glm/default");
  const currentModel = parseModelSelectionForTest(currentModelValue);
  const modelOptions = modelOption?.options?.length
    ? modelOption.options
    : [{ value: currentModelValue, name: currentModel.modelId }];
  const thoughtOption = readSelectOption(configOptions, "thought_level");
  const modeOption = readSelectOption(configOptions, "mode");

  return {
    model: {
      current: currentModel,
      available: modelOptions.map((option) => ({
        ref: parseModelSelectionForTest(option.value),
        label: option.name ?? option.value,
        description: option.description,
      })),
      lastUsed: currentModel,
    },
    thoughtLevel: {
      enabled: Boolean(thoughtOption),
      current:
        typeof thoughtOption?.currentValue === "string"
          ? thoughtOption.currentValue
          : thoughtOption?.options?.[0]?.value,
      available:
        thoughtOption?.options?.map((option) => ({
          value: option.value,
          label: option.name ?? option.value,
          description: option.description,
        })) ?? [],
    },
    mode: {
      current: normalizeCodezModeForTest(modeOption?.currentValue),
    },
    permission: {
      mode: normalizeCodezModeForTest(modeOption?.currentValue),
    },
  };
}

function createCodezWorkspaceState(
  settings: CodezSessionSettingsState = createCodezSessionSettingsFromConfigOptions(),
): CodezWorkspaceStateSnapshot {
  return {
    workspace: {
      workspacePath: "/tmp/workspace",
      workspaceIdentity: "ssh://host/tmp/workspace",
      workspaceKey: "ssh://host/tmp/workspace",
    },
    settings,
  };
}

export function createCodezSessionService(
  settings: CodezSessionSettingsState = createCodezSessionSettingsFromConfigOptions(),
): ICodezSessionService {
  const workspaceState = createCodezWorkspaceState(settings);
  return {
    initializeWorkspace: vi.fn(async () => ({
      available: true,
      workspaceKey: workspaceState.workspace.workspaceKey,
      protocolName: CODEZ_PROTOCOL_NAME,
      protocolVersion: CODEZ_PROTOCOL_VERSION,
      transportKind: "stdio",
    })),
    readWorkspacePresentation: vi.fn(async () => ({
      workspace: workspaceState.workspace,
      mode: workspaceState.settings.mode.current,
      slashCommands: [],
    })),
    updateProviderRegistry: vi.fn(async () => ({
      applied: true,
      revision: "test-provider-registry",
    })),
  } as unknown as ICodezSessionService;
}

export function createBotsService(
  deps: Omit<
    Parameters<typeof createBotsServiceImpl>[0],
    "codezSessionService" | "codezTaskService"
  > & {
    codezTaskService?: ICodezTaskService;
    /** 旧测试名保留为别名；真实注入的是 Codez task service。 */
    legacyTaskService?: ICodezTaskService;
    codezSessionService?: ICodezSessionService;
  },
): ReturnType<typeof createBotsServiceImpl> {
  const {
    legacyTaskService,
    codezTaskService: providedCodezTaskService,
    codezSessionService: _providedCodezSessionService,
    ...rest
  } = deps;
  const codezTaskService =
    providedCodezTaskService ?? legacyTaskService ?? createLegacyTaskService();
  const modelSelectionService =
    deps.modelSelectionService ??
    createModelSelectionService([{ id: "glm", name: "GLM", models: ["default"] }]);
  return createBotsServiceImpl({
    // Bots 不再持久化 workspace 候选项；测试默认从 settings.lastWorkspaceSession 提供当前工作区。
    settingService: createSettingService({
      locale: "zh-CN",
      lastWorkspaceSession: [
        {
          kind: "remote",
          workspacePath: "/tmp/workspace",
          workspaceIdentity: "ssh://host/tmp/workspace",
        },
      ],
    }),
    remoteWorkspaceService: {
      isConnected: vi.fn(async () => true),
      ensureConnected: vi.fn(async () => ({ ok: true })),
      getCodezTaskService: vi.fn(async () => codezTaskService),
      getModelSelectionService: vi.fn(async () => modelSelectionService),
    },
    modelSelectionService,
    ...rest,
    codezTaskService,
  });
}

export const baseConfig: BotsConfigFile = {
  version: 3,
  bots: [
    {
      id: "webhook-1",
      name: "Webhook",
      provider: "webhook",
      enabled: true,
      webhookSecretRef: "secret-1",
      allowedWorkspaces: ["*"],
      allowedCommands: defaultUserCommands,
      currentOptions: {},
      replyMode: "assistant_changes",
    },
  ],
};

export const telegramConfig: BotsConfigFile = {
  ...baseConfig,
  bots: [
    {
      ...baseConfig.bots[0]!,
      id: "telegram-1",
      name: "Telegram",
      provider: "telegram",
      credentialRef: "telegram-token",
      webhookSecretRef: undefined,
      providerUserId: "user-1",
      allowedWorkspaces: ["*"],
    },
  ],
};

export const feishuConfig: BotsConfigFile = {
  ...baseConfig,
  bots: [
    {
      ...baseConfig.bots[0]!,
      id: "feishu-1",
      name: "Feishu",
      provider: "feishu",
      credentialRef: "feishu-secret",
      webhookSecretRef: undefined,
      feishuAppId: "cli_xxx",
      providerUserId: "ou_user",
      allowedWorkspaces: ["*"],
    },
  ],
};

export const weixinConfig: BotsConfigFile = {
  ...baseConfig,
  bots: [
    {
      ...baseConfig.bots[0]!,
      id: "weixin-1",
      name: "Weixin",
      provider: "weixin",
      credentialRef: "weixin-token",
      webhookSecretRef: undefined,
      allowedWorkspaces: ["*"],
    },
  ],
};
