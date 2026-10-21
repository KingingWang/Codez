import {
  resolveCodexSelection,
  type CodexModelCatalog,
} from "@/settings/codex/codexModelCatalog.js";
/* eslint-disable max-lines -- Composer 草稿 owner 同时收口选择、正文与提交生命周期，保持单一状态边界。 */
// 当前编辑由 Composer 持有；进入已有 Session 从当前快照恢复权限/Plan，在线只响应新变化。
// 菜单点击立即保存 Renderer 意图，Prewarm 与 Submission 只消费它，不反向覆盖。
//
// Workspace presentation 水合只提供 mode 与 slash commands；模型候选、能力和首选值
// 统一来自目标 Host ModelSelectionView。
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { resolveCodexPrewarmConfig } from "@/settings/codex/codexSubmissionSettings.js";
import { CODEZ_AGENT_PROVIDER, resolveExecutionState } from "@codez/shared";
import type {
  CodezConfigOption,
  ModelSelection,
  CodezProvider,
  CodezSlashCommand,
} from "@codez/shared";
import type { SessionConfigState } from "@codez/shared/codez-protocol-v4";
import type { IModelSelectionService } from "@codez/services";
import { completeNewModelSelection } from "@codez/provider";
import {
  useModelSelectionServiceView,
  type ModelSelectionRead,
} from "@/hooks/useModelSelectionView.js";
import { submissionModeSchema } from "@codez/shared/codez-protocol-v4";
import { prepareWorkspaceWithCodezSessionService } from "@/hooks/useWorkspacePrepare.js";
import { useCodezSessionService } from "@/hooks/useCodezSessionService.js";
import { useSettings } from "@/hooks/useSettingService.js";
import { useOptionalBaseWorkspaceServices } from "@/hooks/useWorkspaceServices.js";
import { parseModelPickerValue } from "@/lib/codezSessionProjection.js";
import { resolveDraftInitialModelSelection } from "@/lib/composerRecent.js";
import { initializeNewTaskDraft } from "@/v4/composer/newTaskDraft.js";
import { useComposerClientNamespace } from "@/hooks/useServices.js";
import { resolveComposerScope, composerScopeKey } from "@/v4/composer/composerDraftStore.js";
import { normalizeComposerDraftMode } from "@/v4/composer/composerDraftModeNormalization.js";
import {
  clearV4ComposerDraft,
  persistV4ComposerDraft,
  readV4ComposerDraft,
  V4_DRAFT_SCOPE_ROOT,
  type V4ComposerDraft,
} from "@/v4/composer/composerDraftStore.js";
import { resolveAppFollowupMode } from "@/v4/composer/followupModeSettings.js";
import { logger } from "@/logger.js";
import { useCodezSessionStore } from "@/store/codezSessionStore.js";

/** 目录水合单飞（per workspaceKey）：draft、已有 session 和严格模式双挂载共享一次 RPC。 */
const workspaceCatalogHydrationFlights = new Map<string, Promise<void>>();

export function applyDraftModelSelection(
  current: Partial<SessionConfigState>,
  model: ModelSelection,
): Partial<SessionConfigState> {
  const next = {
    ...current,
    modelSelection: {
      providerId: model.providerId,
      modelId: model.modelId,
      ...(model.options ? { options: { ...model.options } } : {}),
    },
    provider: model.providerId,
    model: model.modelId,
  };
  // thought 是模型的附属配置。切模型后保留源 thought 会让首发前配置屏障
  // 在目标模型已切成功后把它当成“同模型显式切 thought”再次写入，必须先清除。
  delete next.thought;
  return next;
}

export function shouldHydrateWorkspaceCatalog(params: {
  configOptions: readonly CodezConfigOption[];
  sessionId: string | null;
  slashCommands: readonly CodezSlashCommand[];
}): boolean {
  const hasModePresentation = params.configOptions.some(
    (option) => option.category === "mode" && option.type === "select",
  );
  // slashCommands 属于 workspace identity，不会随已有 session projection 恢复。
  // 因此已有 session 只要目录为空也必须独立水合；mode 目录也不再借模型目录间接提供。
  return params.slashCommands.length === 0 || !hasModePresentation;
}

