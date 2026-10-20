// @vitest-environment jsdom
import { act, renderHook, waitFor } from "@testing-library/react";
import type { CodezAgentsListResult } from "@codez/shared";
import { beforeEach, describe, expect, it, vi } from "vitest";

const listAgentRoles = vi.fn<() => Promise<CodezAgentsListResult>>();
const resolution = {
  services: { codezAgentService: { listAgentRoles } },
  remoteSessionId: null as string | null,
  rpcReady: true,
};
vi.mock("@/hooks/useWorkspaceServices.js", () => ({
  useWorkspaceServicesResolution: () => resolution,
}));
vi.mock("@/logger.js", () => ({ logger: { warn: vi.fn() } }));

function result(name: string): CodezAgentsListResult {
  return {
    roles: [{ name, scope: "user", fileName: `${name}.toml`, developerInstructions: "role" }],
    diagnostics: [],
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

describe("useCodexAgents scoped reads", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    listAgentRoles.mockReset();
    resolution.remoteSessionId = null;
    resolution.rpcReady = true;
  });

  it("does not read while disabled and reloads each time the menu reopens", async () => {
    listAgentRoles.mockResolvedValueOnce(result("before")).mockResolvedValueOnce(result("after"));
    const { useCodexAgents } = await import("@/hooks/useCodexAgents.js");
    const hook = renderHook(({ enabled }) => useCodexAgents({ workspacePath: "/repo", enabled }), {
      initialProps: { enabled: false },
    });
    expect(listAgentRoles).not.toHaveBeenCalled();
    expect(hook.result.current.roles).toEqual([]);
    hook.rerender({ enabled: true });
    await waitFor(() => expect(hook.result.current.roles[0]?.name).toBe("before"));
    hook.rerender({ enabled: false });
    expect(hook.result.current.roles).toEqual([]);
    hook.rerender({ enabled: true });
    expect(hook.result.current.roles).toEqual([]);
    await waitFor(() => expect(hook.result.current.roles[0]?.name).toBe("after"));
    expect(listAgentRoles).toHaveBeenCalledTimes(2);
    hook.unmount();
  });

  it("masks previous workspace roles immediately and rejects a late old result", async () => {
    const pending = deferred<CodezAgentsListResult>();
    listAgentRoles
      .mockResolvedValueOnce(result("remote-a"))
      .mockReturnValueOnce(pending.promise)
      .mockResolvedValueOnce(result("remote-b"));
    const { useCodexAgents } = await import("@/hooks/useCodexAgents.js");
    const hook = renderHook(
      ({ workspaceIdentity }) => useCodexAgents({ workspacePath: "/repo", workspaceIdentity }),
      { initialProps: { workspaceIdentity: "ssh-a" } },
    );
    await waitFor(() => expect(hook.result.current.roles[0]?.name).toBe("remote-a"));
    let refresh!: Promise<void>;
    act(() => {
      refresh = hook.result.current.refresh();
    });
    hook.rerender({ workspaceIdentity: "ssh-b" });
    expect(hook.result.current.roles).toEqual([]);
    await waitFor(() => expect(hook.result.current.roles[0]?.name).toBe("remote-b"));
    await act(async () => {
      pending.resolve(result("stale-a"));
      await refresh;
    });
    expect(hook.result.current.roles[0]?.name).toBe("remote-b");
    expect(listAgentRoles).toHaveBeenLastCalledWith({
      workspacePath: "/repo",
      workspaceIdentity: "ssh-b",
    });
    hook.unmount();
  });

  it("clears candidates on disconnect and reloads on a different attachment", async () => {
    listAgentRoles.mockResolvedValueOnce(result("old")).mockResolvedValueOnce(result("new"));
    const { useCodexAgents } = await import("@/hooks/useCodexAgents.js");
    const hook = renderHook(() =>
      useCodexAgents({ workspacePath: "/repo", workspaceIdentity: "ssh-a" }),
    );
    await waitFor(() => expect(hook.result.current.roles[0]?.name).toBe("old"));
    resolution.rpcReady = false;
    hook.rerender();
    expect(hook.result.current.roles).toEqual([]);
    expect(hook.result.current.enabled).toBe(false);
    await hook.result.current.refresh();
    expect(listAgentRoles).toHaveBeenCalledTimes(1);
    resolution.rpcReady = true;
    resolution.remoteSessionId = "attachment-2";
    hook.rerender();
    expect(hook.result.current.roles).toEqual([]);
    await waitFor(() => expect(hook.result.current.roles[0]?.name).toBe("new"));
    hook.unmount();
  });

  it("surfaces read failure without pretending an empty list is a successful read", async () => {
    listAgentRoles.mockRejectedValue(new Error("roles read denied"));
    const { useCodexAgents } = await import("@/hooks/useCodexAgents.js");
    const hook = renderHook(() => useCodexAgents({ workspacePath: "/repo" }));
    await waitFor(() => expect(hook.result.current.readFailed).toBe(true));
    expect(hook.result.current.error).toBe("roles read denied");
    expect(hook.result.current.roles).toEqual([]);
    hook.unmount();
  });
});
