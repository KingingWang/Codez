import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  CodezAgentRoleDiagnostic,
  CodezAgentRoleScope,
  CodezAgentRoleSummary,
  CodezAgentRoleWriteInput,
} from "@codez/shared";
import { useWorkspaceServicesResolution } from "@/hooks/useWorkspaceServices.js";
import { logger } from "@/logger.js";

export interface CodexAgentsController {
  enabled: boolean;
  loading: boolean;
  busy: boolean;
  error?: string;
  readFailed: boolean;
  roles: CodezAgentRoleSummary[];
  diagnostics: CodezAgentRoleDiagnostic[];
  refresh: () => Promise<void>;
  saveRole: (input: {
    scope: CodezAgentRoleScope;
    originalName?: string;
    role: CodezAgentRoleWriteInput;
  }) => Promise<boolean>;
  deleteRole: (input: { scope: CodezAgentRoleScope; name: string }) => Promise<boolean>;
}

type CodexAgentsState = {
  scope: object;
  roles: CodezAgentRoleSummary[];
  diagnostics: CodezAgentRoleDiagnostic[];
  loading: boolean;
  busy: boolean;
  error?: string;
  errorKind?: "read" | "mutation";
};

/**
 * Codex 子智能体（agent roles）文件列表与变更。
 * 与 useCodexSettings 分离：agents/* 是 Codez bridge 控制面方法族（文件型角色），
 * 不是 Codex 原生资源；变更只影响新会话（角色在线程 config 构建时加载）。
 */
export function useCodexAgents({
  workspacePath,
  workspaceIdentity,
  remoteSessionId,
  enabled: requestedEnabled = true,
}: {
  workspacePath?: string | null;
  workspaceIdentity?: string;
  remoteSessionId?: string;
  enabled?: boolean;
}): CodexAgentsController {
  const resolution = useWorkspaceServicesResolution(
    workspacePath,
    remoteSessionId,
    workspaceIdentity,
  );
  const { services, rpcReady } = resolution;
  const enabled = Boolean(requestedEnabled && workspacePath && rpcReady);
  const workspaceKey = workspaceIdentity?.trim() || workspacePath || "";
  // 菜单常驻时会切换 workspace/attachment；scope 不匹配的缓存连一帧也不能作为新候选返回。
  const scope = useMemo(
    () => ({}),
    [enabled, workspacePath, workspaceIdentity, services, resolution.remoteSessionId],
  );
  const currentScope = useRef(scope);
  currentScope.current = scope;
  const [storedState, setState] = useState<CodexAgentsState>({
    scope,
    roles: [],
    diagnostics: [],
    loading: enabled,
    busy: false,
  });
  const state: CodexAgentsState =
    storedState.scope === scope
      ? storedState
      : { scope, roles: [], diagnostics: [], loading: enabled, busy: false };
  const readSequence = useRef(0);
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      readSequence.current += 1;
    };
  }, [scope]);

  const refresh = useCallback(async () => {
    if (!enabled || !workspacePath) return;
    const seq = ++readSequence.current;
    setState((previous) => ({
      ...previous,
      scope,
      roles: previous.scope === scope ? previous.roles : [],
      diagnostics: previous.scope === scope ? previous.diagnostics : [],
      busy: previous.scope === scope && previous.busy,
      loading: true,
      error: undefined,
      errorKind: undefined,
    }));
    try {
      const result = await services.codezAgentService.listAgentRoles({
        workspacePath,
        ...(workspaceIdentity ? { workspaceIdentity } : {}),
      });
      if (!mounted.current || readSequence.current !== seq) return;
      setState((previous) => ({
        ...previous,
        scope,
        roles: result.roles,
        diagnostics: result.diagnostics,
        loading: false,
        errorKind: undefined,
      }));
    } catch (error) {
      if (!mounted.current || readSequence.current !== seq) return;
      setState((previous) => ({
        ...previous,
        scope,
        roles: [],
        diagnostics: [],
        loading: false,
        error: error instanceof Error ? error.message : String(error),
        errorKind: "read",
      }));
    }
  }, [enabled, services, workspacePath, workspaceIdentity, scope]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const mutate = useCallback(
    async (operation: () => Promise<unknown>): Promise<boolean> => {
      if (!enabled || state.busy || state.loading || state.errorKind === "read") return false;
      // 写入期间作废旧读取，避免旧列表覆盖刚完成的变更。
      readSequence.current += 1;
      setState((previous) => ({
        ...previous,
        busy: true,
        error: undefined,
        errorKind: undefined,
      }));
      try {
        await operation();
      } catch (error) {
        logger.warn("codex agents mutation failed", {
          workspaceKey,
          errorMessage: error instanceof Error ? error.message : String(error),
        });
        if (mounted.current && currentScope.current === scope) {
          setState((previous) => ({
            ...previous,
            busy: false,
            error: error instanceof Error ? error.message : String(error),
            errorKind: "mutation",
          }));
        }
        return false;
      }
      if (!mounted.current || currentScope.current !== scope) return false;
      setState((previous) => ({ ...previous, busy: false }));
      await refresh();
      return true;
    },
    [enabled, state.busy, state.loading, state.errorKind, refresh, workspaceKey, scope],
  );

  const saveRole = useCallback(
    async (input: {
      scope: CodezAgentRoleScope;
      originalName?: string;
      role: CodezAgentRoleWriteInput;
    }) => {
      if (!workspacePath) return false;
      return mutate(() =>
        services.codezAgentService.writeAgentRole({
          workspacePath,
          ...(workspaceIdentity ? { workspaceIdentity } : {}),
          scope: input.scope,
          ...(input.originalName ? { originalName: input.originalName } : {}),
          role: input.role,
        }),
      );
    },
    [mutate, services, workspacePath, workspaceIdentity],
  );

  const deleteRole = useCallback(
    async (input: { scope: CodezAgentRoleScope; name: string }) => {
      if (!workspacePath) return false;
      return mutate(() =>
        services.codezAgentService.deleteAgentRole({
          workspacePath,
          ...(workspaceIdentity ? { workspaceIdentity } : {}),
          scope: input.scope,
          name: input.name,
        }),
      );
    },
    [mutate, services, workspacePath, workspaceIdentity],
  );

  return {
    enabled,
    loading: state.loading,
    busy: state.busy,
    error: state.error,
    readFailed: state.errorKind === "read",
    roles: state.roles,
    diagnostics: state.diagnostics,
    refresh,
    saveRole,
    deleteRole,
  };
}
