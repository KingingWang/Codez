import { useCallback } from "react";
import { resolveCodexTitleModel, type CodexTitleModel } from "@codez/shared";
import { logger } from "@/logger.js";
import { useServices } from "./useServices.js";

/** SettingService is the preference authority; the renderer carries only this submission's choice. */
export function useCodexTitleModel(
  workspacePath: string,
  workspaceIdentity?: string,
): () => Promise<CodexTitleModel | undefined> {
  const { settingService } = useServices();
  return useCallback(async () => {
    try {
      return resolveCodexTitleModel(await settingService.get(), workspacePath, workspaceIdentity);
    } catch (error) {
      // 设置读取失败不能拒绝原本的用户输入；缺少选择时桥接不会启动标题任务。
      // 修复依据：桥接侧只会报 arm/missing-selection，无法区分“渲染端没读到设置”和
      // “该客户端根本不带选择”。这里补一条生产可见的有界告警（只记错误摘要，不含设置内容），
      // 让导出日志能定位到渲染端这一跳。
      logger.lifecycle.warn("[codex-title] 读取标题模型设置失败，本次提交不会触发自动命名", {
        error: error instanceof Error ? error.message : String(error),
      });
      return undefined;
    }
  }, [settingService, workspacePath, workspaceIdentity]);
}
