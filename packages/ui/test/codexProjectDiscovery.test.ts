// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useCodexProjectDiscovery } from "@/hooks/useCodexProjectDiscovery.js";
import { registerSourceSettingsServices } from "@/store/sourceSettingsServiceStore.js";
import {
  registerBaseWorkspaceServices,
  useRemoteWorkspaceSessionStore,
} from "@/store/remoteWorkspaceSessionStore.js";
import type { IServiceAccessor } from "@codez/services";

const fixture = vi.hoisted(() => ({
  listSessions: vi.fn(async () => []),
  remoteListSessions: vi.fn(async () => []),
  resolveWorkspace: vi.fn(async () => ({
    canonicalWorkspaceKey: "remote:ssh:host:22:dev:/remote/new",
  })),
  requestSourceSettingsAttachment: vi.fn(async (sourceServerId: string) => {
    fixture.disposeSourceSettings = registerSourceSettingsServices({
      sourceServerId,
      attachmentId: `source-settings-${sourceServerId}`,
      services: {
        codezSessionService: { listSessions: fixture.remoteListSessions },
        sourceServerWorkspaceService: { resolveWorkspace: fixture.resolveWorkspace },
      } as unknown as IServiceAccessor,
      dispose: () => {},
    });
    return { attachmentId: `source-settings-${sourceServerId}` };
  }),
  disposeSourceSettings: undefined as (() => void) | undefined,
  listeners: new Set<(event: { channel: string }) => void>(),
  warn: vi.fn(),
  projectDirectory: null as {
    loading: boolean;
    projects: Array<{
      id: string;
      hostId: string;
      deleted: boolean;
      roots: Array<{ rootPath: string; position: number; isPrimary: boolean }>;
    }>;
    directory: {
      hosts: Array<{
        id: string;
        membershipId: string;
        kind: "ssh";
        target: { kind: "ssh"; host: "host"; port: 22; username: "dev" };
        position: 0;
      }>;
      entries: unknown[];
    };
  } | null,
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
vi.mock("@/hooks/usePlatform.js", () => ({
  useOptionalPlatform: () => ({
    requestSourceSettingsAttachment: fixture.requestSourceSettingsAttachment,
  }),
}));
vi.mock("@/project-sidebar/index.js", () => ({
  useOptionalProjectDirectory: () => fixture.projectDirectory,
}));
vi.mock("@/logger.js", () => ({ logger: { warn: fixture.warn } }));

beforeEach(() => {
  vi.clearAllMocks();
  fixture.projectDirectory = null;
  registerBaseWorkspaceServices(services as unknown as IServiceAccessor);
});
afterEach(() => {
  cleanup();
  fixture.listeners.clear();
  fixture.disposeSourceSettings?.();
  fixture.disposeSourceSettings = undefined;
  useRemoteWorkspaceSessionStore.setState({
    baseServices: null,
    sessionsById: {},
    sessionIdByWorkspacePath: {},
    sessionIdByWorkspaceIdentity: {},
  });
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

it("scans newly added remote and local project roots even without an active workspace tab", async () => {
  fixture.projectDirectory = {
    loading: false,
    projects: [
      {
        id: "local-existing",
        hostId: "local",
        deleted: false,
        roots: [{ rootPath: "/local/existing", position: 0, isPrimary: true }],
      },
    ],
    directory: {
      hosts: [
        {
          id: "remote:server:srv-1",
          membershipId: "m-1",
          kind: "ssh",
          target: { kind: "ssh", host: "host", port: 22, username: "dev" },
          position: 0,
        },
      ],
      entries: [],
    },
  };
  const { rerender } = renderHook(() =>
    useCodexProjectDiscovery({
      workspacePath: "/local/existing",
      activeWorkspaceTab: null,
      isDesktop: true,
    }),
  );
  expect(fixture.listSessions).not.toHaveBeenCalled();
  expect(fixture.remoteListSessions).not.toHaveBeenCalled();

  fixture.projectDirectory = {
    ...fixture.projectDirectory,
    projects: [
      ...fixture.projectDirectory.projects,
      {
        id: "remote-added",
        hostId: "remote:server:srv-1",
        deleted: false,
        roots: [{ rootPath: "/remote/new", position: 0, isPrimary: true }],
      },
      {
        id: "local-added",
        hostId: "local",
        deleted: false,
        roots: [{ rootPath: "/local/new", position: 0, isPrimary: true }],
      },
    ],
  };
  rerender();

  await waitFor(() => expect(fixture.remoteListSessions).toHaveBeenCalledTimes(1));
  expect(fixture.requestSourceSettingsAttachment).toHaveBeenCalledWith("srv-1");
  expect(fixture.resolveWorkspace).toHaveBeenCalledWith({
    workspacePath: "/remote/new",
    legacyRouteHint: "remote:ssh:host:22:dev:/remote/new",
  });
  expect(fixture.remoteListSessions).toHaveBeenCalledWith({
    workspacePath: "/remote/new",
    workspaceIdentity: "remote:server:srv-1:/remote/new",
  });
  await waitFor(() =>
    expect(fixture.listSessions).toHaveBeenCalledWith({
      workspacePath: "/local/new",
    }),
  );
});

it("scans a newly added single-folder project even when initial loading started with an empty project list", async () => {
  fixture.projectDirectory = {
    loading: true,
    projects: [],
    directory: { hosts: [], entries: [] },
  };
  const { rerender } = renderHook(() =>
    useCodexProjectDiscovery({
      workspacePath: "/other",
      activeWorkspaceTab: null,
      isDesktop: true,
    }),
  );
  expect(fixture.listSessions).not.toHaveBeenCalled();

  fixture.projectDirectory = {
    loading: false,
    projects: [
      {
        id: "single-folder",
        hostId: "local",
        deleted: false,
        roots: [{ rootPath: "/local/single-folder", position: 0, isPrimary: true }],
      },
    ],
    directory: { hosts: [], entries: [] },
  };
  rerender();

  await waitFor(() =>
    expect(fixture.listSessions).toHaveBeenCalledWith({
      workspacePath: "/local/single-folder",
    }),
  );
});
