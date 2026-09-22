import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import { useWorkspaceServicesResolution } from "./useWorkspaceServices.js";
import {
  readCodexModelCatalog,
  type CodexModelCatalog,
} from "@/settings/codex/codexModelCatalog.js";

export interface CodexModelCatalogRead {
  status: "loading" | "ready" | "error" | "unavailable";
  catalog?: CodexModelCatalog;
  error?: string;
  reload(): void;
  readCurrent(): Promise<CodexModelCatalog>;
}

export function useCodexModelCatalog({
  workspacePath,
  workspaceIdentity,
  remoteSessionId,
  enabled,
}: {
  workspacePath: string;
  workspaceIdentity?: string;
  remoteSessionId?: string | null;
  enabled: boolean;
}): CodexModelCatalogRead {
  const { services, rpcReady } = useWorkspaceServicesResolution(
    workspacePath,
    remoteSessionId,
    workspaceIdentity,
  );
  const [revision, reload] = useReducer((value: number) => value + 1, 0);
  const scope = useMemo(
    () => ({}),
    [services, rpcReady, workspacePath, workspaceIdentity, remoteSessionId, enabled, revision],
  );
  const currentScope = useRef<object | null>(scope);
  currentScope.current = scope;
  useEffect(() => {
    currentScope.current = scope;
    return () => {
      if (currentScope.current === scope) currentScope.current = null;
    };
  }, [scope]);
  const [state, setState] = useState<{
    scope: object;
    catalog?: CodexModelCatalog;
    error?: string;
  }>({ scope });
  const readCurrent = useCallback(async () => {
    if (!enabled || !rpcReady || !workspacePath)
      throw new Error("Codex workspace is not connected");
    const catalog = await readCodexModelCatalog(workspacePath, (request) =>
      services.zcodeAgentService.codexRequest({ workspacePath, workspaceIdentity, request }),
    );
    // 读取期间切 workspace、重启或刷新后，不允许旧 Host 结果放行新任务。
    if (currentScope.current !== scope)
      throw new Error("Codex workspace changed during catalog read");
    return catalog;
  }, [enabled, rpcReady, workspacePath, workspaceIdentity, services, scope]);
  useEffect(() => {
    if (!enabled || !rpcReady || !workspacePath) return;
    let active = true;
    void readCurrent().then(
      (catalog) => {
        if (active) setState({ scope, catalog });
      },
      (error: unknown) => {
        if (active)
          setState({ scope, error: error instanceof Error ? error.message : String(error) });
      },
    );
    return () => {
      active = false;
    };
  }, [enabled, rpcReady, workspacePath, readCurrent, scope]);
  useEffect(() => {
    if (!enabled || !rpcReady) return;
    const subscription = services.zcodeAgentService.onAgentRuntimeRestarted((event) => {
      if (event.workspaceKey === (workspaceIdentity?.trim() || workspacePath)) reload();
    });
    const refresh = () => reload();
    window.addEventListener("focus", refresh);
    return () => {
      subscription.dispose();
      window.removeEventListener("focus", refresh);
    };
  }, [enabled, rpcReady, services, workspacePath, workspaceIdentity]);
  const visible = state.scope === scope ? state : undefined;
  return {
    status:
      !enabled || !rpcReady || !workspacePath
        ? "unavailable"
        : visible?.error
          ? "error"
          : visible?.catalog
            ? "ready"
            : "loading",
    catalog: visible?.catalog,
    error: visible?.error,
    reload,
    readCurrent,
  };
}
