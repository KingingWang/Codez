import { useCallback, useEffect, useRef, useState } from "react";
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

/**
 * Codex 子智能体（agent roles）文件列表与变更。
 * 与 useCodexSettings 分离：agents/* 是 Codez bridge 控制面方法族（文件型角色），
 * 不是 Codex 原生资源；变更只影响新会话（角色在线程 config 构建时加载）。
 */
export function useCodexAgents({
  workspacePath,
  workspaceIdentity,
  remoteSessionId,
}: {
  workspacePath?: string | null;
  workspaceIdentity?: string;
  remoteSessionId?: string;
}): CodexAgentsController {
  const resolution = useWorkspaceServicesResolution(
    workspacePath,
    remoteSessionId,
    workspaceIdentity,
  );
  const { services, rpcReady } = resolution;
  const enabled = Boolean(workspacePath && rpcReady);
  const workspaceKey = workspaceIdentity?.trim() || workspacePath || "";
  const [state, setState] = useState<{
    roles: CodezAgentRoleSummary[];
    diagnostics: CodezAgentRoleDiagnostic[];
    loading: boolean;
    busy: boolean;
    error?: string;
  }>({ roles: [], diagnostics: [], loading: false, busy: false });
  const readSequence = useRef(0);
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      readSequence.current += 1;
    };
  }, [workspaceKey, services, rpcReady]);

  const refresh = useCallback(async () => {
    if (!enabled || !workspacePath) return;
    const seq = ++readSequence.current;
    setState((previous) => ({ ...previous, loading: true, error: undefined }));
    try {
      const result = await services.codezAgentService.listAgentRoles({
        workspacePath,
        ...(workspaceIdentity ? { workspaceIdentity } : {}),
      });
      if (!mounted.current || readSequence.current !== seq) return;
      setState((previous) => ({
        ...previous,
        roles: result.roles,
        diagnostics: result.diagnostics,
        loading: false,
      }));
    } catch (error) {
      if (!mounted.current || readSequence.current !== seq) return;
      setState((previous) => ({
        ...previous,
        roles: [],
        diagnostics: [],
        loading: false,
        error: error instanceof Error ? error.message : String(error),
      }));
    }
  }, [enabled, services, workspacePath, workspaceIdentity]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const mutate = useCallback(
    async (operation: () => Promise<unknown>): Promise<boolean> => {
      if (!enabled || state.busy) return false;
      // 写入期间作废旧读取，避免旧列表覆盖刚完成的变更。
      readSequence.current += 1;
      setState((previous) => ({ ...previous, busy: true, error: undefined }));
      try {
        await operation();
      } catch (error) {
        logger.warn("codex agents mutation failed", {
          workspaceKey,
          errorMessage: error instanceof Error ? error.message : String(error),
        });
        if (mounted.current) {
          setState((previous) => ({
            ...previous,
            busy: false,
            error: error instanceof Error ? error.message : String(error),
          }));
        }
        return false;
      }
      if (!mounted.current) return false;
      setState((previous) => ({ ...previous, busy: false }));
      await refresh();
      return true;
    },
    [enabled, state.busy, refresh, workspaceKey],
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
    roles: state.roles,
    diagnostics: state.diagnostics,
    refresh,
    saveRole,
    deleteRole,
  };
}