function resolveSessionConfigModelSelection(params: {
  sessionConfig: Partial<SessionConfigState> | null | undefined;
  codex: boolean;
  codexUsesCatalog: boolean;
  codexCatalog?: CodexModelCatalog;
}): ModelSelection | undefined {
  const { sessionConfig, codex, codexUsesCatalog, codexCatalog } = params;
  if (!sessionConfig) return undefined;
  const raw =
    sessionConfig.modelSelection ??
    (codex &&
    sessionConfig.model &&
    (sessionConfig.provider || (codexUsesCatalog ? codexCatalog?.providerId : undefined))
      ? {
          providerId: (sessionConfig.provider || codexCatalog?.providerId)!,
          modelId: sessionConfig.model,
          ...(sessionConfig.thought ? { options: { reasoningLevel: sessionConfig.thought } } : {}),
        }
      : undefined);
  if (codexUsesCatalog && codexCatalog) {
    return resolveCodexSelection(codexCatalog, raw) ?? undefined;
  }
  return raw;
}

function buildCodexSessionConfigSyncKey(
  sessionConfig: Partial<SessionConfigState> | null | undefined,
  fallbackProviderId?: string,
): string | undefined {
  if (!sessionConfig) return undefined;
  const mode = submissionModeSchema.safeParse(sessionConfig.mode);
  const planEnabled = resolveExecutionState(sessionConfig).planEnabled;
  const provider =
    sessionConfig.modelSelection?.providerId ?? sessionConfig.provider ?? fallbackProviderId ?? "";
  const model = sessionConfig.modelSelection?.modelId ?? sessionConfig.model ?? "";
  const thought =
    sessionConfig.modelSelection?.options?.reasoningLevel ?? sessionConfig.thought ?? "";
  if (!mode.success && !model) return undefined;
  return JSON.stringify([mode.success ? mode.data : "", planEnabled, provider, model, thought]);
}

function applyCodexSessionConfigSync(params: {
  draft: V4ComposerDraft;
  initialization: "new-task" | "session" | "promotion";
  sessionId: string | null;
  sessionConfig: Partial<SessionConfigState> | null | undefined;
  codex: boolean;
  codexUsesCatalog: boolean;
  codexCatalog?: CodexModelCatalog;
}): V4ComposerDraft {
  const { draft, initialization, sessionId, sessionConfig, codex, codexUsesCatalog, codexCatalog } =
    params;
  if (!codex || !sessionId || initialization === "new-task" || !draft.mode || !sessionConfig) {
    return draft;
  }
  if (codexUsesCatalog && !codexCatalog) return draft;
  const syncKey = buildCodexSessionConfigSyncKey(sessionConfig, codexCatalog?.providerId);
  if (!syncKey) return draft;
  // 存量草稿首次观测到权威快照时先对齐一次基线；后续仅在权威配置发生实质推进时同步，
  // 重复快照不会覆盖用户在本端尚未发送的菜单选择。
  if (draft.lastSyncedSessionConfigKey === syncKey) return draft;
  const mode = submissionModeSchema.safeParse(sessionConfig.mode);
  const nextMode = mode.success && mode.data !== "plan" ? mode.data : draft.mode;
  const nextPlanEnabled = resolveExecutionState(sessionConfig).planEnabled;
  const nextSelection =
    resolveSessionConfigModelSelection({
      sessionConfig,
      codex,
      codexUsesCatalog,
      codexCatalog,
    }) ?? draft.modelSelection;
  return {
    ...draft,
    mode: nextMode,
    permissionModeGen: 2 as const,
    planEnabled: nextPlanEnabled,
    ...(nextSelection ? { modelSelection: nextSelection } : {}),
    lastSyncedSessionConfigKey: syncKey,
  };
}

export interface DraftConfigControl {
  modelSelectionRead: ModelSelectionRead;
  /** Renderer 下一次提交的配置；恢复采用当前权限，在线授权只同步对应字段。 */
  draftConfig: Partial<SessionConfigState>;
  /** 草稿已选 config（partial）；createSession 时经 buildDraftCreateConfigPayload 携带。 */
  draftConfigRef: React.RefObject<Partial<SessionConfigState>>;
  /** 当前草稿生命周期冻结的初始化 config；只供 prewarm/createSession 建立时使用。 */
  resolveInitialDraftConfig: () => Partial<SessionConfigState> | undefined;
  composerDraft: V4ComposerDraft;
  updateComposerContent: (
    content: Pick<V4ComposerDraft, "text" | "editorStateJson" | "mention">,
  ) => void;
  replaceComposerDraft: (draft: Omit<V4ComposerDraft, "updatedAt">) => void;
  /** 新任务被接纳后，把当前完整 Root Draft 原子式转移到真实 Session scope。 */
  promoteComposerDraft: (createdSessionId: string) => void;
  /** 在提交前捕获原意图；只在权威 accepted 后调用返回函数。 */
  captureAcceptedModelSelection: (
    selection: ModelSelection,
    expectedSelection?: ModelSelection,
  ) => () => void;
  handleDraftSelectModel: (modelProvider: string, model: string, reasoningLevel?: string) => void;
  handleDraftSelectThought: (thought: string) => void;
  handleDraftSwitchMode: (mode: string) => void;
}

