import { useCallback, useEffect, useState } from "react";
import type {
  CodexConversationHistoryRunsParams,
  CodexConversationHistoryRunsResult,
} from "@codez/shared/codez-protocol-v4";
import {
  codexCapabilityGate,
  codexCapabilitySource,
  projectCodexCapabilities,
} from "@/capabilities/codexCapabilities.js";
import { logger } from "@/logger.js";

type HelloSource = { helloConversationV4?: () => Promise<{ capabilities: unknown }> };
type HistorySource = {
  codexHistoryRunsV4?: (params: {
    sessionId: string;
    limit?: number;
    status?: CodexConversationHistoryRunsParams["status"];
    beforeTurnId?: string;
    workspacePath: string;
    workspaceIdentity?: string;
  }) => Promise<CodexConversationHistoryRunsResult>;
};

export type CodexHistoryState =
  | { status: "idle" }
  | { status: "no-session" }
  | { status: "transport-unavailable" }
  | { status: "unavailable"; reason: string }
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; result: CodexConversationHistoryRunsResult };

export function useCodexHistoryRuns(options: {
  hello?: HelloSource;
  source?: HistorySource;
  workspacePath?: string | null;
  workspaceIdentity?: string;
  sessionId: string | null;
  limit?: number;
  enabled?: boolean;
}): CodexHistoryState {
  const {
    enabled = true,
    hello,
    limit,
    sessionId,
    source,
    workspaceIdentity,
    workspacePath,
  } = options;
  const [state, setState] = useState<CodexHistoryState>(() => {
    if (!enabled) return { status: "idle" };
    if (!sessionId) return { status: "no-session" };
    if (!workspacePath) return { status: "transport-unavailable" };
    if (!hello || !source?.codexHistoryRunsV4) return { status: "transport-unavailable" };
    return { status: "loading" };
  });
  const load = useCallback(
    async (beforeTurnId?: string) => {
      let helloResult: { capabilities: unknown } | undefined;

      try {
        helloResult = await hello?.helloConversationV4?.();
      } catch (error) {
        // Capability discovery itself failed: fail closed without a history request.
        throw Object.assign(error instanceof Error ? error : new Error(String(error)), {
          capabilityMissing: true,
        });
      }
      if (!helloResult)
        throw Object.assign(new Error("Codex Host capability source is unavailable"), {
          capabilityMissing: true,
        });
      const capability = projectCodexCapabilities(
        codexCapabilitySource(helloResult ?? {}),
      ).readOnlyWorkflowHistory;
      const gate = codexCapabilityGate(capability);
      if (!gate.disabled) {
        const result = await source?.codexHistoryRunsV4?.({
          sessionId: sessionId!,
          workspacePath: workspacePath!,
          ...(workspaceIdentity ? { workspaceIdentity } : {}),
          ...(limit !== undefined ? { limit } : {}),
          ...(beforeTurnId !== undefined ? { beforeTurnId } : {}),
        });
        if (!result) throw new Error("Codex history query is unavailable");
        return result;
      }
      throw Object.assign(new Error(gate.reason), { capabilityMissing: true });
    },
    [hello, limit, sessionId, source, workspaceIdentity, workspacePath],
  );

  useEffect(() => {
    if (!enabled || !sessionId || !workspacePath || !hello || !source?.codexHistoryRunsV4) {
      if (!enabled) setState({ status: "idle" });
      else if (!sessionId) setState({ status: "no-session" });
      else setState({ status: "transport-unavailable" });
      return undefined;
    }
    let alive = true;
    setState({ status: "loading" });
    void load()
      .then((result) => {
        if (alive) setState({ status: "ready", result });
      })
      .catch((error: unknown) => {
        if (!alive) return;
        const missing = Boolean((error as { capabilityMissing?: boolean }).capabilityMissing);
        if (missing) {
          setState({
            status: "unavailable",
            reason: "codex.capabilities.readOnlyWorkflowHistory.unsupported",
          });
        } else {
          logger.warn("[codex-history] read failed", {
            error: error instanceof Error ? error.message : String(error),
            sessionId,
          });
          setState({
            status: "error",
            message: error instanceof Error ? error.message : String(error),
          });
        }
      });
    return () => {
      alive = false;
    };
  }, [enabled, hello, load, sessionId, source, workspacePath]);

  return state;
}
