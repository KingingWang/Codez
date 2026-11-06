// 真实 LoginPanel / Root / Zustand / auth event hook，OAuth IO 和凭据均为隔离内存事实。
import { useCallback, useEffect, useState } from "react";
import type { IServiceAccessor } from "@/codex-settings-qa-ui/contract.js";
import type {
  IPlatformService,
  OAuthProviderId,
  OAuthSessionCallbackResult,
  OAuthSessionState,
} from "@codez/shared";
import { Button } from "@/components/ui/button.js";
import { ServiceProvider } from "@/hooks/useServices.js";
import { PlatformProvider } from "@/hooks/usePlatform.js";
import { LoginPanel } from "@/WelcomeScreen.js";
import { useRootOAuthEffects } from "@/root/useRootOAuthEffects.js";
import { StoreProvider, useCodezStore } from "@/store/StoreProvider.js";
import { useWebRemoteControlAuthSync } from "@/web-remote-control/app/useWebRemoteControlAuthSync.js";

function createLoginFixture() {
  const counts = {
    starts: 0,
    polls: 0,
    callbacks: 0,
    handled: 0,
    credentialWrites: 0,
    legacyReads: 0,
    legacyWrites: 0,
    opened: 0,
    authEvents: [] as OAuthSessionState[],
  };
  type Flow = { state: string; provider: OAuthProviderId };
  let pending: Flow | null = null;
  let completed: Flow | null = null;
  let ready = false;
  let holdPoll = false;
  let failPoll = false;
  let releasePoll: (() => void) | undefined;
  let callback: ((url: string) => Promise<void>) | undefined;
  const listeners = new Set<(state: OAuthSessionState) => void>();
  const pollListeners = new Set<(count: number) => void>();
  let user: OAuthSessionCallbackResult["userInfo"] | null = null;
  const finish = (flow: Flow): OAuthSessionCallbackResult | null => {
    if (pending !== flow) return null;
    pending = null;
    completed = flow;
    user = { id: "isolated-new-user", username: "isolated-new-user", displayName: "QA User" };
    counts.credentialWrites++;
    for (const listener of listeners) listener("signed-in");
    return { kind: "session", provider: flow.provider, userInfo: user };
  };
  const emptyEvent = () => ({ dispose() {} });
  const broadcastService = { onMessage: emptyEvent, broadcast() {} };
  const services = {
    broadcastService,
    oauthService: {
      getProviders: async () => [
        { id: "bigmodel", displayName: "BigModel", enabled: true, order: 0 },
        { id: "zai", displayName: "Z.ai", enabled: true, order: 1 },
      ],
      getActiveProvider: async () => completed?.provider ?? null,
      restoreCachedSessionState: async () =>
        user ? { status: "authenticated", userInfo: user } : { status: "signed-out" },
      onDidChangeSession(listener: (state: OAuthSessionState) => void) {
        listeners.add(listener);
        return { dispose: () => listeners.delete(listener) };
      },
      async startOAuthWithPolling(provider: OAuthProviderId) {
        counts.starts++;
        pending = { state: `isolated-flow-${counts.starts}`, provider };
        ready = false;
        return {
          provider,
          state: pending.state,
          authorizeUrl: `https://example.invalid/authorize?state=${pending.state}`,
        };
      },
      async pollPendingOAuth() {
        counts.polls++;
        for (const listener of pollListeners) listener(counts.polls);
        const flow = pending;
        if (!flow) return null;
        if (failPoll) {
          failPoll = false;
          throw new Error("Isolated authorization failure");
        }
        if (holdPoll) {
          holdPoll = false;
          await new Promise<void>((resolve) => {
            releasePoll = resolve;
          });
          return finish(flow);
        }
        return ready ? finish(flow) : null;
      },
      async handleCallback(url: string) {
        counts.callbacks++;
        const state = new URL(url).searchParams.get("state");
        if (pending?.state === state) return finish(pending);
        if (completed?.state === state) return { kind: "duplicate", provider: completed.provider };
        throw new Error("Isolated callback has no current flow");
      },
      async cancelPending() {
        pending = null;
      },
    },
    settingService: {
      async get() {
        counts.legacyReads++;
        return {};
      },
      async update() {
        counts.legacyWrites++;
      },
    },
    providerSettingsService: {
      onDidChange: emptyEvent,
      async getView() {
        counts.legacyReads++;
        return { providers: [] };
      },
      async refresh() {
        counts.legacyReads++;
        throw new Error("Legacy Provider forbidden");
      },
    },
  } as unknown as IServiceAccessor;
  const platform = {
    registerOAuthState() {},
    openExternal() {
      counts.opened++;
    },
    reportTelemetryEvent: async () => {},
    notifyRendererReady() {},
    onOAuthCallback(listener: (url: string) => Promise<void>) {
      callback = listener;
      return () => {
        callback = undefined;
      };
    },
    notifyWebRemoteControlAuthStateChanged({ state }: { state: OAuthSessionState }) {
      counts.authEvents.push(state);
    },
  } as unknown as IPlatformService;
  return {
    counts,
    services,
    platform,
    observePolls(listener: (count: number) => void) {
      pollListeners.add(listener);
      return () => {
        pollListeners.delete(listener);
      };
    },
    makeReady() {
      ready = true;
    },
    holdNextPoll() {
      holdPoll = true;
    },
    failNextPoll() {
      failPoll = true;
    },
    releasePoll() {
      releasePoll?.();
      releasePoll = undefined;
    },
    async deliverCallback() {
      const flow = pending ?? completed;
      await callback?.(`codez-codex://oauth/callback?state=${flow?.state ?? "obsolete"}`);
      counts.handled++;
    },
  };
}

