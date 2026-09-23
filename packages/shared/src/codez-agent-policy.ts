import { z } from "zod";
import type { CommandAgentSource } from "./command-types.js";
import type { CodezProvider } from "./codez-task-types-core.js";

export const CODEZ_AGENT_PROVIDER = "glm" satisfies CodezProvider;
export const CODEZ_AGENT_PROVIDER_LABEL = "Codez Agent";
export const CODEZ_COMMAND_AGENT_SOURCE = "codezAgent" satisfies CommandAgentSource;

export const codezAgentProviderSchema = z.literal(CODEZ_AGENT_PROVIDER);

export const CODEZ_COMMAND_AGENT_SOURCES = [
  CODEZ_COMMAND_AGENT_SOURCE,
] as const satisfies readonly CommandAgentSource[];

export function normalizeAgentProviderToCodezAgent(
  _provider?: CodezProvider | null,
): CodezProvider {
  return CODEZ_AGENT_PROVIDER;
}

export function isCodezAgentProvider(
  provider: CodezProvider | null | undefined,
): provider is typeof CODEZ_AGENT_PROVIDER {
  return provider === CODEZ_AGENT_PROVIDER;
}
