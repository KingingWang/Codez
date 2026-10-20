import type { ISystemService } from "@codez/services";
import { logger } from "@/logger.js";

export type RootProviderStartupMode = "codex" | "legacy";

/**
 * Host 已按 command resolver 选好真实运行时；Renderer 只读取结果。
 * 旧 Host 不提供该字段或查询失败时保留此前的 Provider 启动行为。
 */
export async function resolveRootProviderStartupMode(
  isDesktop: boolean,
  systemService: Pick<ISystemService, "info">,
  onFailure: (error: unknown) => void = (error) =>
    logger.warn("[Root] 无法读取 Host 运行时模式，保留旧 Provider 启动路径", { error }),
): Promise<RootProviderStartupMode> {
  if (!isDesktop) return "legacy";
  try {
    const { agentRuntimeMode } = await systemService.info();
    return agentRuntimeMode === "codex" ? "codex" : "legacy";
  } catch (error) {
    onFailure(error);
    return "legacy";
  }
}
