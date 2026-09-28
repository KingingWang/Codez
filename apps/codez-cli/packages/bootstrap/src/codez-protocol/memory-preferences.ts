import { codezWorkspaceUpdateMemoryPreferencesParamsSchema } from "@codez/shared";
import type { ModelSelection } from "@codez/shared";
import {
  parseParams,
  type CodezProtocolAgentServerContext,
  type CodezProtocolSessionRecord,
} from "./server-types.js";

/** Host 记忆偏好快照；单键 undefined = Host 未控制该键，回落 CLI 本地配置。 */
export interface HostMemoryPreferences {
  memoryEnabled?: boolean;
  useEnabled?: boolean;
  extractionEnabled?: boolean;
  extractionModel?: ModelSelection | null;
}

/**
 * 按 host && local（布尔）/ host ?? local（模型）计算 effective 记忆配置并应用到会话 runtime。
 * CLI 本地显式禁用（config.json 的 features.memory / memory.use / memory.extractionEnabled=false）
 * 不会被 Host 的开启值反向覆盖，与 createRecord 启动语义一致。
 */
export async function applyHostMemoryPreferencesToRecord(
  record: CodezProtocolSessionRecord,
  host: HostMemoryPreferences,
): Promise<void> {
  const local = record.localMemoryConfig;
  const enabled = (host.memoryEnabled ?? true) && local.enabled !== false;
  const use = (host.useEnabled ?? true) && local.use !== false;
  const extractionEnabled =
    (host.extractionEnabled ?? true) && local.extractionEnabled !== false;
  const extractionModel = host.extractionModel ?? local.extractionModel;
  record.memoryEnabled = enabled;
  await record.app.runtime.applyMemoryRuntimeConfig({
    enabled,
    use,
    extractionEnabled,
    extractionModel,
  });
}

/**
 * Memory 偏好是 App 全局设置，但每个 resident session 持有独立 runtime。
 * 与 ModelIO 同一模式：协议层缓存偏好供后续会话继承，并立即更新已有会话，
 * 避免「改完要重启 server 才生效」。
 */
export async function updateMemoryPreferences(
  context: CodezProtocolAgentServerContext,
  rawParams: unknown,
) {
  const params = parseParams(codezWorkspaceUpdateMemoryPreferencesParamsSchema, rawParams);
  const host: HostMemoryPreferences = {
    memoryEnabled: params.preferences.memoryEnabled,
    useEnabled: params.preferences.useEnabled,
    extractionEnabled: params.preferences.extractionEnabled,
    extractionModel: params.preferences.extractionModel ?? null,
  };
  context.appRuntimePreferences.memory = host;

  let updatedSessionCount = 0;
  for (const record of context.sessions.values()) {
    try {
      await applyHostMemoryPreferencesToRecord(record, host);
      updatedSessionCount += 1;
    } catch (error) {
      // 单个会话热应用失败（如记忆目录 IO）不能阻断其余会话；下一次推送仍会重试。
      context.logger?.warn("Memory preferences apply failed for session", {
        event: "codez_protocol.memory_preferences.apply_failed",
        module: "bootstrap.codez_protocol",
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return {
    workspace: params.workspace,
    updatedSessionCount,
  };
}
