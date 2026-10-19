import { useCallback, useEffect, useMemo, useState } from "react";
import type { IServiceAccessor } from "@codez/services";
import {
  codexCapabilityGate,
  projectCodexCapabilities,
  type CodexFeatureAvailability,
} from "@/capabilities/codexCapabilities.js";

interface GitAuxiliaryCapabilityController {
  readonly availability: CodexFeatureAvailability;
  readonly gate: ReturnType<typeof codexCapabilityGate>;
  readonly refresh: () => void;
}

function isSupportedCapability(value: unknown): boolean {
  if (typeof value !== "object" || value === null) return false;
  return (
    projectCodexCapabilities({
      available: true,
      codex: (value as { codex?: unknown }).codex,
    }).auxiliaryTextGeneration.status === "supported"
  );
}

export function useGitAuxiliaryCapability(
  services: IServiceAccessor,
  workspace: { workspacePath: string; workspaceIdentity?: string },
): GitAuxiliaryCapabilityController {
  const agentService = services.codezAgentService;
  const [revision, setRevision] = useState(0);
  const [state, setState] = useState<
    { status: "supported" } | { status: "unavailable" } | { status: "error" }
  >({ status: "unavailable" });

  const identity = workspace.workspaceIdentity?.trim() || workspace.workspacePath;
  const refresh = useCallback(() => {
    setRevision((value) => value + 1);
  }, []);

  useEffect(() => {
    if (!agentService?.helloConversationV4) {
      setState({ status: "unavailable" });
      return undefined;
    }
    let cancelled = false;
    setState({ status: "unavailable" });
    void agentService
      .helloConversationV4()
      .then((hello) => {
        if (cancelled) return;
        setState(
          isSupportedCapability(hello.capabilities)
            ? { status: "supported" }
            : { status: "unavailable" },
        );
      })
      .catch(() => {
        if (!cancelled) setState({ status: "error" });
      });
    return () => {
      cancelled = true;
    };
  }, [agentService, identity, revision]);

  return useMemo(() => {
    const availability =
      state.status === "supported"
        ? ({ status: "supported" } as const)
        : ({
            status: "unavailable",
            reason: "codex.capabilities.auxiliaryTextGeneration.unavailable",
          } as const);
    return {
      availability,
      gate: codexCapabilityGate(availability),
      refresh,
    };
  }, [refresh, state.status]);
}
