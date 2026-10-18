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

interface PluginManagementServiceDependencies {
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
    addPluginMarketplace: (params) => agent.addPluginMarketplace(params),
    removePluginMarketplace: (params) => agent.removePluginMarketplace(params),
    updatePluginMarketplace: (params) => agent.updatePluginMarketplace(params),
    installPlugin: (params) => agent.installPlugin(params),
    cancelPluginOperation: (params) => agent.cancelPluginOperation(params),
    uninstallPlugin: (params) => agent.uninstallPlugin(params),
    updatePlugin: (params) => agent.updatePlugin(params),
    restoreBuiltinPlugin: (params) => agent.restoreBuiltinPlugin(params),
    configurePlugin: (params) => agent.configurePlugin(params),
    resetPluginConfig: (params) => agent.resetPluginConfig(params),
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
          : await agent.setPluginEnabled(params);
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
