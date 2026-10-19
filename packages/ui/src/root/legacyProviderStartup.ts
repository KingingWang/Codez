import { logger } from "@/logger.js";

interface LegacyProviderStartup {
  migrate: () => Promise<void>;
  isCurrent: () => boolean;
  markMigrationComplete: () => void;
  refreshAppSettings: () => Promise<void>;
  refreshProviderState: () => Promise<void>;
}

/** Root 的旧 Provider 启动顺序；每次 await 后确认此 Host 的 effect 仍持有路径。 */
export async function startRootLegacyProviderStartup({
  migrate,
  isCurrent,
  markMigrationComplete,
  refreshAppSettings,
  refreshProviderState,
}: LegacyProviderStartup): Promise<void> {
  try {
    await migrate();
  } catch (error) {
    logger.warn("[Root] provider family domain 迁移失败，继续启动", { error });
  }
  if (!isCurrent()) return;
  markMigrationComplete();
  try {
    await refreshAppSettings();
    // settings 的 RPC 等待期间可能已切换到原生 Codex；旧 effect 不得再调用 Provider。
    if (!isCurrent()) return;
    await refreshProviderState();
  } catch (error) {
    logger.warn("[Root] provider family domain 迁移后刷新状态失败", { error });
  }
}
