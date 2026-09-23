import { describe, expect, it, beforeEach } from "vitest";
import { selectWorkspaceCodezState, useCodezSessionStore } from "../src/store/codezSessionStore.js";

describe("useSlashCommands", () => {
  beforeEach(() => {
    useCodezSessionStore.setState((state) => ({
      ...state,
      workspaces: {},
    }));
  });

  it("remote workspace 会按 workspaceIdentity 读取 slash commands", () => {
    const workspacePath = "/root";
    const workspaceIdentity = "remote:ssh:demo:22:root:/root";
    useCodezSessionStore.getState().setSlashCommands(
      workspacePath,
      [{ name: "remote-command", description: "remote command" }],
      workspaceIdentity,
    );

    const identityCommands = selectWorkspaceCodezState(
      useCodezSessionStore.getState(),
      workspacePath,
      workspaceIdentity,
    ).slashCommands;
    const pathOnlyCommands = selectWorkspaceCodezState(useCodezSessionStore.getState(), workspacePath).slashCommands;

    expect(identityCommands.map((command) => command.name)).toEqual(["remote-command"]);
    expect(pathOnlyCommands).toEqual([]);
  });
});
