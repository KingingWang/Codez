import { useMemo, useState } from "react";
import type { IServiceAccessor } from "@zcode/services";
import { Button } from "@/components/ui/button.js";
import { useCodexProjectDiscovery } from "@/hooks/useCodexProjectDiscovery.js";
import { useTabStore, useTabStoreApi } from "@/store/TabStoreProvider.js";
import {
  bindRemoteWorkspaceIdentity,
  registerRemoteWorkspaceSession,
  unregisterRemoteWorkspaceSession,
} from "@/store/remoteWorkspaceSessionStore.js";
import { isWorkspaceTab, type RestorableWorkspaceTab } from "@/store/tabStore.js";
import { resolveRootWorkspaceShellTarget } from "@/root/rootWorkspaceShellTarget.js";

const calls: Array<{
  generation: number;
  workspacePath: string;
  workspaceIdentity?: string;
}> = [];
let listRelease: (() => void) | null = null;
export const createProjectDiscoveryLocalServices = (): IServiceAccessor => createServices(0);

const createServices = (generation: number, hold = false): IServiceAccessor =>
  ({
    zcodeSessionService: {
      listSessions: async (params: { workspacePath: string; workspaceIdentity?: string }) => {
        calls.push({
          generation,
          workspacePath: params.workspacePath,
          ...(params.workspaceIdentity ? { workspaceIdentity: params.workspaceIdentity } : {}),
        });
        if (hold)
          await new Promise<void>((resolve) => {
            listRelease = resolve;
          });
        return [];
      },
    },
  }) as unknown as IServiceAccessor;

