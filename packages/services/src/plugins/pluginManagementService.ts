import {
  collectTelemetryRendererContext,
  resolveWorkspaceTelemetryDetail,
  type RendererTelemetryEventPayload,
} from "@codez/shared";
// 设置页插件管理薄服务实现——plugins/* 旧协议词的唯一 host 侧消费点。
// 插件安装/市场/启停的事实源在 codez-cli 进程（读写 ~/.codez 插件目录并热更新
// 运行态），host 无副本，故实现保持 agent 协议往返；收敛价值在 UI 层不再直触
// ICodezAgentService，词表消费面从 UI 散点收拢到本文件一处。
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { isOfficialCuaPluginEnabledForWorkspace } from "@codez/codez-cua/broker/server";
import {
  CODEZ_CUA_OFFICIAL_PLUGIN_ID,
  CODEZ_NATIVE_BROWSER_CUA_MCP_SERVER_NAME,
  CODEZ_OFFICIAL_PLUGIN_MARKETPLACE_ID,
  isRemoteWorkspaceIdentity,
  type CodezInstalledPluginSummary,
  type CodezPluginInfo,
} from "@codez/shared";
import { createServiceLogger } from "../logger/serviceLogger.js";
import { getCodezDataRootDir } from "../paths.js";
import type { ICodezAgentService } from "../codez-agent/codezAgent.js";
import type { IPluginManagementService } from "./pluginManagement.js";
import {
  CODEX_NATIVE_CUA_SKILL_DESCRIPTION,
  CODEX_NATIVE_CUA_SKILL_NAME,
  syncCodexNativeCuaSkill,
} from "./codexNativeCuaSkill.js";

const logger = createServiceLogger("plugin-management");
const LEGACY_CUA_PLUGIN_ID = `codez-cua@${CODEZ_OFFICIAL_PLUGIN_MARKETPLACE_ID}`;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isRemoteTarget(params: {
  remoteSessionId?: string | null;
  workspaceIdentity?: string;
}): boolean {
  return Boolean(
    params.remoteSessionId ||
    (params.workspaceIdentity?.trim() &&
      isRemoteWorkspaceIdentity(params.workspaceIdentity.trim())),
  );
}

function resolveCliUserConfigPath(env: NodeJS.ProcessEnv = process.env): string {
  const home = env.CODEZ_HOME?.trim() || getCodezDataRootDir() || join(homedir(), ".codez");
  return join(home, "cli", "config.json");
}

