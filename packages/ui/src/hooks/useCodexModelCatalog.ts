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

interface CodexModelCatalogScopeState {
  scope: object;
  valid: boolean;
  catalog?: CodexModelCatalog;
  inflight?: Promise<CodexModelCatalog>;
}

const CODEX_CATALOG_INVALIDATED_EVENT = "codez:codex-catalog-invalidated";

export function invalidateCodexModelCatalog(): void {
  window.dispatchEvent(new CustomEvent(CODEX_CATALOG_INVALIDATED_EVENT));
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
  const scopeStateRef = useRef<CodexModelCatalogScopeState>({ scope, valid: true });
  if (scopeStateRef.current.scope !== scope) scopeStateRef.current = { scope, valid: true };
  const [publishedScope, setPublishedScope] = useState<{
    scope: object;
    catalog?: CodexModelCatalog;
    error?: string;
  }>({ scope });
  useEffect(() => {
    // StrictMode 会执行 setup→cleanup→setup；setup 必须恢复同一 live entry。
    const entry = scopeStateRef.current;
    entry.valid = true;
    return () => {
      // scope 替换或卸载后，捕获的旧 readCurrent 不能再返回旧目录事实。
      entry.valid = false;
    };
  }, [scope]);
  const readCurrent = useCallback(async () => {
    const current = scopeStateRef.current;
    // Bug 根因：发送路径以前绕过 workspace catalog owner 重复 config+models 网络。
    // 这里只有当前 scope entry 的 ready catalog 能同步返回；reload 在 reducer 提交前
    // 也会先重置 entry，因此旧闭包不能拿上一个 workspace 的结果放行发送。
    if (current.scope !== scope || !current.valid)
      throw new Error("Codex workspace changed during catalog read");
    if (current.catalog) return current.catalog;
    if (!enabled || !rpcReady || !workspacePath)
      throw new Error("Codex workspace is not connected");
    if (current.inflight) return current.inflight;
    const request = readCodexModelCatalog(workspacePath, (request) =>
      services.codezAgentService.codexRequest({ workspacePath, workspaceIdentity, request }),
    ).then(
      (catalog) => {
        if (scopeStateRef.current !== current || !current.valid)
          throw new Error("Codex workspace changed during catalog read");
        current.catalog = catalog;
        current.inflight = undefined;
        return catalog;
      },
      (error: unknown) => {
        if (scopeStateRef.current === current) current.inflight = undefined;
        throw error;
      },
    );
    current.inflight = request;
    return request;
  }, [enabled, rpcReady, workspacePath, workspaceIdentity, services, scope]);
  const reloadNow = useCallback(() => {
    if (scopeStateRef.current.scope !== scope || !scopeStateRef.current.valid) return;
    // useReducer 的失效要到下一次 render 才生效；配置写入后立即发送必须同步作废。
    scopeStateRef.current = { scope, valid: false };
    reload();
  }, [scope]);
  useEffect(() => {
    if (!enabled || !rpcReady || !workspacePath) return;
    let active = true;
    readCurrent().then(
      (catalog) => {
        if (active) setPublishedScope({ scope, catalog });
      },
      (error: unknown) => {
        if (active)
          setPublishedScope({
            scope,
            error: error instanceof Error ? error.message : String(error),
          });
      },
    );
    return () => {
      active = false;
    };
  }, [enabled, rpcReady, workspacePath, readCurrent, scope]);
  useEffect(() => {
    if (!enabled || !rpcReady) return;
    const subscription = services.codezAgentService.onAgentRuntimeRestarted((event) => {
      if (event.workspaceKey === (workspaceIdentity?.trim() || workspacePath)) reloadNow();
    });
    const refresh = () => reloadNow();
    const invalidate = () => reloadNow();
    window.addEventListener("focus", refresh);
    window.addEventListener(CODEX_CATALOG_INVALIDATED_EVENT, invalidate);
    return () => {
      subscription.dispose();
      window.removeEventListener("focus", refresh);
      window.removeEventListener(CODEX_CATALOG_INVALIDATED_EVENT, invalidate);
    };
  }, [enabled, rpcReady, services, workspacePath, workspaceIdentity, reloadNow]);
  const visible = publishedScope.scope === scope ? publishedScope : undefined;
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
    reload: reloadNow,
    readCurrent,
  };
}