export function ProjectDiscoveryFixture() {
  const tabStore = useTabStoreApi();
  const tabs = useTabStore((state) => state.tabs);
  const activeTabId = useTabStore((state) => state.activeTabId);
  const activeWorkspacePath = useTabStore((state) => state.activeWorkspacePath);
  const activeWorkspaceIdentity = useTabStore((state) => state.activeWorkspaceIdentity);
  const [revision, setRevision] = useState(0);
  const activeTab = activeTabId ? (tabs.find((tab) => tab.id === activeTabId) ?? null) : null;
  const activeWorkspaceTab = activeTab && isWorkspaceTab(activeTab) ? activeTab : null;
  const target = useMemo(
    () =>
      resolveRootWorkspaceShellTarget({
        activeWorkspaceTab,
        activeWorkspacePath,
        activeWorkspaceIdentity,
        workspaceTabs: tabs.filter(isWorkspaceTab),
      }),
    [activeWorkspaceTab, activeWorkspacePath, activeWorkspaceIdentity, tabs],
  );
  const discovery = useCodexProjectDiscovery({
    workspacePath: target.workspaceShellPath,
    workspaceIdentity: target.workspaceIdentity,
    remoteSessionId: target.workspaceRemoteSessionId,
    activeWorkspaceTab,
    isDesktop: true,
  });

  const activate = (identity: "remote-a" | "remote-b" | null) => {
    const state = tabStore.getState();
    if (identity) {
      state.activateTabByPath("/remote/project", { workspaceIdentity: identity });
      return;
    }
    if (!state.tabs.some((tab) => isWorkspaceTab(tab) && tab.workspacePath === "/local/project")) {
      state.addTab("/local/project");
      return;
    }
    state.activateTabByPath("/local/project");
  };

  const updateActiveTabMetadata = () => {
    const state = tabStore.getState();
    const activeTab = state.activeTabId
      ? (state.tabs.find((tab) => tab.id === state.activeTabId) ?? null)
      : null;
    if (!activeTab || !isWorkspaceTab(activeTab)) return;
    const activeWorkspaceKey = `${activeTab.workspaceIdentity ?? ""}:${activeTab.workspacePath}`;
    const restoredTabs = state.tabs.flatMap((tab): RestorableWorkspaceTab[] => {
      if (!isWorkspaceTab(tab)) return [];
      return [
        {
          workspacePath: tab.workspacePath,
          availability: tab.availability,
          remoteSessionId: tab.remoteSessionId,
          remoteTarget: tab.remoteTarget,
          workspaceIdentity: tab.workspaceIdentity,
          localWorkspacePath: tab.localWorkspacePath,
          workspacePurpose: tab.workspacePurpose,
          ...(tab.id === activeTab.id
            ? { remoteHistoryId: `metadata-${calls.length}` }
            : { remoteHistoryId: tab.remoteHistoryId }),
        },
      ];
    });
    state.restoreTabs(
      restoredTabs,
      restoredTabs.findIndex(
        (tab) => `${tab.workspaceIdentity ?? ""}:${tab.workspacePath}` === activeWorkspaceKey,
      ),
    );
    setRevision((value) => value + 1);
  };

  const reconnect = () => {
    const generation = calls.length + 100;
    const services = createServices(generation, true);
    registerRemoteWorkspaceSession({
      sessionId: "remote-session-a",
      services,
    });
    bindRemoteWorkspaceIdentity("remote-a", "remote-session-a");
    tabStore.getState().addTab("/remote/project", {
      workspaceIdentity: "remote-a",
      remoteSessionId: "remote-session-a",
    });
  };

  return (
    <section
      aria-label="Project discovery"
      className="space-y-3 rounded-lg border border-border bg-surface p-4"
    >
      <div className="flex flex-wrap gap-2">
        <Button
          data-testid="project-discovery-activate-remote-a"
          onClick={() => activate("remote-a")}
        >
          Activate remote A
        </Button>
        <Button
          data-testid="project-discovery-activate-remote-b"
          onClick={() => activate("remote-b")}
        >
          Activate remote B
        </Button>
        <Button data-testid="project-discovery-activate-local" onClick={() => activate(null)}>
          Activate local
        </Button>
        <Button
          data-testid="project-discovery-focus"
          onClick={() => window.dispatchEvent(new Event("focus"))}
        >
          Focus project
        </Button>
        <Button data-testid="project-discovery-reconnect" onClick={reconnect}>
          Reconnect remote A
        </Button>
        <Button
          data-testid="project-discovery-disconnect"
          onClick={() => {
            unregisterRemoteWorkspaceSession("remote-session-a");
            activate("remote-a");
            setRevision((value) => value + 1);
          }}
        >
          Disconnect remote A
        </Button>
        <Button
          data-testid="project-discovery-release"
          onClick={() => {
            listRelease?.();
            listRelease = null;
          }}
        >
          Release pending list
        </Button>
        <Button data-testid="project-discovery-manual" onClick={() => void discovery.discover()}>
          Manual discover
        </Button>
        <Button
          data-testid="project-discovery-settings"
          onClick={() => tabStore.getState().openSettingsTab()}
        >
          Open settings
        </Button>
        <Button data-testid="project-discovery-metadata" onClick={updateActiveTabMetadata}>
          Update metadata
        </Button>
        <Button
          data-testid="project-discovery-refresh"
          onClick={() => setRevision((value) => value + 1)}
        >
          Refresh evidence
        </Button>
      </div>
      <pre data-testid="project-discovery-result" className="whitespace-pre-wrap text-ui-xs">
        {JSON.stringify({ calls, revision })}
      </pre>
    </section>
  );
}

export function initializeProjectDiscoveryFixture(): void {
  registerRemoteWorkspaceSession({
    sessionId: "remote-session-a",
    services: createServices(1, true),
  });
  bindRemoteWorkspaceIdentity("remote-a", "remote-session-a");
  registerRemoteWorkspaceSession({
    sessionId: "remote-session-b",
    services: createServices(2),
  });
  bindRemoteWorkspaceIdentity("remote-b", "remote-session-b");
}

export function seedProjectDiscoveryFixtureTabs(tabStore: ReturnType<typeof useTabStoreApi>): void {
  tabStore.getState().restoreTabs(
    [
      {
        workspacePath: "/remote/project",
        workspaceIdentity: "remote-a",
        remoteSessionId: "remote-session-a",
      },
      {
        workspacePath: "/remote/project",
        workspaceIdentity: "remote-b",
        remoteSessionId: "remote-session-b",
      },
    ],
    0,
  );
}
