import { z } from "zod";
import type { CommandAgentSource } from "./command-types.js";
import type { CodezProvider } from "./codez-task-types-core.js";

export const CODEZ_AGENT_PROVIDER = "glm" satisfies CodezProvider;
export const CODEZ_AGENT_PROVIDER_LABEL = "Codez Agent";
export const CODEZ_COMMAND_AGENT_SOURCE = "codezAgent" satisfies CommandAgentSource;

/**
 * 解析持久化/relay 数据时的 provider 归一 schema：
 * 已移除的第三方 provider 历史值仅作为归一化输入保留，统一收敛为 glm；
 * 其它非法值保持拒绝，与收窄前的校验边界一致。
 */
export const legacyCodezProviderSchema = z
  .enum(["claude", "opencode", "gemini", "codex", "glm"])
  .transform((): typeof CODEZ_AGENT_PROVIDER => CODEZ_AGENT_PROVIDER);

export const CODEZ_ENABLED_AGENT_PROVIDERS = [
  CODEZ_AGENT_PROVIDER,
] as const satisfies readonly CodezProvider[];

export const CODEZ_COMMAND_AGENT_SOURCES = [
  CODEZ_COMMAND_AGENT_SOURCE,
] as const satisfies readonly CommandAgentSource[];

export function normalizeAgentProviderToCodezAgent(
  _provider?: CodezProvider | null,
): CodezProvider {
  return CODEZ_AGENT_PROVIDER;
}

export function normalizeAgentProvidersToCodezAgent(
  _providers?: ReadonlyArray<CodezProvider> | null,
): CodezProvider[] {
  return [...CODEZ_ENABLED_AGENT_PROVIDERS];
}

export function normalizeCommandAgentSourceToCodezAgent(
  _agentSource?: CommandAgentSource | null,
): CommandAgentSource {
  return CODEZ_COMMAND_AGENT_SOURCE;
}

export function isCodezAgentProvider(
  provider: CodezProvider | null | undefined,
): provider is typeof CODEZ_AGENT_PROVIDER {
  return provider === CODEZ_AGENT_PROVIDER;
}
