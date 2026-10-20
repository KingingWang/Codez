// @vitest-environment jsdom
import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const useSubagents = vi.fn(() => ({
  agents: [
    {
      id: "legacy",
      name: "Explore",
      path: "built-in:Explore",
      scope: "built-in",
      source: "built-in",
      enabled: true,
    },
  ],
  loading: false,
  error: null,
}));
const native = {
  roles: [
    {
      name: "executor",
      scope: "user" as const,
      fileName: "executor.toml",
      developerInstructions: "native role",
    },
  ],
  loading: false,
  error: undefined as string | undefined,
};
const useCodexAgents = vi.fn(() => native);
vi.mock("@/hooks/useSubagents.js", () => ({ useSubagents }));
vi.mock("@/hooks/useCodexAgents.js", () => ({ useCodexAgents }));

describe("usePromptSubagents runtime routing", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    native.error = undefined;
  });

  it("uses native file roles instead of the legacy built-ins", async () => {
    const { usePromptSubagents } = await import("@/hooks/usePromptSubagents.js");
    const hook = renderHook(() =>
      usePromptSubagents({
        workspacePath: "/repo",
        workspaceIdentity: "ssh-a",
        provider: "glm",
        nativeCodex: true,
        enabled: true,
      }),
    );
    expect(hook.result.current.suggestions.map((item) => item.value)).toEqual(["executor"]);
    expect(useSubagents).toHaveBeenLastCalledWith(null, "glm", "ssh-a");
    expect(useCodexAgents).toHaveBeenLastCalledWith({
      workspacePath: "/repo",
      workspaceIdentity: "ssh-a",
      enabled: true,
    });
    hook.unmount();
  });

  it("keeps legacy composers on their existing catalog", async () => {
    const { usePromptSubagents } = await import("@/hooks/usePromptSubagents.js");
    const hook = renderHook(() =>
      usePromptSubagents({
        workspacePath: "/repo",
        provider: "glm",
        nativeCodex: false,
        enabled: true,
      }),
    );
    expect(hook.result.current.suggestions.map((item) => item.value)).toEqual(["Explore"]);
    expect(useSubagents).toHaveBeenLastCalledWith("/repo", "glm", undefined);
    expect(useCodexAgents).toHaveBeenLastCalledWith({
      workspacePath: "/repo",
      workspaceIdentity: undefined,
      enabled: false,
    });
    hook.unmount();
  });

  it("does not expose stale results while disabled or on native read failure", async () => {
    const { usePromptSubagents } = await import("@/hooks/usePromptSubagents.js");
    const hook = renderHook(
      ({ enabled }) =>
        usePromptSubagents({
          workspacePath: "/repo",
          provider: "glm",
          nativeCodex: true,
          enabled,
        }),
      { initialProps: { enabled: false } },
    );
    expect(hook.result.current.suggestions).toEqual([]);
    native.error = "native read failed";
    hook.rerender({ enabled: true });
    expect(hook.result.current.error).toBe("native read failed");
    expect(hook.result.current.suggestions).toEqual([]);
    expect(useSubagents).toHaveBeenLastCalledWith(null, "glm", undefined);
    hook.unmount();
  });
});
