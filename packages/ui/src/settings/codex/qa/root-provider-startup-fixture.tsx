import { useEffect, useState } from "react";
import type { IServiceAccessor } from "@codez/services";
import type { IPlatformService } from "@codez/shared";
import { Button } from "@/components/ui/button.js";
import { useDynamicWorkflowAvailabilityLoader } from "@/hooks/useDynamicWorkflowAvailability.js";
import { useRootOAuthEffects } from "@/root/useRootOAuthEffects.js";
import { useRootProviderSettingsSnapshot } from "@/root/useRootProviderSettingsSnapshot.js";
import type { RootProviderStartupMode } from "@/root/rootProviderStartupMode.js";
import { useAlertDialogStore } from "@/store/alertDialogStore.js";
import { useDynamicWorkflowAvailabilityStore } from "@/store/dynamicWorkflowAvailabilityStore.js";

const counts = {
  providerReads: 0,
  providerSubscriptions: 0,
  providerRefreshes: 0,
  workflowReads: 0,
  oauthRestores: 0,
  oauthSubscriptions: 0,
  oauthBusinessCallbacks: 0,
  oauthHandled: 0,
  oauthPolls: 0,
  oldAccountWrites: 0,
  oldSettingWrites: 0,
  providerFamilyReads: 0,
  familyReadsHeld: 0,
  oldLoginSuccesses: 0,
  reauthenticationActions: 0,
  rendererReady: 0,
};
let deliverPendingOAuth: (() => Promise<void>) | null = null;
let holdNextLegacyCallback = false;
let releaseLegacyCallback: (() => void) | null = null;
let releasePendingPoll: (() => void) | null = null;
let onPollStarted: (() => void) | null = null;
let holdFamilyReadAfterWrite = false;
let familyWriteBaseline = 0;
let releaseFamilyRead: (() => void) | null = null;
let nextRestoreRequiresReauthentication = false;
const releaseWorkflowReads: Array<() => void> = [];
const emptyView = { revision: 1, providers: [] };
const services = {
  providerSettingsService: {
    onDidChange: () => {
      counts.providerSubscriptions++;
      return { dispose() {} };
    },
    async getView() {
      counts.providerReads++;
      return emptyView;
    },
    async refresh() {
      counts.providerFamilyReads++;
      return {
        ...emptyView,
        providers: [
          "account:zai-individual-coding-plan",
          "account:zai-start-plan",
          "account:zai-team-coding-plan",
        ].map((providerId) => ({
          providerId,
          effectiveConfig: {},
          accountState: { availability: "unknown" },
        })),
      };
    },
  },
  oauthService: {
    async restoreCachedSessionState() {
      counts.oauthRestores++;
      if (nextRestoreRequiresReauthentication) {
        nextRestoreRequiresReauthentication = false;
        return { status: "reauthentication-required" as const, reason: "jwt-expired" as const };
      }
      return { status: "signed-out" as const };
    },
    async handleCallback() {
      counts.oauthBusinessCallbacks++;
      if (holdNextLegacyCallback) {
        holdNextLegacyCallback = false;
        await new Promise<void>((resolve) => {
          releaseLegacyCallback = resolve;
        });
        return {
          kind: "session" as const,
          provider: "zai" as const,
          userInfo: { username: "isolated-fixture" },
        };
      }
      return null;
    },
    pollPendingOAuth() {
      counts.oauthPolls++;
      onPollStarted?.();
      return new Promise((resolve) => {
        releasePendingPoll = () =>
          resolve({
            kind: "session",
            provider: "zai",
            userInfo: { username: "isolated-fixture" },
          });
      });
    },
  },
  broadcastService: {
    onMessage: () => ({ dispose() {} }),
  },
  codingPlanSubscriptionService: {
    getDynamicWorkflowClientConfig: () => {
      counts.workflowReads++;
      return new Promise((resolve) => {
        releaseWorkflowReads.push(() =>
          resolve({ mode: "alwaysOn", enabled: true, source: "remote" }),
        );
      });
    },
  },
  settingService: {
    get() {
      if (holdFamilyReadAfterWrite && counts.oldSettingWrites > familyWriteBaseline) {
        holdFamilyReadAfterWrite = false;
        counts.familyReadsHeld++;
        onPollStarted?.();
        return new Promise((resolve) => {
          releaseFamilyRead = () => resolve({});
        });
      }
      return {};
    },
    async update() {
      counts.oldSettingWrites++;
    },
  },
} as unknown as IServiceAccessor;
const platform = {
  onOAuthCallback: (callback: (url: string) => void | Promise<void>) => {
    counts.oauthSubscriptions++;
    const deliver = async () => {
      await callback("codez-codex://oauth/callback?state=isolated-fixture");
      counts.oauthHandled++;
    };
    deliverPendingOAuth = deliver;
    return () => {
      if (deliverPendingOAuth === deliver) deliverPendingOAuth = null;
    };
  },
  notifyRendererReady: () => {
    counts.rendererReady++;
  },
} as unknown as IPlatformService;
const noop = () => {};
const recordOldAccountWrite = () => {
  counts.oldAccountWrites++;
};
const recordOldLoginSuccess = () => {
  counts.oldLoginSuccesses++;
};
const recordOldReauthentication = () => {
  counts.reauthenticationActions++;
};
const noopAsync = async () => {};
const alternateRefresh = async () => {};
const refreshProviderState = async () => {
  counts.providerRefreshes++;
};
const inspectRootStartup = () =>
  JSON.stringify({
    ...counts,
    workflowEnabled: useDynamicWorkflowAvailabilityStore.getState().enabled,
  });

