import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import {
  isModelSelectionViewForWorkspace,
  type IModelSelectionService,
  type ModelSelectionView,
  type ModelSelectionViewInput,
} from "@codez/services";
import { useWorkspaceServicesResolution } from "@/hooks/useWorkspaceServices.js";
import { logger } from "@/logger.js";

type ModelSelectionCatalog = Pick<ModelSelectionView, "revision" | "providers">;

export type ModelSelectionState =
  | { status: "loading"; catalog?: ModelSelectionCatalog }
  | { status: "ready"; view: ModelSelectionView; refreshError?: { revision: number; error: Error } }
  | { status: "unavailable"; reason: "remote-waiting" | "missing-target" }
  | { status: "error"; error: Error };

export type ModelSelectionRefreshResult =
  | { kind: "ready"; view: ModelSelectionView }
  | { kind: "superseded" };

export interface ModelSelectionRead {
  state: ModelSelectionState;
  reload(): void;
  refresh(): Promise<ModelSelectionRefreshResult>;
}

/** 目标 Host 的模型事实按 workspace 读取；无显式选择输入的旧调用保持原行为。 */
export function attachWorkspaceToModelSelectionInput(
  input: ModelSelectionViewInput | undefined,
  workspacePath: string | null | undefined,
  workspaceIdentity?: string | null,
): ModelSelectionViewInput | undefined {
  if (!input || !workspacePath?.trim()) return input;
  // Codex Host 缺 workspace 会返回空目录，导致自动化表单无模型且创建按钮禁用。
  // 由此处唯一地把 hook 的目标 workspace 传给既有 getView 入参，切项目时旧请求仍由
  // useModelSelectionServiceView 的 generation/inputKey 守卫丢弃。
  return {
    ...input,
    workspace: {
      workspacePath,
      ...(workspaceIdentity?.trim() ? { workspaceIdentity: workspaceIdentity.trim() } : {}),
    },
  };
}

interface OwnedModelSelectionState {
  service: IModelSelectionService | null;
  enabled: boolean;
  unavailableReason: "remote-waiting" | "missing-target";
  inputKey: string | undefined;
  state: ModelSelectionState;
}

// 首读的临时 IO 失败未必产生 Provider 变化事件；只重读两次，不轮询业务状态或重试写操作。
const INITIAL_READ_RETRY_DELAYS = [500, 1500] as const;
function isTransientReadError(cause: unknown): boolean {
  if (!cause || typeof cause !== "object") return false;
  const error = cause as { code?: unknown; name?: unknown; message?: unknown };
  return (
    ["ECONNRESET", "ETIMEDOUT", "ECONNREFUSED", "EAI_AGAIN"].includes(String(error.code)) ||
    (error.name === "TypeError" &&
      ["Failed to fetch", "fetch failed", "Load failed"].includes(String(error.message)))
  );
}

function initialState(
  service: IModelSelectionService | null,
  enabled: boolean,
  unavailableReason: "remote-waiting" | "missing-target",
  catalog?: ModelSelectionCatalog,
): ModelSelectionState {
  return enabled && service
    ? { status: "loading", ...(catalog ? { catalog } : {}) }
    : { status: "unavailable", reason: unavailableReason };
}

function retainedCatalog(
  previous: OwnedModelSelectionState,
  service: IModelSelectionService | null,
  enabled: boolean,
  unavailableReason: "remote-waiting" | "missing-target",
): ModelSelectionCatalog | undefined {
  if (
    previous.service !== service ||
    previous.enabled !== enabled ||
    previous.unavailableReason !== unavailableReason
  )
    return undefined;
  // 调档/换模型只改变解析输入；清空同 Host 目录会让菜单收缩闪烁。
  // 仅保留目录，绝不把旧 effectiveSelection 当作新选择的解析结果。
  if (previous.state.status === "ready") {
    const { revision, providers } = previous.state.view;
    return { revision, providers };
  }
  return previous.state.status === "loading" ? previous.state.catalog : undefined;
}

