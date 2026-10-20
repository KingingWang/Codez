import { useCallback, useEffect, useMemo, useRef } from "react";
import { useWorkspaceServicesResolution } from "./useWorkspaceServices.js";
import { logger } from "@/logger.js";

interface WorkspaceTabActivation {
  workspacePath: string;
  workspaceIdentity?: string;
  remoteSessionId?: string;
}

interface CodexProjectDiscoveryParams {
  workspacePath?: string | null;
  workspaceIdentity?: string | null;
  remoteSessionId?: string | null;
  activeWorkspaceTab?: WorkspaceTabActivation | null;
  isDesktop?: boolean;
}

interface CodexProjectDiscovery {
  discover(): Promise<void>;
}

interface DiscoveryScope {
  scope: object;
  enabled: boolean;
  workspacePath: string;
  workspaceIdentity?: string;
  remoteSessionId?: string;
  services: ReturnType<typeof useWorkspaceServicesResolution>["services"];
  rpcReady: boolean;
}

/**
 * 显式项目激活/回焦只触发只读 native session/list。
 * UI 不保存列表结果，也不修复订阅；Host 在响应后统一失效现有 index subscribers。
 */
export function useCodexProjectDiscovery({
  workspacePath,
  workspaceIdentity,
  remoteSessionId,
  activeWorkspaceTab,
  isDesktop = false,
}: CodexProjectDiscoveryParams): CodexProjectDiscovery {
  const resolution = useWorkspaceServicesResolution(
    workspacePath,
    remoteSessionId,
    workspaceIdentity,
  );
  const normalizedWorkspaceIdentity = workspaceIdentity?.trim() || undefined;
  const normalizedRemoteSessionId = remoteSessionId?.trim() || undefined;
  const enabled = Boolean(isDesktop && activeWorkspaceTab && workspacePath);
  // activeWorkspaceTab 只做“确有项目被激活”的门禁；实际重扫描边界由 path、identity、
  // remote session 和 services 决定，避免 tab 元数据对象重建触发重复发现。
  const scope = useMemo<DiscoveryScope>(
    () => ({
      scope: {},
      enabled,
      workspacePath: workspacePath!,
      workspaceIdentity: normalizedWorkspaceIdentity,
      remoteSessionId: normalizedRemoteSessionId,
      services: resolution.services,
      rpcReady: resolution.rpcReady,
    }),
    [
      enabled,
      normalizedRemoteSessionId,
      normalizedWorkspaceIdentity,
      resolution.rpcReady,
      resolution.services,
      workspacePath,
    ],
  );
  const scopeRef = useRef(scope);
  scopeRef.current = scope;
  const mountedRef = useRef(false);
  const inflightRef = useRef<{ scope: object; request: Promise<void> } | null>(null);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const discover = useCallback(async (): Promise<void> => {
    const current = scopeRef.current;
    if (!current.enabled || !current.rpcReady) return;
    if (inflightRef.current?.scope === current.scope) return inflightRef.current.request;
    const request = current.services.codezSessionService
      .listSessions({
        workspacePath: current.workspacePath,
        ...(current.workspaceIdentity ? { workspaceIdentity: current.workspaceIdentity } : {}),
      })
      .then(() => undefined)
      .catch((error: unknown) => {
        // 后台发现不能阻塞项目打开。旧 scope/已卸载的迟到异常完全丢弃；
        // 当前 scope 的可恢复失败仅记录生产日志，交由下一次显式激活/回焦重试。
        if (scopeRef.current !== current || !mountedRef.current) return;
        logger.warn("[CodexProjectDiscovery] 项目会话发现失败", {
          error,
          workspacePath: current.workspacePath,
        });
      })
      .finally(() => {
        if (inflightRef.current?.scope === current.scope) inflightRef.current = null;
      });
    inflightRef.current = { scope: current.scope, request };
    return request;
  }, []);

  useEffect(() => {
    if (!scope.enabled) return;
    void discover();
    const onFocus = () => {
      void discover();
    };
    window.addEventListener("focus", onFocus);
    return () => {
      window.removeEventListener("focus", onFocus);
    };
  }, [discover, scope]);

  return { discover };
}
