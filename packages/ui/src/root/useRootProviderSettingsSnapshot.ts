import { useEffect } from "react";
import type { IServiceAccessor } from "@codez/services";
import { connectProviderSettingsSnapshot } from "@/lib/providerSettingsSnapshot.js";
import { logger } from "@/logger.js";

export function useRootProviderSettingsSnapshot(
  services: IServiceAccessor,
  enabled: boolean,
): void {
  useEffect(() => {
    // Root 未收到 Host 选型或已选原生 Codex 时，旧 View 不能抢先启动 Provider Runtime。
    if (!enabled) return;
    const service = services.providerSettingsService;
    if (!service) return;

    const connection = connectProviderSettingsSnapshot(service);
    void connection.ready.catch((error) => {
      logger.warn("[Root] 加载 Provider Settings View 失败", {
        error,
      });
    });
    return () => connection.dispose();
  }, [enabled, services.providerSettingsService]);
}
