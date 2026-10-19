// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useCodexProjectDiscovery } from "@/hooks/useCodexProjectDiscovery.js";

const fixture = vi.hoisted(() => ({
  listSessions: vi.fn(async () => []),
  listeners: new Set<(event: { channel: string }) => void>(),
  warn: vi.fn(),
}));
const services = {
  codezSessionService: { listSessions: fixture.listSessions },
  broadcastService: {
    onMessage(listener: (event: { channel: string }) => void) {
      fixture.listeners.add(listener);
      return { dispose: () => fixture.listeners.delete(listener) };
    },
  },
};
vi.mock("@/hooks/useWorkspaceServices.js", () => ({
  useWorkspaceServicesResolution: () => ({ services, rpcReady: true }),
}));
vi.mock("@/logger.js", () => ({ logger: { warn: fixture.warn } }));

beforeEach(() => vi.clearAllMocks());
afterEach(() => {
  cleanup();
  fixture.listeners.clear();
});

it("new project at the already-active A path scans native CLI history again", async () => {
  const activeWorkspaceTab = { workspacePath: "/a" };
  const { rerender } = renderHook(() =>
    useCodexProjectDiscovery({
      workspacePath: "/a",
      activeWorkspaceTab,
      isDesktop: true,
    }),
  );
  await waitFor(() => expect(fixture.listSessions).toHaveBeenCalledTimes(1));
  rerender();
  expect(fixture.listSessions).toHaveBeenCalledTimes(1);
  await act(async () => {
    fixture.listeners.forEach((listener) => listener({ channel: "state:projects" }));
  });
  await waitFor(() => expect(fixture.listSessions).toHaveBeenCalledTimes(2));
  expect(fixture.listSessions).toHaveBeenLastCalledWith({ workspacePath: "/a" });
  await act(async () => {
    fixture.listeners.forEach((listener) => listener({ channel: "state:other" }));
  });
  expect(fixture.listSessions).toHaveBeenCalledTimes(2);
});
