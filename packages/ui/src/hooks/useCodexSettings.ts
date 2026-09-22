import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { codexRequestSchema, type CodexRequest } from "@zcode/shared";
import { useWorkspaceServicesResolution } from "@/hooks/useWorkspaceServices.js";
import {
  readCodexResource,
  type CodexResource,
  type CodexSnapshot,
} from "@/settings/codex/codexSettingsData.js";

const RESOURCES: CodexResource[] = [
  "account",
  "models",
  "config",
  "requirements",
  "skills",
  "mcp",
  "plugins",
];
const EMPTY: CodexSnapshot = {};

/** Read projections only. Codex owns accepted mutations and credentials. */
export function useCodexSettings({
  workspacePath,
  workspaceIdentity,
  remoteSessionId,
}: {
  workspacePath?: string | null;
  workspaceIdentity?: string;
  remoteSessionId?: string;
}) {
  const resolution = useWorkspaceServicesResolution(
    workspacePath,
    remoteSessionId,
    workspaceIdentity,
  );
  const { services, rpcReady } = resolution;
  const [runtimeRevision, setRuntimeRevision] = useState(0);
  const workspaceKey = workspaceIdentity?.trim() || workspacePath;
  const scope = useMemo(
    () => ({ formKey: crypto.randomUUID() }),
    [
      services,
      rpcReady,
      workspacePath,
      workspaceIdentity,
      resolution.remoteSessionId,
      runtimeRevision,
    ],
  );
  const currentScope = useRef(scope);
  const mounted = useRef(false);
  const readSequence = useRef(0);
  const mutationLock = useRef(false);
  const [state, setState] = useState<{
    scope: object;
    snapshot: CodexSnapshot;
    loading: boolean;
    busy: boolean;
    error?: string;
  }>({ scope, snapshot: EMPTY, loading: false, busy: false });
  const enabled = Boolean(workspacePath && rpcReady);

  useEffect(() => {
    if (!enabled) return;
    const subscription = services.zcodeAgentService.onAgentRuntimeRestarted((event) => {
      // 相同 workspace 的运行时重启也会使 loginId、配置版本和待处理响应失效。
      if (event.workspaceKey === workspaceKey) setRuntimeRevision((revision) => revision + 1);
    });
    return () => subscription.dispose();
  }, [enabled, services, workspaceKey]);

  useEffect(() => {
    mounted.current = true;
    currentScope.current = scope;
    return () => {
      mounted.current = false;
      readSequence.current += 1;
    };
  }, [scope]);

  const request = useCallback(
    async (request: CodexRequest) => {
      if (!mounted.current || currentScope.current !== scope)
        throw new Error("Codex workspace changed; refresh current state");
      if (!workspacePath || !rpcReady)
        throw new Error("Open a connected workspace to configure Codex");
      const agent = services.zcodeAgentService;
      // 由 Host 提供该方法；不回退旧配置服务，以免把未接通误报为已保存。
      if (typeof agent.codexRequest !== "function")
        throw new Error("Codex settings bridge is unavailable. Update the desktop runtime.");
      const result = await agent.codexRequest({
        workspacePath,
        workspaceIdentity,
        request: codexRequestSchema.parse(request),
      });
      if (!mounted.current || currentScope.current !== scope)
        throw new Error("Codex workspace changed; refresh current state");
      return result;
    },
    [workspacePath, workspaceIdentity, rpcReady, services, scope],
  );

  const refresh = useCallback(async () => {
    if (!enabled || !workspacePath) return;
    const seq = ++readSequence.current;
    setState((previous) => ({
      scope,
      snapshot: previous.scope === scope ? previous.snapshot : EMPTY,
      loading: true,
      busy: mutationLock.current,
    }));
    await Promise.all(
      RESOURCES.map(async (resource) => {
        let value;
        try {
          value = { data: await readCodexResource(resource, workspacePath, request) };
        } catch (error) {
          value = { error: error instanceof Error ? error.message : String(error) };
        }
        if (!mounted.current || currentScope.current !== scope || readSequence.current !== seq)
          return;
        setState((previous) => ({
          ...previous,
          snapshot: { ...previous.snapshot, [resource]: value },
        }));
      }),
    );
    if (!mounted.current || currentScope.current !== scope || readSequence.current !== seq) return;
    setState((previous) => ({ ...previous, scope, loading: false }));
  }, [enabled, workspacePath, request, scope]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const run = useCallback(
    async (operation: () => Promise<void>): Promise<boolean> => {
      if (!enabled || mutationLock.current) return false;
      mutationLock.current = true;
      // 写入期间作废旧读取，避免旧列表覆盖刚完成的操作结果。
      readSequence.current += 1;
      setState((previous) => ({ ...previous, scope, busy: true, error: undefined }));
      try {
        await operation();
        if (!mounted.current || currentScope.current !== scope) return false;
        await refresh();
        return true;
      } catch (error) {
        if (mounted.current && currentScope.current === scope) {
          setState((previous) => ({
            ...previous,
            loading: false,
            error: error instanceof Error ? error.message : String(error),
          }));
        }
        return false;
      } finally {
        mutationLock.current = false;
        if (mounted.current) setState((previous) => ({ ...previous, busy: false }));
      }
    },
    [enabled, scope, refresh],
  );

  return {
    formKey: scope.formKey,
    snapshot: state.scope === scope ? state.snapshot : EMPTY,
    loading: state.scope === scope && state.loading,
    busy: state.busy,
    error: state.scope === scope ? state.error : undefined,
    enabled,
    request,
    refresh,
    run,
  };
}
export type CodexSettingsController = ReturnType<typeof useCodexSettings>;