/** 订阅明确 Host Service；返回状态在同一次 render 即绑定新 owner，不暴露旧 Host View。 */
export function useModelSelectionServiceView(
  service: IModelSelectionService | null | undefined,
  enabled = true,
  unavailableReason: "remote-waiting" | "missing-target" = "remote-waiting",
  input?: ModelSelectionViewInput,
  /**
   * 当前消费者的 workspace 身份 key。Codex 原生 Host 的模型事实与 revision 都是
   * per-workspace 的：跨 workspace 的变更事件必须先按身份过滤，否则别处的 revision
   * 会压住本 workspace 的读取。legacy Registry 事件是 Host 全局的，总是接受。
   */
  eventWorkspaceKey?: string,
): ModelSelectionRead {
  const normalizedService = service ?? null;
  // 调用方可每次 render 创建参数对象；所有权按选择内容绑定，不按对象引用反复订阅。
  const inputKey = input === undefined ? undefined : JSON.stringify(input);
  const stableInput = useMemo(() => input, [inputKey]);
  const [reloadVersion, reload] = useReducer((value: number) => value + 1, 0);
  const [owned, setOwned] = useState<OwnedModelSelectionState>(() => ({
    service: normalizedService,
    enabled,
    unavailableReason,
    inputKey,
    state: initialState(normalizedService, enabled, unavailableReason),
  }));
  const ownedRef = useRef(owned);
  ownedRef.current = owned;
  const generationRef = useRef(0);
  const readRef = useRef<(() => Promise<ModelSelectionRefreshResult>) | null>(null);
  const ownerMatches =
    owned.service === normalizedService &&
    owned.enabled === enabled &&
    owned.inputKey === inputKey &&
    owned.unavailableReason === unavailableReason;
  const visibleState = ownerMatches
    ? owned.state
    : initialState(
        normalizedService,
        enabled,
        unavailableReason,
        retainedCatalog(owned, normalizedService, enabled, unavailableReason),
      );

  useEffect(() => {
    generationRef.current += 1;
    const generation = generationRef.current;
    const previous = ownedRef.current;
    const catalog = retainedCatalog(previous, normalizedService, enabled, unavailableReason);
    const retainedReady =
      previous.service === normalizedService &&
      previous.enabled === enabled &&
      previous.inputKey === inputKey &&
      previous.unavailableReason === unavailableReason &&
      previous.state.status === "ready"
        ? previous.state
        : null;
    setOwned({
      service: normalizedService,
      enabled,
      unavailableReason,
      inputKey,
      state: retainedReady ?? initialState(normalizedService, enabled, unavailableReason, catalog),
    });
    if (!enabled || !normalizedService) return;

    let latestRevision = retainedReady?.view.revision ?? catalog?.revision ?? -1;
    let hasReadyView = retainedReady !== null;
    let requestId = 0;
    let retryCount = 0;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    const cancelRetry = () => {
      if (retryTimer !== undefined) clearTimeout(retryTimer);
      retryTimer = undefined;
    };
    const commit = (candidate: ModelSelectionView): void => {
      if (generation !== generationRef.current || candidate.revision < latestRevision) return;
      latestRevision = candidate.revision;
      hasReadyView = true;
      cancelRetry();
      setOwned({
        service: normalizedService,
        enabled,
        unavailableReason,
        inputKey,
        state: { status: "ready", view: candidate },
      });
    };
    const read = (): Promise<ModelSelectionRefreshResult> => {
      cancelRetry();
      const request = ++requestId;
      return normalizedService.getView(stableInput).then(
        (candidate) => {
          if (generation !== generationRef.current || request !== requestId)
            return { kind: "superseded" };
          commit(candidate);
          return { kind: "ready", view: candidate };
        },
        (cause: unknown) => {
          // 原因：旧读取虽不能写展示 state，其 rejection 仍会被等待它的 Composer 当成当前失败。
          // owner 明确返回已被取代回执；仅当前读取失败才发布失败并拒绝。
          if (generation !== generationRef.current || request !== requestId)
            return { kind: "superseded" };
          const error = cause instanceof Error ? cause : new Error(String(cause));
          logger.warn("[model-selection] 目标 Host View 读取失败", { error });
          // 原因：保留旧 ready 不能吞掉新 revision 的失败，否则连接切换会永久等待。
          // 失败与当前 service/input 及事件 revision 绑定；保留旧目录，成功重读清除回执。
          if (hasReadyView) {
            setOwned((previous) =>
              previous.state.status === "ready"
                ? {
                    ...previous,
                    state: { ...previous.state, refreshError: { revision: latestRevision, error } },
                  }
                : previous,
            );
          } else {
            setOwned({
              service: normalizedService,
              enabled,
              unavailableReason,
              inputKey,
              state: { status: "error", error },
            });
            const delay = INITIAL_READ_RETRY_DELAYS[retryCount];
            if (delay !== undefined && isTransientReadError(cause)) {
              retryCount += 1;
              retryTimer = setTimeout(() => {
                void read().catch(() => {});
              }, delay);
            }
          }
          throw error;
        },
      );
    };
    // 原因：相同目录不会再发事件；显式重读与订阅读取共享请求序号，迟到旧失败不能覆盖重试。
    readRef.current = read;
    const subscription = normalizedService.onDidChange((candidate) => {
      if (generation !== generationRef.current) return;
      // 跨 workspace 事件不属于本消费者；在比较 revision 之前按身份过滤，
      // 否则别处的 revision 会压住本 workspace 的读取结果。
      if (!isModelSelectionViewForWorkspace(candidate, eventWorkspaceKey)) return;
      if (stableInput === undefined) commit(candidate);
      else {
        // 公共事件没有某个调用者的原意图；只能用它触发当前输入重读，不能直接接管结果。
        latestRevision = Math.max(latestRevision, candidate.revision);
        void read().catch(() => {});
      }
    });
    void read().catch(() => {});
    return () => {
      generationRef.current += 1;
      if (readRef.current === read) readRef.current = null;
      cancelRetry();
      subscription.dispose();
    };
  }, [
    enabled,
    normalizedService,
    reloadVersion,
    unavailableReason,
    inputKey,
    stableInput,
    eventWorkspaceKey,
  ]);

  return {
    state: visibleState,
    reload: useCallback(() => reload(), []),
    refresh: useCallback(
      () =>
        readRef.current
          ? readRef.current()
          : Promise.reject(new Error("Model selection owner unavailable")),
      [],
    ),
  };
}

/** 模型候选只来自明确 Workspace Target；等待远端时不读取 Local/Base Host。 */
export function useModelSelectionView(
  workspacePath: string | null | undefined,
  remoteSessionId?: string | null,
  workspaceIdentity?: string | null,
  remoteTarget?: unknown,
  input?: ModelSelectionViewInput,
): ModelSelectionRead {
  const hasTarget = Boolean(workspacePath?.trim() || workspaceIdentity?.trim());
  const resolution = useWorkspaceServicesResolution(
    workspacePath,
    remoteSessionId,
    workspaceIdentity,
    remoteTarget,
  );
  const remoteWaiting = resolution.connectionKind === "remote-waiting";
  // 与 Host 侧身份口径一致：identity 优先，回退路径。
  const eventWorkspaceKey = hasTarget
    ? workspaceIdentity?.trim() || workspacePath || undefined
    : undefined;
  const scopedInput = attachWorkspaceToModelSelectionInput(input, workspacePath, workspaceIdentity);
  return useModelSelectionServiceView(
    resolution.services.modelSelectionService,
    hasTarget && !remoteWaiting,
    hasTarget ? "remote-waiting" : "missing-target",
    scopedInput,
    eventWorkspaceKey,
  );
}
