import { useCallback, useEffect, useMemo, useState } from "react";
import type { ICodezAgentService } from "@codez/services";
import {
  codexCapabilitySource,
  projectCodexCapabilities,
  type CodexFeatureAvailability,
} from "@/capabilities/codexCapabilities.js";

interface RuntimeRefreshSource {
  onRuntimeRestart?: (
    listener: (reason?: "runtimeRestart" | "transportReplaced") => void,
  ) => () => void;
  onRuntimeLifecycle?: (listener: (state: "available" | "unavailable") => void) => () => void;
}

interface CodexDesktopFileRewindCapabilityController {
  readonly availability: CodexFeatureAvailability;
  readonly refresh: () => void;
}

export function bindRuntimeCapabilityRefresh(
  runtime: RuntimeRefreshSource,
  refresh: () => void,
): () => void {
  const unsubscribers: Array<() => void> = [];
  // Lifecycle covers process readiness, while stable Local Host proxy handoff is
  // emitted only as `transportReplaced` on the restart channel. The channels must
  // coexist; treating them as alternatives leaves capability data stale after handoff.
  if (runtime.onRuntimeLifecycle)
    unsubscribers.push(
      runtime.onRuntimeLifecycle((state) => {
        if (state === "available") refresh();
      }),
    );
  if (runtime.onRuntimeRestart)
    unsubscribers.push(
      runtime.onRuntimeRestart((reason) => {
        if (reason === undefined || reason === "transportReplaced") refresh();
      }),
    );
  return () => {
    for (const unsubscribe of unsubscribers) unsubscribe();
  };
}

export function useCodexDesktopFileRewindCapability(
  agentService: Pick<ICodezAgentService, "helloConversationV4"> | undefined,
  workspace: { workspacePath: string; workspaceIdentity?: string },
  runtime?: RuntimeRefreshSource,
): CodexDesktopFileRewindCapabilityController {
  const identity = workspace.workspaceIdentity?.trim() || workspace.workspacePath;
  const [revision, setRevision] = useState(0);
  const [source, setState] = useState<{ available: false } | { available: true; codex?: unknown }>({
    available: false,
  });
  const refresh = useCallback(() => setRevision((value) => value + 1), []);

  useEffect(() => {
    if (!agentService?.helloConversationV4) {
      setState({ available: false });
      return undefined;
    }
    let cancelled = false;
    setState({ available: false });
    void agentService
      .helloConversationV4()
      .then((hello) => {
        if (!cancelled) setState(codexCapabilitySource(hello));
      })
      .catch(() => {
        if (!cancelled) setState({ available: false });
      });
    return () => {
      cancelled = true;
    };
  }, [agentService, identity, revision]);

  const availability = useMemo(
    () => projectCodexCapabilities(source).safeDesktopFileRewind,
    [source],
  );
  const onRuntimeRestart = runtime?.onRuntimeRestart;
  const onRuntimeLifecycle = runtime?.onRuntimeLifecycle;
  useEffect(
    () => bindRuntimeCapabilityRefresh({ onRuntimeRestart, onRuntimeLifecycle }, refresh),
    [onRuntimeRestart, onRuntimeLifecycle, refresh],
  );

  return { availability, refresh };
}

export function isCodexDesktopFileRewindAvailable(availability: CodexFeatureAvailability): boolean {
  return availability.status === "supported";
}
