import { useEffect, useMemo, useState } from "react";
import type { IServiceAccessor } from "@codez/services";
import { logger } from "@/logger.js";
import { resolveRootProviderStartupMode } from "@/root/rootProviderStartupMode.js";
import type { DataSyncRuntimeMode } from "@/data-sync/domain/codexBackend.js";

export interface DataSyncRuntimeModes {
  /** 本机 Host（推送的 source）。 */
  source: DataSyncRuntimeMode;
  /** 设备 source-settings attachment（推送的 target）。 */
  target: DataSyncRuntimeMode;
}

/**
 * 一端 Host 的运行时事实解析。
 *
 * 复用 UI 既有的唯一解析器 `resolveRootProviderStartupMode`：`agentRuntimeMode === "codex"` 才算 codex，
 * 字段缺失（旧 Host）或查询失败一律回落 legacy，不猜测、不轮询、不加超时兜底。第一个参数在该解析器里
 * 表示「这是桌面链路，向 Host 读取事实」；数据同步只在桌面端出现（`isSettingsSectionAvailable`），
 * 两端都是桌面链路上的 Host，因此都传 true。
 *
 * 结果只按 services 身份生效：attachment 换代或切换设备后旧响应不再代表当前 Host，回到 pending，
 * 与弹窗 generation 的既有语义同构；data-sync 不缓存第二份后端判定。
 */
function useRuntimeMode(
  services: IServiceAccessor | undefined,
  end: "source" | "target",
): DataSyncRuntimeMode {
  const [resolution, setResolution] = useState<{
    services: IServiceAccessor;
    mode: DataSyncRuntimeMode;
  } | null>(null);
  useEffect(() => {
    if (!services) return undefined;
    let disposed = false;
    void resolveRootProviderStartupMode(true, services.systemService, (error) =>
      logger.warn("[DataSync] 读取 Host 运行时模式失败，按 legacy 处理", {
        end,
        error: error instanceof Error ? error.message : String(error),
      }),
    ).then((mode) => {
      if (!disposed) setResolution({ services, mode });
    });
    return () => {
      disposed = true;
    };
  }, [end, services]);
  return services && resolution?.services === services ? resolution.mode : "pending";
}

/**
 * 数据同步两端各自的 Agent 运行时事实（specs/data-sync-codex-backend.md「判定信号与唯一来源」）。
 *
 * 事实源是各端 Host 的 `systemService.info().agentRuntimeMode`；这里只是把它读出来交给 domain 纯函数
 * 映射成分类可用性。设备离线或 attachment 未就绪时不解析 target（等价于未知 → 不标注、不禁用），
 * 重新上线后随新的 services 身份重新解析。
 */
export function useDataSyncRuntimeModes(params: {
  sourceServices: IServiceAccessor | undefined;
  targetServices?: IServiceAccessor | undefined;
  online?: boolean;
}): DataSyncRuntimeModes {
  const source = useRuntimeMode(params.sourceServices, "source");
  const targetServices = params.online === false ? undefined : params.targetServices;
  const target = useRuntimeMode(targetServices, "target");
  return useMemo(() => ({ source, target }), [source, target]);
}