type LoginFixture = ReturnType<typeof createLoginFixture>;
const noop = () => {};

function NativeLoginScenario({ fixture }: { fixture: LoginFixture }) {
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<"codex" | "legacy">("codex");
  const [inspection, setInspection] = useState("");
  const [polls, setPolls] = useState(0);
  useEffect(() => fixture.observePolls(setPolls), [fixture]);
  const user = useCodezStore((s) => s.user);
  const setUser = useCodezStore((s) => s.setUser);
  const oauthPollingActive = useCodezStore((s) => s.oauthPollingActive);
  const setOAuthPollingActive = useCodezStore((s) => s.setOAuthPollingActive);
  const setOAuthError = useCodezStore((s) => s.setOAuthError);
  const oauthError = useCodezStore((s) => s.oauthError);
  const markOAuthSuccess = useCodezStore((s) => s.markOAuthSuccess);
  const setRestoring = useCodezStore((s) => s.setIsRestoringOAuthSession);
  const successSeq = useCodezStore((s) => s.oauthSuccessSeq);
  const requestLoginEntry = useCodezStore((s) => s.requestLoginEntry);
  const attempt = useCodezStore((s) => s.loginEntryAttempt);
  const lastProvider = useCodezStore((s) => s.lastOAuthSuccessProvider);
  const refreshProviderState = useCallback(async () => {
    fixture.counts.legacyReads++;
  }, [fixture]);
  const initialAuth = useCallback(async () => {
    const cached = await fixture.services.oauthService.restoreCachedSessionState();
    return cached.status === "authenticated" ? cached.userInfo.id : undefined;
  }, [fixture]);
  useRootOAuthEffects({
    startupMode: mode,
    accountIntentKey: JSON.stringify([user?.id]),
    platform: fixture.platform,
    services: fixture.services,
    refreshProviderState,
    setUser,
    setIsRestoringOAuthSession: setRestoring,
    setOAuthError,
    oauthPollingActive,
    setOAuthPollingActive,
    markOAuthSuccess,
    onReauthenticationRequired: noop,
  });
  useWebRemoteControlAuthSync(
    fixture.platform,
    fixture.services.oauthService,
    user?.id,
    false,
    initialAuth,
  );
  const onComplete = useCallback(() => setOpen(false), []);
  return (
    <section aria-label="Native application login fixture">
      <Button
        onClick={() => {
          requestLoginEntry(undefined, "app-login");
          setOpen(true);
        }}
      >
        Remote sign in
      </Button>
      <Button
        onClick={() => {
          requestLoginEntry("bigmodel", "app-login");
          setOpen(true);
        }}
      >
        Reauthenticate BigModel
      </Button>
      <Button onClick={() => fixture.makeReady()}>Complete browser authorization</Button>
      <Button onClick={() => fixture.holdNextPoll()}>Hold next auth poll</Button>
      <Button onClick={() => fixture.failNextPoll()}>Fail next auth poll</Button>
      <Button onClick={() => fixture.releasePoll()}>Release auth poll</Button>
      <Button onClick={() => setMode("legacy")}>Switch to legacy mode</Button>
      <Button onClick={() => void fixture.deliverCallback()}>Deliver current auth link</Button>
      <Button
        onClick={() =>
          setInspection(
            JSON.stringify({
              ...fixture.counts,
              userId: user?.id ?? null,
              successSeq,
              lastProvider,
              pollingActive: oauthPollingActive,
              loginOpen: open,
              attemptStatus: attempt?.status,
              oauthError,
            }),
          )
        }
      >
        Inspect native login
      </Button>
      <output data-testid="qa-native-login-state">
        {JSON.stringify({
          userId: user?.id ?? null,
          successSeq,
          pollingActive: oauthPollingActive,
          loginOpen: open,
          polls,
          oauthError,
        })}
      </output>
      <output data-testid="qa-native-login-inspection">{inspection}</output>
      {open && <LoginPanel active onComplete={onComplete} />}
    </section>
  );
}

export function NativeLoginFixture() {
  const [fixture] = useState(createLoginFixture);
  return (
    <ServiceProvider services={fixture.services}>
      <PlatformProvider platform={fixture.platform}>
        <StoreProvider broadcastService={fixture.services.broadcastService}>
          <NativeLoginScenario fixture={fixture} />
        </StoreProvider>
      </PlatformProvider>
    </ServiceProvider>
  );
}
