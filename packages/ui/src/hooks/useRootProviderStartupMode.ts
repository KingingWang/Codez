import { useEffect, useState } from "react";
import type { ISystemService } from "@codez/services";
import { useServices } from "./useServices.js";
import {
  resolveRootProviderStartupMode,
  type RootProviderStartupMode,
} from "@/root/rootProviderStartupMode.js";

/** 只从当前 Host 读取运行时事实；换 Host 后旧响应不能启动新 Host 的旧 Provider 路径。 */
export function useRootProviderStartupMode(
  isDesktop: boolean,
): RootProviderStartupMode | "pending" {
  const { systemService } = useServices();
  const [resolution, setResolution] = useState<{
    systemService: ISystemService;
    mode: RootProviderStartupMode;
  } | null>(null);
  const mode = !isDesktop
    ? "legacy"
    : resolution?.systemService === systemService
      ? resolution.mode
      : "pending";
  useEffect(() => {
    if (!isDesktop) return;
    let disposed = false;
    void resolveRootProviderStartupMode(true, systemService).then((nextMode) => {
      if (!disposed) setResolution({ systemService, mode: nextMode });
    });
    return () => {
      disposed = true;
    };
  }, [isDesktop, systemService]);
  return mode;
}
