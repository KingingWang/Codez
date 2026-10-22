import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { codexRequestSchema, type CodexRequest } from "@codez/shared";
import { logger } from "@/logger.js";
import { useWorkspaceServicesResolution } from "@/hooks/useWorkspaceServices.js";
import { invalidateCodexModelCatalog } from "@/hooks/useCodexModelCatalog.js";
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
  "hooks",
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
  const { services, rpcReady, isRemoteTarget } = resolution;
  const [runtimeRevision, setRuntimeRevision] = useState(0);
  const workspaceKey = workspaceIdentity?.trim() || workspacePath;
  // 写入目标身份（spec: codex-provider-runtime-env-key「设置页保存事务与 Agent
  // 重启的时序」）：只表达「写到哪台机器/哪个 workspace」，刻意不含 Agent 代际。
  // Key 轮换屏障会在 prepareKeySource 与 config/batchWrite 之间主动停止远端
  // Agent，用带代际的身份守卫写入会在发出 RPC 前把本次保存作废。
  const writeTarget = useMemo(
    () => ({
      services,
      rpcReady,
      workspacePath,
      workspaceIdentity,
    }),
    [services, rpcReady, workspacePath, workspaceIdentity],
  );
  // 读投影代际：换代即丢弃旧快照与草稿（面板 formKey 重挂载）。
  const scope = useMemo(
    () => ({ formKey: crypto.randomUUID() }),
    [writeTarget, resolution.remoteSessionId, runtimeRevision],
  );
  const currentScope = useRef(scope);
  const currentWriteTarget = useRef(writeTarget);
  const mounted = useRef(false);
  const readSequence = useRef(0);
  const mutationLock = useRef(false);
  // 保存事务进行中收到的 runtimeRestarted 只记账，mutation 锁释放后统一应用。
  const deferredRuntimeRestarts = useRef(0);
  const [state, setState] = useState<{
    scope: object;
    errorTarget: object;
    snapshot: CodexSnapshot;
    loading: boolean;
    busy: boolean;
    error?: string;
  }>({ scope, errorTarget: writeTarget, snapshot: EMPTY, loading: false, busy: false });
  const enabled = Boolean(workspacePath && rpcReady);

  useEffect(() => {
    if (!enabled) return;
    const subscription = services.codezAgentService.onAgentRuntimeRestarted((event) => {
      // 相同 workspace 的运行时重启也会使 loginId、配置版本和待处理响应失效。
      if (event.workspaceKey !== workspaceKey) return;
      // Bugfix：轮换屏障停止旧 Agent 是保存事务的正常组成，不是异常。此处立即
      // 换代曾让 config/batchWrite 被身份守卫在发出前作废、面板重挂载丢掉草稿，
      // 表现为 prepareKeySource/finishKeySource 均 OK 但远端 config.toml 一步未改。
      if (mutationLock.current) {
        deferredRuntimeRestarts.current += 1;
        return;
      }
      setRuntimeRevision((revision) => revision + 1);
    });
    return () => subscription.dispose();
  }, [enabled, services, workspaceKey]);

  useEffect(() => {
    mounted.current = true;
    currentScope.current = scope;
    currentWriteTarget.current = writeTarget;
    return () => {
      mounted.current = false;
      readSequence.current += 1;
    };
  }, [scope, writeTarget]);

  const request = useCallback(
    async (request: CodexRequest) => {
      // 只按写入目标身份判定「是否写到错误的机器/workspace」。Agent 代际变化
      // （含本次保存事务自己触发的轮换重启）不作废在途写入。
      if (!mounted.current || currentWriteTarget.current !== writeTarget)
        throw new Error("Codex workspace changed; refresh current state");
      if (!workspacePath || !rpcReady)
        throw new Error("Open a connected workspace to configure Codex");
      const agent = services.codezAgentService;
      // 由 Host 提供该方法；不回退旧配置服务，以免把未接通误报为已保存。
      if (typeof agent.codexRequest !== "function")
        throw new Error("Codex settings bridge is unavailable. Update the desktop runtime.");
      const result = await agent.codexRequest({
        workspacePath,
        workspaceIdentity,
        request: codexRequestSchema.parse(request),
      });
      // 原生全局写入已成功时，即使面板刚卸载/切 workspace，也必须先失效目录。
      // 登录完成的主动刷新同样会改变可用模型，故 account/read 也触发失效。
      if (
        [
          "config/value/write",
          "config/batchWrite",
          "account/login/start",
          "account/logout",
          "account/read",
        ].includes(request.method)
      )
        invalidateCodexModelCatalog();
      if (!mounted.current || currentWriteTarget.current !== writeTarget)
        throw new Error("Codex workspace changed; refresh current state");
      return result;
    },
    [workspacePath, workspaceIdentity, rpcReady, services, writeTarget],
  );

  const refresh = useCallback(async () => {
    if (!enabled || !workspacePath) return;
    const seq = ++readSequence.current;
    setState((previous) => ({
      scope,
      errorTarget: writeTarget,
      // 重读是读取动作，不得抹掉「上一次写入失败」这一事实（spec：失败必须可见）。
      // 事务中延迟应用的 runtimeRestarted 会在锁释放后触发本重读，若在此清空
      // 错误，用户看到的仍是「什么都没发生」。错误只在下一次写入开始时清除。
      error: previous.errorTarget === writeTarget ? previous.error : undefined,
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
  }, [enabled, workspacePath, request, scope, writeTarget]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const run = useCallback(
    async (operation: () => Promise<void>): Promise<boolean> => {
      if (!enabled || mutationLock.current) return false;
      mutationLock.current = true;
      deferredRuntimeRestarts.current = 0;
      // 写入期间作废旧读取，避免旧列表覆盖刚完成的操作结果。
      readSequence.current += 1;
      setState((previous) => ({
        ...previous,
        scope,
        errorTarget: writeTarget,
        busy: true,
        error: undefined,
      }));
      try {
        await operation();
        if (!mounted.current || currentWriteTarget.current !== writeTarget) return false;
        const deferred = deferredRuntimeRestarts.current;
        deferredRuntimeRestarts.current = 0;
        if (deferred > 0) {
          // 事务期间屏障重启了 Agent：现在才换代。换代自身会触发全量重读，
          // 不用旧代际 refresh，否则快照会被写成 EMPTY 并闪一次空列表。
          setRuntimeRevision((revision) => revision + deferred);
          return true;
        }
        await refresh();
        return true;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        // 失败必须可见（spec）：错误按写入目标身份保存，跨读投影换代仍展示。
        if (mounted.current && currentWriteTarget.current === writeTarget) {
          setState((previous) => ({
            ...previous,
            errorTarget: writeTarget,
            loading: false,
            error: message,
          }));
        } else {
          // 面板已随换代重挂载或目标已切换：UI 无处承载，但不能静默吞掉。
          logger.warn("codex-settings.mutation_failed_without_ui_surface", {
            workspaceKey,
            mounted: mounted.current,
            error: message,
          });
        }
        return false;
      } finally {
        mutationLock.current = false;
        const deferred = deferredRuntimeRestarts.current;
        deferredRuntimeRestarts.current = 0;
        if (deferred > 0) setRuntimeRevision((revision) => revision + deferred);
        if (mounted.current) setState((previous) => ({ ...previous, busy: false }));
      }
    },
    [enabled, scope, refresh, writeTarget, workspaceKey],
  );

  return {
    formKey: scope.formKey,
    snapshot: state.scope === scope ? state.snapshot : EMPTY,
    loading: state.scope === scope && state.loading,
    busy: state.busy,
    error: state.errorTarget === writeTarget ? state.error : undefined,
    enabled,
    services,
    remote: isRemoteTarget,
    request,
    refresh,
    run,
  };
}
export type CodexSettingsController = ReturnType<typeof useCodexSettings>;
