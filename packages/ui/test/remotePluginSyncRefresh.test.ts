import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CommandsListResult, CodezCommand } from "@codez/shared";
import { CODEZ_AGENT_PROVIDER } from "@codez/shared";
import { refreshWorkspacePluginCapabilitiesAfterRemoteSync } from "../src/lib/remotePluginSyncRefresh.js";
import { useCommandsStore } from "../src/store/commandsStore.js";
import { useSkillStore } from "../src/store/skillStore.js";
import { useCodezSessionStore } from "../src/store/codezSessionStore.js";

function makePluginCommand(
  overrides: Partial<Extract<CodezCommand, { source: "plugin" }>>,
): Extract<CodezCommand, { source: "plugin" }> {
  return {
    id: "plugin:team-market:hello-world:hello:/remote/commands/hello.md",
    name: "hello",
    prompt: "Say hello",
    content: "# hello",
    filePath: "/remote/commands/hello.md",
    source: "plugin",
    enabled: true,
    pluginName: "hello-world",
    pluginMarketplace: "team-market",
    pluginEnabled: true,
    scope: "global",
    ...overrides,
  };
}

beforeEach(() => {
  useCodezSessionStore.setState((state) => ({
    ...state,
    workspaces: {},
  }));
  useCommandsStore.setState({
    workspacePath: null,
    workspaceIdentity: null,
    loadedWorkspacePath: null,
    loadedWorkspaceIdentity: null,
    commands: [],
    userCommands: [],
    pluginCommands: [],
    capability: { userScopeAvailable: true },
    loading: false,
    error: null,
    operatingCommandId: null,
  });
  useSkillStore.setState({
    workspacePath: null,
    workspaceIdentity: null,
    loadedWorkspacePath: null,
    loadedWorkspaceIdentity: null,
    provider: CODEZ_AGENT_PROVIDER,
    loadedProvider: null,
    skills: [],
    capability: null,
    loading: false,
    error: null,
  });
});

describe("refreshWorkspacePluginCapabilitiesAfterRemoteSync", () => {
  it("refreshes slash commands even when commands settings store was not loaded", async () => {
    const workspacePath = "/Users/dev";
    const workspaceIdentity = "remote:ssh:intranet.example.invalid:22:dev:/Users/dev";
    useCodezSessionStore.getState().setSlashCommands(
      workspacePath,
      [
        {
          name: "compact",
          description: "Compact",
          inputHint: "/compact [instructions]",
          source: "builtin",
        },
        {
          name: "old-plugin",
          description: "Old plugin command",
          inputHint: "/old-plugin",
          source: "custom",
        },
      ],
      workspaceIdentity,
    );
    const helloCommand = makePluginCommand({
      name: "hello",
      description: "Hello plugin command",
    });
    const commandsResult: CommandsListResult = {
      commands: [helloCommand],
      userCommands: [],
      pluginCommands: [helloCommand],
      capability: { userScopeAvailable: true },
    };
    const commandsService = {
      list: vi.fn(async () => commandsResult),
    };

    await refreshWorkspacePluginCapabilitiesAfterRemoteSync({
      workspacePath,
      workspaceIdentity,
      reason: "sidebar-remote-plugin-sync",
      codezAgentService: {} as never,
      codezSessionService: { closeSession: vi.fn(async () => {}) } as never,
      skillsService: { list: vi.fn() } as never,
      commandsService: commandsService as never,
      mcpSyncService: {
        loadMcpFromUserDirectory: vi.fn(async () => ({ servers: [] })),
      } as never,
    });

    expect(commandsService.list).toHaveBeenCalledWith({
      workspacePath,
      workspaceIdentity,
    });
    expect(
      useCodezSessionStore
        .getState()
        .getWorkspaceState(workspacePath, workspaceIdentity)
        .slashCommands,
    ).toEqual([
      {
        name: "compact",
        description: "Compact",
        inputHint: "/compact [instructions]",
        source: "builtin",
      },
      {
        name: "hello",
        description: "Hello plugin command",
        inputHint: "/hello",
        source: "custom",
      },
    ]);
  });
});