interface ComposerState {
  scopeKey: string;
  workspaceKey: string;
  draft: V4ComposerDraft;
  initialization: "new-task" | "session" | "promotion";
  observedConfig?: { permissionGrantId?: string; planTransitionId?: string };
  promotedSessionId?: string;
}

export function useDraftConfigControl(params: {
  workspacePath: string;
  workspaceIdentity?: string;
  provider?: CodezProvider;
  /** 会话切换恢复文字/模型，权限和 Plan 使用当前快照。 */
  sessionId: string | null;
  /** 仅匹配当前 Session 的首份投影可用作初始化；null 表示还没恢复完成。 */
  sessionConfig?: Partial<SessionConfigState> | null;
  /** provider registry 已通过 renderer readiness 门禁后才允许拉起 Agent。 */
  agentStartupAllowed?: boolean;
  modelSelectionService: IModelSelectionService | null;
  codex?: boolean;
  codexCatalog?: CodexModelCatalog;
  /**
   * 桌面端通过 codexCatalog 直接解析模型；手机远控无本地 catalog，
   * 仍需订阅 Host 的 IModelSelectionService（createCodexModelSelectionService）。
   */
  codexUsesCatalog?: boolean;
  /** Approve for me 能力（autoReviewApprovals）；未确认时 codex 草稿的 edit 归一化为 custom。 */
  codexAutoReviewSupported?: boolean;
}): DraftConfigControl {
  const {
    workspacePath,
    workspaceIdentity,
    provider,
    sessionId,
    sessionConfig,
    agentStartupAllowed = true,
    modelSelectionService,
    codex = false,
    codexCatalog,
    codexUsesCatalog = codex,
    codexAutoReviewSupported = false,
  } = params;
  const workspaceKey = workspaceIdentity?.trim() || workspacePath;
  const displayProvider = provider ?? CODEZ_AGENT_PROVIDER;
  const codezSessionService = useCodezSessionService(workspacePath, null, workspaceIdentity);
  const baseWorkspaceServices = useOptionalBaseWorkspaceServices();
  // 修复原因：草稿初始化与预热在远端工作区下同样需要读取控制端保存的交互行为偏好，
  // 不能回退读取远端 Source Server 的默认 queue 设置。
  const { settings: sharedSettings } = useSettings(
    baseWorkspaceServices ? { services: baseWorkspaceServices } : {},
  );
  const appFollowupMode = resolveAppFollowupMode(sharedSettings);
  const scopeId = sessionId ?? V4_DRAFT_SCOPE_ROOT;
  const clientNamespace = useComposerClientNamespace();
  const draftProjectId = useCodezSessionStore(
    (state) => state.workspaces[workspaceKey]?.draftProjectId,
  );
  const rootScope = useMemo(
    () => resolveComposerScope(draftProjectId, workspaceIdentity, clientNamespace),
    [draftProjectId, workspaceIdentity, clientNamespace],
  );
  const draftFocusVersion = useCodezSessionStore((state) =>
    sessionId === null ? (state.workspaces[workspaceKey]?.draftFocusVersion ?? 0) : 0,
  );
  // New Task 可以复用同一个 pane；无文字时必须重新取 Recent，不能只清磁盘留旧内存。
  const scopeKey = JSON.stringify([
    workspaceKey,
    scopeId,
    draftFocusVersion,
    sessionId === null ? composerScopeKey(rootScope) : null,
  ]);
  const navigationInitialization = useCodezSessionStore((state) => {
    const workspace = state.workspaces[workspaceKey];
    return workspace?.activeTaskId === sessionId &&
      workspace?.composerInitialization?.taskId === sessionId
      ? workspace.composerInitialization
      : undefined;
  });
  const loadedScope = useMemo<ComposerState>(() => {
    const saved = readV4ComposerDraft(workspacePath, workspaceIdentity, scopeId, rootScope);
    return {
      scopeKey,
      workspaceKey,
      draft: saved ?? { text: "", updatedAt: 0, ...navigationInitialization?.config },
      initialization:
        sessionId === null || (!saved && navigationInitialization) ? "new-task" : "session",
    };
  }, [scopeKey]);
  const [storedState, setStoredState] = useState(loadedScope);
  // 首发是同一 pane 的地址迁移，保持其间的新编辑；换页或卸载不保留第二份配置。
  let currentState: ComposerState =
    storedState.scopeKey === scopeKey
      ? storedState
      : storedState.workspaceKey === workspaceKey && storedState.promotedSessionId === sessionId
        ? {
            ...storedState,
            scopeKey,
            initialization: "promotion",
            observedConfig: undefined,
            promotedSessionId: undefined,
          }
        : loadedScope;
  let draft = currentState.draft;
  const modelSelectionRead = useModelSelectionServiceView(
    modelSelectionService,
    !codexUsesCatalog,
    "remote-waiting",
    {
      selection: draft.modelSelection ?? null,
      // Codex 原生 Host 按 workspace 解析模型事实；legacy Registry 忽略此字段。
      workspace: {
        workspacePath,
        ...(workspaceIdentity ? { workspaceIdentity } : {}),
      },
    },
    // 事件按 workspace 身份过滤，跨 workspace 的变更不会压住本草稿的读取。
    workspaceKey,
  );
  const modelSelectionView =
    modelSelectionRead.state.status === "ready" ? modelSelectionRead.state.view : null;
  const initializeAsNewTask = currentState.initialization === "new-task";
  if (
    !draft.mode &&
    (codexUsesCatalog
      ? codexCatalog !== undefined && (initializeAsNewTask || sessionConfig != null)
      : initializeAsNewTask
        ? modelSelectionView !== null
        : sessionConfig != null)
  ) {
    const mode = submissionModeSchema.safeParse(sessionConfig?.mode);
    const initialSyncKey =
      codex && !initializeAsNewTask
        ? buildCodexSessionConfigSyncKey(sessionConfig, codexCatalog?.providerId)
        : undefined;
    // Recent 是初始化原意图，不先按旧 Provider 是否仍在候选中删掉；下一次输入读取
    // 由同一解析入口对应当前账号，或暂时留空。否则冷启动会绕过统一账号对应规则。
    // mode 是已初始化标记：历史恢复给出的空选择也是确定结果，后续 Snapshot 不得填满。
    draft =
      codexUsesCatalog && codexCatalog
        ? {
            ...draft,
            // 恢复原生会话必须保留权限/plan；强制默认会让 busy guide 与线程设置不一致。
            // Codex 新任务默认 custom（跟随 config.toml，不静默覆盖用户权限配置）。
            mode:
              !initializeAsNewTask && mode.success && mode.data !== "plan" ? mode.data : "custom",
            permissionModeGen: 2 as const,
            planEnabled:
              !initializeAsNewTask && resolveExecutionState(sessionConfig ?? {}).planEnabled,
            modelSelection:
              resolveCodexSelection(
                codexCatalog,
                draft.modelSelection ??
                  resolveSessionConfigModelSelection({
                    sessionConfig,
                    codex,
                    codexUsesCatalog,
                    codexCatalog,
                  }),
              ) ?? undefined,
            ...(initialSyncKey ? { lastSyncedSessionConfigKey: initialSyncKey } : {}),
          }
        : initializeAsNewTask && modelSelectionView
          ? initializeNewTaskDraft(
              draft,
              workspacePath,
              workspaceIdentity,
              modelSelectionView,
              rootScope,
              {
                codex,
              },
            )
          : {
              ...draft,
              mode: mode.success && mode.data !== "plan" ? mode.data : codex ? "custom" : "build",
              ...(codex ? { permissionModeGen: 2 as const } : {}),
              planEnabled: resolveExecutionState(sessionConfig ?? {}).planEnabled,
              modelSelection: resolveSessionConfigModelSelection({
                sessionConfig,
                codex,
                codexUsesCatalog,
                codexCatalog,
              }),
              ...(initialSyncKey ? { lastSyncedSessionConfigKey: initialSyncKey } : {}),
            };
  }
  if (sessionId === null && !codexUsesCatalog && !draft.modelSelection && modelSelectionView) {
    const selection = resolveDraftInitialModelSelection(modelSelectionView, null).selection;
    if (selection) draft = { ...draft, modelSelection: selection };
  }
  if (sessionConfig) {
    draft = applyCodexSessionConfigSync({
      draft,
      initialization: currentState.initialization,
      sessionId,
      sessionConfig,
      codex,
      codexUsesCatalog,
      codexCatalog,
    });
  }
  if (sessionId && sessionConfig) {
    const previous = currentState.observedConfig;
    const observedConfig = {
      permissionGrantId: sessionConfig.permissionGrant?.interactionId,
      planTransitionId: sessionConfig.planTransition?.toolCallId,
    };
    const firstSnapshot = !previous;
    const mode = submissionModeSchema.safeParse(sessionConfig.mode);
    const defaultMode = codex ? "custom" : "build";
    const currentMode = mode.success && mode.data !== "plan" ? mode.data : defaultMode;
    const currentPlan = resolveExecutionState(sessionConfig).planEnabled;
    if (firstSnapshot && currentState.initialization === "session") {
      draft = {
        ...draft,
        mode: currentMode,
        ...(codex ? { permissionModeGen: 2 as const } : {}),
        planEnabled: currentPlan,
        modelSelection: draft.mode
          ? draft.modelSelection
          : resolveSessionConfigModelSelection({
              sessionConfig,
              codex,
              codexUsesCatalog,
              codexCatalog,
            }),
      };
    } else if (previous) {
      const permissionChanged =
        observedConfig.permissionGrantId &&
        observedConfig.permissionGrantId !== previous.permissionGrantId;
      const planChanged =
        observedConfig.planTransitionId &&
        observedConfig.planTransitionId !== previous.planTransitionId;
      if (permissionChanged || planChanged)
        draft = {
          ...draft,
          ...(permissionChanged ? { mode: currentMode } : {}),
          ...(planChanged ? { planEnabled: currentPlan } : {}),
        };
    }
    if (
      firstSnapshot ||
      observedConfig.permissionGrantId !== previous.permissionGrantId ||
      observedConfig.planTransitionId !== previous.planTransitionId
    ) {
      currentState = { ...currentState, observedConfig };
    }
  }
  if (draft !== currentState.draft) currentState = { ...currentState, draft };
  if (currentState !== storedState) setStoredState(currentState);
  const stateRef = useRef(currentState);
  stateRef.current = currentState;
  // 原因：按 revision 清草稿会把短暂不可用永久写成空选择。这里只派生当前结果，
  // 正文/模式自动保存继续保存 draft 中的原意图；读取未就绪时保留展示，提交由 View 门禁阻断。
  const effectiveSelection = codexUsesCatalog
    ? codexCatalog
      ? (resolveCodexSelection(codexCatalog, draft.modelSelection) ?? undefined)
      : undefined
    : modelSelectionView
      ? (modelSelectionView.effectiveSelection ?? undefined)
      : draft.modelSelection;
  // 展示与提交共用同一归一化（composerDraftModeNormalization.ts）：edit 在能力未
  // 确认时归 custom；无代际标记的存量 build 归 custom（旧语义=保留原生权限）；
  // 非 codex 链路的 custom 回退 build。
  const normalizeDraftMode = useCallback(
    (next: V4ComposerDraft): V4ComposerDraft["mode"] =>
      normalizeComposerDraftMode(next, { codex, codexAutoReviewSupported }),
    [codex, codexAutoReviewSupported],
  );
  const draftConfig = useMemo<Partial<SessionConfigState>>(
    () => ({
      mode: normalizeDraftMode(draft),
      planEnabled: draft.planEnabled ?? false,
      modelSelection: effectiveSelection,
      provider: effectiveSelection?.providerId ?? "",
      model: effectiveSelection?.modelId ?? "",
      thought: effectiveSelection?.options?.reasoningLevel ?? "",
    }),
    [draft, effectiveSelection, normalizeDraftMode],
  );
  const draftConfigRef = useRef(draftConfig);
  draftConfigRef.current = draftConfig;
  const persistDraft = useCallback(
    (value: V4ComposerDraft) => {
      const workspace = useCodezSessionStore
        .getState()
        .getWorkspaceState(workspacePath, workspaceIdentity);
      return persistV4ComposerDraft(
        workspacePath,
        workspaceIdentity,
        // 首发已绑定但 React 尚未切换地址时，新输入也属于已创建的会话。
        stateRef.current.promotedSessionId ?? scopeId,
        scopeId === V4_DRAFT_SCOPE_ROOT
          ? {
              ...value,
              projectId:
                workspace.draftProjectId !== undefined ? workspace.draftProjectId : value.projectId,
              taskGroupId:
                workspace.draftTaskGroupId !== undefined
                  ? workspace.draftTaskGroupId
                  : value.taskGroupId,
            }
          : value,
        rootScope,
      );
    },
    [workspacePath, workspaceIdentity, scopeId, rootScope],
  );
  const mountedRef = useRef(false);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);
  useEffect(() => {
    if (navigationInitialization)
      useCodezSessionStore
        .getState()
        .consumeComposerInitialization(workspacePath, navigationInitialization, workspaceIdentity);
  }, [scopeKey, navigationInitialization, workspacePath, workspaceIdentity]);
  const isCurrentScope = useCallback(
    () =>
      mountedRef.current &&
      stateRef.current.scopeKey === scopeKey &&
      (sessionId !== null ||
        (useCodezSessionStore.getState().getWorkspaceState(workspacePath, workspaceIdentity)
          .draftFocusVersion ?? 0) === draftFocusVersion),
    [scopeKey, sessionId, workspacePath, workspaceIdentity, draftFocusVersion],
  );
  const lastPersistedDraftRef = useRef<V4ComposerDraft | null>(null);
  useEffect(() => {
    if (
      draft.mode &&
      draft !== lastPersistedDraftRef.current &&
      stateRef.current.draft === draft &&
      stateRef.current.scopeKey === scopeKey
    ) {
      persistDraft(draft);
      lastPersistedDraftRef.current = draft;
    }
  }, [draft, scopeKey, persistDraft]);
  const updateComposerDraft = useCallback(
    (update: (current: V4ComposerDraft) => V4ComposerDraft) => {
      // 旧 scope 的延迟编辑器回调不能写入刚切换到的会话。
      if (!isCurrentScope()) return;
      const previous = stateRef.current.draft;
      const next = update(previous);
      const nextState = { ...stateRef.current, draft: next };
      stateRef.current = nextState;
      const selection =
        next.modelSelection === previous.modelSelection
          ? draftConfigRef.current.modelSelection
          : next.modelSelection;
      draftConfigRef.current = {
        mode: normalizeDraftMode(next),
        planEnabled: next.planEnabled ?? false,
        modelSelection: selection,
        provider: selection?.providerId ?? "",
        model: selection?.modelId ?? "",
        thought: selection?.options?.reasoningLevel ?? "",
      };
      setStoredState(nextState);
      persistDraft(next);
      lastPersistedDraftRef.current = next;
    },
    [isCurrentScope, normalizeDraftMode, persistDraft],
  );
  const updateDraftConfig = useCallback(
    (update: (current: Partial<SessionConfigState>) => Partial<SessionConfigState>) => {
      const next = update(draftConfigRef.current);
      const mode = submissionModeSchema.safeParse(next.mode);
      updateComposerDraft((current) => ({
        ...current,
        mode: mode.success ? mode.data : current.mode,
        // mode 经新版本路径改写即携带代际标记；存量 build 归一化不再作用于它。
        ...(mode.success && mode.data !== current.mode ? { permissionModeGen: 2 as const } : {}),
        modelSelection: next.modelSelection,
        // 导入等待目录期间的显式选择也是有效选择，不能再被默认初始化覆盖。
        ...(current.mode
          ? {}
          : {
              mode: mode.success ? mode.data : codex ? "custom" : "build",
              permissionModeGen: 2 as const,
            }),
      }));
    },
    [codex, updateComposerDraft],
  );
  const captureAcceptedModelSelection = useCallback(
    (selection: ModelSelection, expectedSelection: ModelSelection = selection): (() => void) => {
      const original = stateRef.current.draft.modelSelection;
      const effective = draftConfigRef.current.modelSelection;
      // 对象键顺序不是选择身份；协议重建同一选择时不能因此丢掉 accepted 写回。
      if (
        effective?.providerId !== expectedSelection.providerId ||
        effective.modelId !== expectedSelection.modelId ||
        effective.options?.reasoningLevel !== expectedSelection.options?.reasoningLevel
      )
        return () => {};
      return () => {
        // 自动对应只在本次提交被接纳后固定；旧 ACK 不得覆盖期间的新意图或新 scope。
        if (
          stateRef.current.scopeKey !== scopeKey ||
          stateRef.current.draft.modelSelection !== original
        )
          return;
        updateComposerDraft((current) => ({ ...current, modelSelection: selection }));
      };
    },
    [scopeKey, updateComposerDraft],
  );
  const resolveInitialDraftConfig = useCallback((): Partial<SessionConfigState> | undefined => {
    if (codex) return resolveCodexPrewarmConfig(draftConfigRef.current);
    if (!draftConfigRef.current.mode) return undefined;
    const config = { ...draftConfigRef.current };
    if (appFollowupMode) {
      config.followupMode = appFollowupMode;
    }
    return config;
  }, [appFollowupMode, codex]);

  const updateComposerContent = useCallback(
    (content: Pick<V4ComposerDraft, "text" | "editorStateJson" | "mention">) => {
      updateComposerDraft((current) => ({
        ...current,
        editorStateJson: undefined,
        mention: undefined,
        ...content,
      }));
    },
    [updateComposerDraft],
  );
  const replaceComposerDraft = useCallback(
    (replacement: Omit<V4ComposerDraft, "updatedAt">) => {
      // 旧事件消费游标不再属于持久草稿；当前周期的观察基线由 Hook 内存持有。
      updateComposerDraft((current) => ({
        ...replacement,
        lastSyncedSessionConfigKey: current.lastSyncedSessionConfigKey,
        updatedAt: Date.now(),
      }));
    },
    [updateComposerDraft],
  );

  const promoteComposerDraft = useCallback(
    (createdSessionId: string) => {
      if (!isCurrentScope() || scopeId !== V4_DRAFT_SCOPE_ROOT) return;
      const targetSessionId = createdSessionId.trim();
      if (!targetSessionId) return;
      // 首发 Snapshot 可能迟到：空正文只在内存交接配置，有新文字则先写目标再删来源。
      const written = persistV4ComposerDraft(
        workspacePath,
        workspaceIdentity,
        targetSessionId,
        stateRef.current.draft,
      );
      if (!written) return;
      const next = { ...stateRef.current, promotedSessionId: targetSessionId };
      stateRef.current = next;
      setStoredState(next);
      clearV4ComposerDraft(workspacePath, workspaceIdentity, V4_DRAFT_SCOPE_ROOT, rootScope);
    },
    [scopeId, isCurrentScope, workspaceIdentity, workspacePath, rootScope],
  );

  // ── workspace 目录水合（见文件头说明）──
  // 目录已 ready（reload/广播/上次水合写过）则跳过；否则读取最小 workspace presentation。
  useEffect(() => {
    const isDraft = sessionId === null;
    const store = useCodezSessionStore.getState();
    const workspaceState = store.getWorkspaceState(workspacePath, workspaceIdentity);
    if (!agentStartupAllowed) {
      // V4 目录水合曾在无模型时直接进入 RPC，虽然 Host 不会启动 CLI，
      // renderer 仍会把正常等待态记成 hydration error。readiness 未通过时保持 idle；
      // registry 就绪后依赖变化会自动重新进入本 effect。
      store.setConfigOptionsStatus(workspacePath, "idle", workspaceIdentity);
      return;
    }
    const configOptions = workspaceState.configOptions ?? [];
    const hasModePresentation = configOptions.some(
      (option) => option.category === "mode" && option.type === "select",
    );
    const hasSlashCommandCatalog = workspaceState.slashCommands.length > 0;
    const shouldHydrateCatalog = shouldHydrateWorkspaceCatalog({
      configOptions,
      sessionId,
      slashCommands: workspaceState.slashCommands,
    });
    logger.debug("[v4-workspace-catalog] hydration check", {
      catalogScope: isDraft ? "draft" : "known-session",
      hasModePresentation,
      hasSlashCommandCatalog,
      flightInProgress: workspaceCatalogHydrationFlights.has(workspaceKey),
      configOptionsStatus: workspaceState.configOptionsStatus,
      workspaceKey,
    });
    const existingFlight = workspaceCatalogHydrationFlights.get(workspaceKey);
    if (existingFlight) {
      return;
    }
    if (!shouldHydrateCatalog) {
      return;
    }

    store.setConfigOptionsStatus(workspacePath, "loading", workspaceIdentity);
    const flight = prepareWorkspaceWithCodezSessionService({
      workspacePath,
      workspaceIdentity,
      provider: displayProvider,
      codezSessionService,
    })
      .then((prepareResult) => {
        const baseOptions = prepareResult.configOptions ?? [];
        logger.debug("[v4-workspace-catalog] hydration done", {
          catalogScope: isDraft ? "draft" : "known-session",
          optionCount: baseOptions.length,
          slashCommandCount: prepareResult.slashCommands?.length ?? 0,
          modeCurrentValue: String(
            baseOptions.find((option) => option.category === "mode" && option.type === "select")
              ?.currentValue ?? "",
          ),
          workspaceKey,
        });
        const latest = useCodezSessionStore.getState();
        latest.setConfigOptions(workspacePath, baseOptions, workspaceIdentity);
        latest.setConfigOptionsStatus(workspacePath, "ready", workspaceIdentity);
        latest.setSlashCommands(
          workspacePath,
          prepareResult.slashCommands ?? [],
          workspaceIdentity,
        );
      })
      .catch((error) => {
        useCodezSessionStore
          .getState()
          .setConfigOptionsStatus(workspacePath, "error", workspaceIdentity);
        logger.warn(`[v4-workspace-catalog] workspace 目录水合失败: ${String(error)}`);
      })
      .finally(() => {
        workspaceCatalogHydrationFlights.delete(workspaceKey);
      });
    workspaceCatalogHydrationFlights.set(workspaceKey, flight);
  }, [
    agentStartupAllowed,
    displayProvider,
    sessionId,
    workspaceIdentity,
    workspaceKey,
    workspacePath,
    codezSessionService,
  ]);

  const handleDraftSelectModel = useCallback(
    (modelProvider: string, model: string, reasoningLevel?: string) => {
      const modelId = modelProvider ? `${modelProvider}/${model}` : model;
      const parsedSelection = parseModelPickerValue(modelId);
      // 原因：调档后解析尚未返回时，菜单仍使用同 Host 的保留目录；只读 ready view
      // 会把随后主动选模写成无档位意图，永久显示“—”。目录仅用于选模，不放行提交。
      const catalog =
        modelSelectionView ??
        (modelSelectionRead.state.status === "loading" ? modelSelectionRead.state.catalog : null);
      const modelSelection = codexCatalog
        ? (resolveCodexSelection(codexCatalog, parsedSelection) ?? parsedSelection)
        : reasoningLevel
          ? { ...parsedSelection, options: { reasoningLevel } }
          : catalog
            ? (completeNewModelSelection(catalog, parsedSelection) ?? parsedSelection)
            : parsedSelection;
      logger.debug("[v4-draft-config] select model", {
        modelProvider,
        model,
        modelId,
        modelSelectionProviderId: modelSelection.providerId,
        modelSelectionModelId: modelSelection.modelId,
        workspacePath,
        workspaceIdentity: workspaceIdentity ?? null,
      });
      updateDraftConfig((current) => applyDraftModelSelection(current, modelSelection));
    },
    [
      codexCatalog,
      modelSelectionView,
      modelSelectionRead.state,
      updateDraftConfig,
      workspaceIdentity,
      workspacePath,
    ],
  );

  const handleDraftSelectThought = useCallback(
    (thought: string) => {
      updateDraftConfig((current) => {
        const providerId = current.modelSelection?.providerId ?? current.provider?.trim();
        const modelId = current.modelSelection?.modelId ?? current.model?.trim();
        if (!providerId || !modelId) return { ...current, thought };
        const reasoningLevel = thought.trim();
        return {
          ...current,
          modelSelection: {
            providerId,
            modelId,
            ...(reasoningLevel
              ? {
                  options: {
                    ...current.modelSelection?.options,
                    reasoningLevel,
                  },
                }
              : {}),
          },
          thought,
        };
      });
    },
    [updateDraftConfig],
  );

  const handleDraftSwitchMode = useCallback(
    (mode: string) => {
      if (mode === "plan" || mode === "plan-off") {
        // plan 勾选与权限档位正交；取消勾选时回到的权限档默认值按运行时区分。
        const fallbackMode = codex ? "custom" : "build";
        updateComposerDraft((current) => {
          const nextMode = current.mode === "plan" ? fallbackMode : (current.mode ?? fallbackMode);
          return {
            ...current,
            mode: nextMode,
            // plan 勾选不改写权限档；只有实际发生回退写入才携带新代标记。
            ...(nextMode !== current.mode ? { permissionModeGen: 2 as const } : {}),
            planEnabled: mode === "plan",
          };
        });
        return;
      }
      // 模式与模型同属当前 scope；不再写全局偏好，避免别的任务反向覆盖。
      const parsed = submissionModeSchema.safeParse(mode);
      if (parsed.success)
        updateComposerDraft((current) => ({
          ...current,
          mode: parsed.data,
          // 用户显式选择的权限档按新语义写入，携带代际标记（区别于存量 build）。
          permissionModeGen: 2 as const,
        }));
    },
    [codex, updateComposerDraft],
  );

  return {
    modelSelectionRead,
    draftConfig,
    draftConfigRef,
    resolveInitialDraftConfig,
    composerDraft: draft,
    updateComposerContent,
    replaceComposerDraft,
    promoteComposerDraft,
    captureAcceptedModelSelection,
    handleDraftSelectModel,
    handleDraftSelectThought,
    handleDraftSwitchMode,
  };
}

/** createSession payload 的草稿 config 片段（无选择时返回空对象，不携带 config 键）。 */
export function buildDraftCreateConfigPayload(
  draftConfig: Partial<SessionConfigState>,
  appFollowupMode?: SessionConfigState["followupMode"] | null,
): { config?: Partial<SessionConfigState> } {
  const config: Partial<SessionConfigState> = { ...draftConfig };
  if (appFollowupMode) {
    config.followupMode = appFollowupMode;
  }
  return Object.keys(config).length > 0 ? { config } : {};
}
