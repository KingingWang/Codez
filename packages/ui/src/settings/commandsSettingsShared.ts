import {
  CODEZ_AGENT_PROVIDER,
  CODEZ_COMMAND_AGENT_SOURCES,
  type CodezProvider,
  type CommandAgentSource,
} from "@codez/shared";

export const COMMAND_AGENT_SOURCES = [
  ...CODEZ_COMMAND_AGENT_SOURCES,
] as const satisfies readonly CommandAgentSource[];

export const COMMAND_AGENT_SOURCE_META: Record<
  CommandAgentSource,
  {
    labelId: string;
    provider: CodezProvider;
    pathHint: string;
  }
> = {
  codezAgent: {
    labelId: "settings.commands.source.codezAgent",
    pathHint: "~/.codez/commands",
    provider: CODEZ_AGENT_PROVIDER,
  },
};