function RootStartupEffects({
  mode,
  refreshVersion,
  pollingActive,
  setPollingActive,
}: {
  mode: RootProviderStartupMode | "pending";
  refreshVersion: number;
  pollingActive: boolean;
  setPollingActive: (active: boolean) => void;
}) {
  useRootProviderSettingsSnapshot(services, mode === "legacy");
  useDynamicWorkflowAvailabilityLoader(services.codingPlanSubscriptionService, mode === "legacy");
  useRootOAuthEffects({
    startupMode: mode,
    accountIntentKey: "fixture",
    platform,
    services,
    refreshProviderState,
    refreshAppSettings: refreshVersion % 2 === 0 ? noopAsync : alternateRefresh,
    setUser: recordOldAccountWrite,
    setIsRestoringOAuthSession: noop,
    setOAuthError: noop,
    oauthPollingActive: pollingActive,
    setOAuthPollingActive: setPollingActive,
    markOAuthSuccess: recordOldLoginSuccess,
    onReauthenticationRequired: recordOldReauthentication,
  });
  return null;
}

export function RootProviderStartupFixture() {
  const [mode, setMode] = useState<RootProviderStartupMode | "pending">("pending");
  const [refreshVersion, setRefreshVersion] = useState(0);
  const [pollingActive, setPollingActive] = useState(false);
  const [inspection, setInspection] = useState("");
  const pendingAlert = useAlertDialogStore((state) => state.pendingRequest);
  const settleAlert = useAlertDialogStore((state) => state.settleAlert);
  useEffect(() => {
    const notify = () => setInspection(inspectRootStartup());
    onPollStarted = notify;
    return () => {
      if (onPollStarted === notify) onPollStarted = null;
    };
  }, []);
  return (
    <section aria-label="Root startup mode fixture">
      <Button onClick={() => setMode("codex")}>Resolve native Codex Host</Button>
      <Button onClick={() => setMode("legacy")}>Resolve legacy Host</Button>
      <Button onClick={() => setRefreshVersion((value) => value + 1)}>
        Change callback dependency
      </Button>
      <Button
        onClick={() => {
          void deliverPendingOAuth?.().then(() => setInspection(inspectRootStartup()));
        }}
      >
        Deliver pending legacy OAuth link
      </Button>
      <Button onClick={() => setInspection(inspectRootStartup())}>Inspect Root startup</Button>
      <Button
        onClick={() => {
          holdNextLegacyCallback = true;
          void deliverPendingOAuth?.().then(() => setInspection(inspectRootStartup()));
          setInspection(inspectRootStartup());
        }}
      >
        Start pending legacy login
      </Button>
      <Button
        onClick={() => {
          releaseLegacyCallback?.();
          releaseLegacyCallback = null;
        }}
      >
        Release pending legacy login
      </Button>
      <Button onClick={() => setPollingActive(true)}>Start legacy polling</Button>
      <Button
        onClick={() => {
          nextRestoreRequiresReauthentication = true;
          setMode("legacy");
        }}
      >
        Restore expired legacy session
      </Button>
      <Button
        onClick={() => {
          holdFamilyReadAfterWrite = true;
          familyWriteBaseline = counts.oldSettingWrites;
        }}
      >
        Hold legacy family refresh
      </Button>
      <Button
        onClick={() => {
          releaseFamilyRead?.();
          releaseFamilyRead = null;
          queueMicrotask(() => setInspection(inspectRootStartup()));
        }}
      >
        Release legacy family refresh
      </Button>
      <Button
        onClick={() => {
          releasePendingPoll?.();
          releasePendingPoll = null;
          queueMicrotask(() => setInspection(inspectRootStartup()));
        }}
      >
        Release pending legacy poll
      </Button>
      <Button
        onClick={() => {
          for (const release of releaseWorkflowReads.splice(0)) release();
          queueMicrotask(() => setInspection(inspectRootStartup()));
        }}
      >
        Release legacy workflow response
      </Button>
      <output data-testid="qa-root-startup-inspection">{inspection}</output>
      {pendingAlert && (
        <div role="dialog" aria-label="Legacy reauthentication prompt">
          <Button onClick={() => settleAlert(true)}>Confirm old account</Button>
        </div>
      )}
      <RootStartupEffects
        mode={mode}
        refreshVersion={refreshVersion}
        pollingActive={pollingActive}
        setPollingActive={setPollingActive}
      />
    </section>
  );
}
