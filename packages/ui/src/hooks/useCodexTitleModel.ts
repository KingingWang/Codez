import { useCallback } from "react";
import { resolveCodexTitleModel, type CodexTitleModel } from "@codez/shared";
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
    } catch {
      // 设置读取失败不能拒绝原本的用户输入；缺少选择时桥接不会启动标题任务。
      return undefined;
    }
  }, [settingService, workspacePath, workspaceIdentity]);
}
