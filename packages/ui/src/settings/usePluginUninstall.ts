import { useCallback, useMemo, useState } from "react";
import type { CodezInstalledPluginSummary, CodezPluginInfo } from "@codez/shared";
import type { IPluginManagementService } from "@codez/services";
import { usePluginManagementStore } from "@/store/pluginManagementStore.js";

interface UsePluginUninstallInput {
  pluginService: IPluginManagementService;
  installedPlugins: CodezInstalledPluginSummary[];
  plugins: CodezPluginInfo[];
  operationId: string | null;
  // 卸载会让插件提供的技能/命令失效，调用方传入统一的「能力变更后刷新」收尾逻辑。
  onAfterUninstall: () => Promise<void>;
}

interface PluginUninstallController {
  pendingPlugin: CodezPluginInfo | CodezInstalledPluginSummary | null;
  uninstalling: boolean;
  requestUninstall: (pluginId: string) => void;
  cancelUninstall: () => void;
  confirmUninstall: () => Promise<void>;
}

interface ConfirmPluginUninstallInput {
  pendingId: string | null;
  pluginService: IPluginManagementService;
  uninstallPlugin: (pluginId: string, pluginService: IPluginManagementService) => Promise<boolean>;
  clearPending: () => void;
  onAfterUninstall: () => Promise<void>;
}

export async function confirmPluginUninstall({
  pendingId,
  pluginService,
  uninstallPlugin,
  clearPending,
  onAfterUninstall,
}: ConfirmPluginUninstallInput): Promise<boolean> {
  if (!pendingId) return false;
  // 卸载失败时保留确认弹窗，让插件管理 store 的错误继续可见且用户可直接重试。
  const succeeded = await uninstallPlugin(pendingId, pluginService);
  if (!succeeded) return false;
  await onAfterUninstall();
  clearPending();
  return true;
}

/**
 * 集中管理插件卸载的确认流程：UI 各入口（已安装详情、市场面板）都通过它发起卸载，
 * 共用同一份 pending 状态、确认弹窗目标解析与卸载收尾逻辑。
 */
export function usePluginUninstall({
  pluginService,
  installedPlugins,
  plugins,
  operationId,
  onAfterUninstall,
}: UsePluginUninstallInput): PluginUninstallController {
  const uninstallPlugin = usePluginManagementStore((state) => state.uninstallPlugin);
  const [pendingId, setPendingId] = useState<string | null>(null);

  const pendingPlugin = useMemo(() => {
    if (!pendingId) return null;
    return (
      installedPlugins.find((item) => item.id === pendingId) ??
      plugins.find((item) => item.id === pendingId) ??
      null
    );
  }, [installedPlugins, pendingId, plugins]);

  const uninstalling = pendingId !== null && operationId === `plugin:uninstall:${pendingId}`;

  const requestUninstall = useCallback((pluginId: string) => {
    setPendingId(pluginId);
  }, []);

  const cancelUninstall = useCallback(() => {
    setPendingId(null);
  }, []);

  const confirmUninstall = useCallback(async () => {
    await confirmPluginUninstall({
      pendingId,
      pluginService,
      uninstallPlugin,
      clearPending: () => setPendingId(null),
      onAfterUninstall,
    });
  }, [onAfterUninstall, pendingId, pluginService, uninstallPlugin]);

  return { pendingPlugin, uninstalling, requestUninstall, cancelUninstall, confirmUninstall };
}