async function persistOfficialCuaPluginEnabled(
  enabled: boolean,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const configPath = resolveCliUserConfigPath(env);
  let parsed: Record<string, unknown> = {};
  try {
    const raw = await readFile(configPath, "utf8");
    const candidate: unknown = JSON.parse(raw);
    if (isRecord(candidate)) {
      parsed = candidate;
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") {
      throw error;
    }
  }
  const plugins = isRecord(parsed.plugins) ? parsed.plugins : {};
  const enabledPlugins = isRecord(plugins.enabledPlugins) ? { ...plugins.enabledPlugins } : {};
  delete enabledPlugins[LEGACY_CUA_PLUGIN_ID];
  enabledPlugins[CODEZ_CUA_OFFICIAL_PLUGIN_ID] = enabled;
  const next = {
    ...parsed,
    plugins: {
      ...plugins,
      ...(typeof plugins.enabled === "boolean" ? {} : { enabled: true }),
      enabledPlugins,
    },
  };
  await mkdir(dirname(configPath), { recursive: true });
  const tempPath = `${configPath}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(tempPath, `${JSON.stringify(next, null, 2)}\n`, "utf8");
  await rename(tempPath, configPath);
}

function buildSyntheticCuaPluginInfo(enabled: boolean): CodezPluginInfo {
  return {
    id: CODEZ_CUA_OFFICIAL_PLUGIN_ID,
    name: "computer-use",
    marketplace: CODEZ_OFFICIAL_PLUGIN_MARKETPLACE_ID,
    description:
      "Computer Use: automate desktop apps with mouse, keyboard, and UI element control.",
    version: "0.1.0",
    enabled,
    source: "builtin",
    skillCount: 1,
    skillRootCount: 1,
    commandRootCount: 0,
    components: [
      {
        kind: "skill",
        items: [
          {
            name: CODEX_NATIVE_CUA_SKILL_NAME,
            description: CODEX_NATIVE_CUA_SKILL_DESCRIPTION,
          },
        ],
      },
      {
        kind: "mcp",
        items: [{ name: CODEZ_NATIVE_BROWSER_CUA_MCP_SERVER_NAME }],
      },
    ],
    mcpServerNames: [CODEZ_NATIVE_BROWSER_CUA_MCP_SERVER_NAME],
    rootPath: "",
    enabledSource: "user",
  };
}

function buildSyntheticCuaInstalledSummary(enabled: boolean): CodezInstalledPluginSummary {
  return {
    id: CODEZ_CUA_OFFICIAL_PLUGIN_ID,
    name: "computer-use",
    marketplace: CODEZ_OFFICIAL_PLUGIN_MARKETPLACE_ID,
    description:
      "Computer Use: automate desktop apps with mouse, keyboard, and UI element control.",
    version: "0.1.0",
    enabled,
    scope: "user",
    listing: {
      displayName: "Computer Use",
      displayNameI18n: { "zh-CN": "电脑控制" },
      descriptionI18n: {
        "zh-CN": "自动化桌面应用：智能体驱动鼠标、键盘与界面元素，代你完成实际任务。",
      },
      category: "productivity",
    },
  };
}

export interface PluginManagementServiceDependencies {
  reportTelemetryEvent?: (event: RendererTelemetryEventPayload) => void | Promise<void>;
  now?: () => number;
  codezAgentService: Pick<
    ICodezAgentService,
    | "listPlugins"
    | "getPluginReferenceCatalog"
    | "resolveSuggestedPluginReference"
    | "onDynamicPluginOperationProgress"
    | "getPluginsOverview"
    | "addPluginMarketplace"
    | "removePluginMarketplace"
    | "updatePluginMarketplace"
    | "installPlugin"
    | "cancelPluginOperation"
    | "uninstallPlugin"
    | "updatePlugin"
    | "restoreBuiltinPlugin"
    | "configurePlugin"
    | "resetPluginConfig"
    | "validatePlugin"
    | "describePlugin"
    | "setPluginEnabled"
    | "disposeWorkspace"
  >;
  disposeActiveWorkspaceRuntimes?: (params: {
    reason: string;
    includeLegacy?: boolean;
  }) => Promise<void>;
  /**
   * Codex 桌面桥模式下，Computer Use 走原生 `codez-desktop-browser-cua` MCP 注入而非
   * Codex 插件市场安装；由本服务投影并持久化 `cli/config.json` 中的官方开关事实。
   */
  codexNativeCuaMode?: boolean;
  env?: NodeJS.ProcessEnv;
}

export function createPluginManagementService(
  dependencies: PluginManagementServiceDependencies,
): IPluginManagementService {
  const agent = dependencies.codezAgentService;
  const now = dependencies.now ?? Date.now;
  type Params =
    import("../codez-agent/codezAgentPluginParams.js").CodezAgentPluginMutationTarget & {
      pluginId?: string;
      pluginName?: string;
      marketplace?: string;
      scope?: "user" | "workspace";
      dryRun?: boolean;
      removeCache?: boolean;
    };
  type Result = {
    diagnostics?: Array<{ severity?: string; code?: string }>;
    installedPlugins?: Array<{
      id: string;
      marketplace: string;
      version?: string;
      scope: string;
      listing?: { publisherType?: string };
    }>;
    removedPlugin?: { id: string; marketplace: string; version?: string };
    pluginId?: string;
    marketplaces?: unknown[];
    marketplace?: { id: string };
    plugin?: { id: string; marketplace: string; source: string; version?: string };
  };
  const report = (
    action: string,
    params: Params,
    startedAt: number,
    result?: Result,
    error?: unknown,
  ) => {
    if (params.dryRun || !dependencies.reportTelemetryEvent) return;
    const diagnostics = result?.diagnostics ?? [];
    const hasError = diagnostics.some((item) => item.severity === "error");
    // JSON-RPC 保留原始异常类型在 data.name；不能用取消请求的 ACK 或错误文案推断。
    const errorData =
      error instanceof Error && "data" in error && error.data && typeof error.data === "object"
        ? (error.data as { name?: unknown; code?: unknown })
        : undefined;
    const cancelled =
      errorData?.name === "AbortError" ||
      errorData?.code === "plugin_operation_cancelled" ||
      (error instanceof Error &&
        (error.name === "AbortError" ||
          ("code" in error && error.code === "plugin_operation_cancelled"))) ||
      diagnostics.some((item) => item.code === "plugin_operation_cancelled");
    const pluginId =
      params.pluginId ??
      (params.pluginName && params.marketplace
        ? `${params.pluginName}@${params.marketplace}`
        : result?.pluginId);
    const installed = result?.installedPlugins?.find((item) => item.id === pluginId);
    const status = cancelled
      ? "cancelled"
      : error
        ? "failure"
        : hasError
          ? action === "update" && !params.pluginId && result?.installedPlugins?.length
            ? "partial"
            : "failure"
          : action === "uninstall" && !result?.removedPlugin
            ? "noop"
            : action === "install" && !installed
              ? "failure"
              : action === "update" && !result?.installedPlugins?.length
                ? "noop"
                : "success";
    const detail: Record<string, string> = {
      schema_version: "1",
      action,
      result: status,
      duration_ms: String(Math.max(0, now() - startedAt)),
      entry: params.telemetry?.entry ?? "unknown",
      trigger: params.telemetry?.trigger ?? "user",
      client_kind: params.telemetry?.client_kind ?? "unknown",
      scope: params.scope ?? installed?.scope ?? "unknown",
      ...resolveWorkspaceTelemetryDetail(params),
      ...(pluginId || result?.removedPlugin
        ? { plugin_id: pluginId ?? result!.removedPlugin!.id }
        : {}),
      ...(params.marketplace || installed || result?.removedPlugin || result?.marketplace
        ? {
            marketplace:
              params.marketplace ??
              installed?.marketplace ??
              result?.removedPlugin?.marketplace ??
              result!.marketplace!.id,
          }
        : {}),
      ...(installed?.version ? { version_after: installed.version } : {}),
      ...(result?.removedPlugin?.version ? { version_before: result.removedPlugin.version } : {}),
      ...(installed?.listing?.publisherType
        ? { publisher_type: installed.listing.publisherType }
        : {}),
      ...(action === "uninstall" ? { remove_cache: String(params.removeCache ?? true) } : {}),
      ...(status === "failure" || status === "partial" || status === "cancelled"
        ? { error_category: cancelled ? "cancelled" : hasError ? "diagnostic" : "transport" }
        : {}),
    };
    // 上报只观察最终结果，不等待网络，失败不得改变原业务返回或触发业务重试。
    try {
      void Promise.resolve(
        dependencies.reportTelemetryEvent({
          elementName: "plugin_lifecycle",
          eventRegion: "app",
          eventType: "result",
          context: collectTelemetryRendererContext(),
          eventExtraDetail: detail,
        }),
      ).catch(() => {});
    } catch {
      /* 观测端故障与业务隔离。 */
    }
  };
  const observe = async <T extends Result>(
    action: string,
    params: Params,
    invoke: (clean: Params) => Promise<T>,
  ): Promise<T> => {
    const startedAt = now();
    const { telemetry: _telemetry, ...clean } = params;
    try {
      const result = await invoke(clean);
      report(action, params, startedAt, result);
      return result;
    } catch (error) {
      report(action, params, startedAt, undefined, error);
      throw error;
    }
  };
  const codexNativeCuaMode = dependencies.codexNativeCuaMode === true;
  const env = dependencies.env ?? process.env;
  const readLocalCuaEnabled = (workspacePath?: string): boolean =>
    isOfficialCuaPluginEnabledForWorkspace({
      env,
      userConfigPath: resolveCliUserConfigPath(env),
      workingDirectory: workspacePath,
    });
  const syncLocalCuaSkillBestEffort = async (enabled: boolean): Promise<void> => {
    try {
      await syncCodexNativeCuaSkill(enabled, env);
    } catch (error) {
      logger.warn(undefined, "Failed to synchronize Codex Computer Use skill file", {
        enabled,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  };
  return {
    listPlugins: async (params) => {
      const result = await agent.listPlugins(params);
      if (
        !codexNativeCuaMode ||
        isRemoteTarget(params) ||
        result.plugins.some((plugin) => plugin.id === CODEZ_CUA_OFFICIAL_PLUGIN_ID)
      ) {
        return result;
      }
      const enabled = readLocalCuaEnabled(params.workspacePath);
      await syncLocalCuaSkillBestEffort(enabled);
      return {
        ...result,
        plugins: [...result.plugins, buildSyntheticCuaPluginInfo(enabled)],
      };
    },
    getPluginReferenceCatalog: (params) => agent.getPluginReferenceCatalog(params),
    resolveSuggestedPluginReference: (params) => agent.resolveSuggestedPluginReference(params),
    onDynamicPluginOperationProgress: (operationId) =>
      agent.onDynamicPluginOperationProgress(operationId),
    getPluginsOverview: async (params) => {
      const result = await agent.getPluginsOverview(params);
      if (
        !codexNativeCuaMode ||
        isRemoteTarget(params) ||
        result.installedPlugins.some((plugin) => plugin.id === CODEZ_CUA_OFFICIAL_PLUGIN_ID)
      ) {
        return result;
      }
      const enabled = readLocalCuaEnabled(params.workspacePath);
      await syncLocalCuaSkillBestEffort(enabled);
      return {
        ...result,
        installedPlugins: [...result.installedPlugins, buildSyntheticCuaInstalledSummary(enabled)],
      };
    },
    addPluginMarketplace: (params) =>
      observe("source_add", params, (clean) => agent.addPluginMarketplace(clean as typeof params)),
    removePluginMarketplace: (params) =>
      observe("source_remove", params, (clean) =>
        agent.removePluginMarketplace(clean as typeof params),
      ),
    updatePluginMarketplace: (params) =>
      observe("source_refresh", params, (clean) =>
        agent.updatePluginMarketplace(clean as typeof params),
      ),
    installPlugin: (params) =>
      observe("install", params, (clean) => agent.installPlugin(clean as typeof params)),
    cancelPluginOperation: (params) => agent.cancelPluginOperation(params),
    uninstallPlugin: (params) =>
      observe("uninstall", params, (clean) => agent.uninstallPlugin(clean as typeof params)),
    updatePlugin: (params) =>
      observe("update", params, (clean) => agent.updatePlugin(clean as typeof params)),
    restoreBuiltinPlugin: (params) =>
      observe("restore", params, (clean) => agent.restoreBuiltinPlugin(clean as typeof params)),
    configurePlugin: (params) =>
      observe("configure", params, (clean) => agent.configurePlugin(clean as typeof params)),
    resetPluginConfig: (params) =>
      observe("reset_config", params, (clean) => agent.resetPluginConfig(clean as typeof params)),
    validatePlugin: (params) => agent.validatePlugin(params),
    describePlugin: (params) => agent.describePlugin(params),
    setPluginEnabled: async (params) => {
      const isCuaPlugin = params.pluginId.trim().toLowerCase() === CODEZ_CUA_OFFICIAL_PLUGIN_ID;
      const result =
        codexNativeCuaMode && isCuaPlugin && !isRemoteTarget(params)
          ? await (async () => {
              await persistOfficialCuaPluginEnabled(params.enabled, env);
              await syncLocalCuaSkillBestEffort(params.enabled);
              return {
                plugin: buildSyntheticCuaPluginInfo(params.enabled),
                enabled: params.enabled,
              };
            })()
          : await observe(params.enabled ? "enable" : "disable", params, (clean) =>
              agent.setPluginEnabled(clean as typeof params),
            );
      if (!isCuaPlugin) {
        return result;
      }

      try {
        // Computer Use 的 runtime feature 与 Helper tuple 都在 workspace Agent 启动时冻结。
        // 过去只落盘开关，预热过的 Agent 会继续沿用旧工具集；写入成功后精确推进该
        // workspace runtime，下一次请求才能按新配置重建，同时不触碰管理 lane 与 Helper owner。
        if (
          codexNativeCuaMode &&
          !isRemoteTarget(params) &&
          dependencies.disposeActiveWorkspaceRuntimes
        ) {
          await dependencies.disposeActiveWorkspaceRuntimes({
            reason: "computerUseEnabled",
          });
        } else {
          await agent.disposeWorkspace({
            workspacePath: params.workspacePath,
            ...(params.workspaceIdentity ? { workspaceIdentity: params.workspaceIdentity } : {}),
            ...(params.remoteSessionId ? { remoteSessionId: params.remoteSessionId } : {}),
          });
        }
      } catch (error) {
        // 配置已由 Agent 持久化，且 dispose 会先移除旧 client、推进 generation 再清理进程。
        // 清理尾声失败不能把 UI 回滚成旧配置；保留成功事实并记录可诊断告警。
        logger.warn(
          undefined,
          "Computer Use toggle persisted but workspace cleanup reported an error",
          {
            enabled: params.enabled,
            error: error instanceof Error ? error.message : String(error),
          },
        );
      }
      return result;
    },
  };
}
