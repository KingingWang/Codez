import { act, createElement, Fragment, type ReactNode } from "react";
import type { ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  AttachmentRef,
  CommandAck,
  CommandEnvelope,
  ConversationRowTarget,
  ConversationSnapshot,
} from "@codez/shared/codez-protocol-v4";
import type { HighspeedCardSnapshot } from "@codez/shared";
import { SessionPane } from "@/v4/SessionPane.js";
import { TabStoreProvider } from "@/store/TabStoreProvider.js";
import { CodezIntlProvider } from "@/i18n/IntlProvider.js";

// fork worktree 特性使 SessionPane 经 useTaskWorktreePlacement → useIndexedTaskMeta →
// useCodezTaskService → useWorkspaceServices 引入 useTabStore（要求 TabStoreProvider）。
// 本文件不验证 worktree 语义，按仓库既有隔离做法桩掉该入口：普通任务恒可用、cwd 即 workspace。
vi.mock("@/managed-worktrees/index.js", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    useTaskWorktreePlacement: ({ workspacePath }: { workspacePath: string }) => ({
      cwd: workspacePath,
      worktreeRoot: undefined,
      worktreeAvailable: true,
    }),
  };
});
// SessionPane 的多个 hook（useSubagents、连接解析等）经 useTabStore 要求 TabStoreProvider；
// 宿主渲染树统一包一层真实 Tab store（默认空 tab 状态），保持各文件既有服务桩不变。
function SessionPaneWithTabStore(props: ComponentProps<typeof SessionPane>) {
  return createElement(TabStoreProvider, null, createElement(SessionPane, props));
}

// spec §9.2：激活动效只属于本端发送路径的 draw 新命中；切回、恢复与同卡复用都按 restore 呈现。

// 编辑重发用例需要一个「可提交」的 composer 配置（见 armComposerSubmission）；
// 其余用例保持原来的 loading/空配置，避免改动 sendText 路径上的既有门禁行为。
const draftConfigMock = vi.hoisted(() => ({
  modelSelectionState: { status: "loading" } as Record<string, unknown>,
  draftConfig: {} as Record<string, unknown>,
  editableRow: false,
}));

const { composerProps, layerMock, sendCommandMock, timelineProps } = vi.hoisted(() => ({
  composerProps: [] as Array<{
    highspeedCard?: HighspeedCardSnapshot | null;
    highspeedActivationCardId?: string | null;
    onHighspeedActivationApplied?: (cardId: string) => void;
    onSendText?: (text: string, options?: Record<string, unknown>) => Promise<unknown>;
  }>,
  layerMock: {
    acquire: vi.fn(() => ({
      store: {
        markCommandPending: vi.fn(),
        // editUserQuery 的 ACK 早于 replacement 行时要等编辑呈现；缺这个方法会直接 TypeError。
        waitForEditPresentation: vi.fn(async () => {}),
        expectAcceptedInputProjection: vi.fn(),
        recoverFromStaleAuthority: vi.fn(),
        onOnlineModelTransition: vi.fn(() => () => {}),
        refreshPlans: vi.fn(async () => {}),
        settleCommand: vi.fn(),
      },
      release: vi.fn(),
    })),
  },
  sendCommandMock: vi.fn(
    async (envelope: CommandEnvelope): Promise<CommandAck> => ({
      commandId: envelope.commandId,
      revisionAtDecision: envelope.baseRevision ?? 0,
      status: "accepted",
    }),
  ),
  timelineProps: [] as Array<{
    bottomDock?: ReactNode;
    onEdit?: (
      target: ConversationRowTarget,
      newText: string,
      attachments?: readonly AttachmentRef[],
    ) => Promise<boolean | void> | boolean | void;
  }>,
}));

// 永不 resolve：本用例不测 run 发现查询；resolve 会在环境拆除后触发 setState（未处理异常）。
const workflowRunsQueryMock = vi.hoisted(() =>
  vi.fn(() => new Promise<{ runs: unknown[] }>(() => {})),
);
const projectionState = vi.hoisted(() => ({
  current: null as {
    status: "live";
    snapshot: ConversationSnapshot;
    subscriptionId: string;
    lastError: string | null;
    optimisticCommands: readonly [];
    loadingOlder: boolean;
  } | null,
}));

const servicesMock = vi.hoisted(() => ({
  // useSubagents 用 subagentsService 作 WeakMap authority 键并发起 list；给惰性桩避免 WeakMap 崩溃。
  subagentsService: {
    list: vi.fn(async () => ({ agents: [], capability: null })),
    setEnabled: vi.fn(async () => {}),
  },
  // SessionPane 的 Highspeed owner effect 无守卫地订阅 oauthService.onDidChangeSession。
  oauthService: {
    onDidChangeSession: vi.fn(() => ({ dispose() {} })),
  },
  // AgentRuntimeExitBanner 等直接解构 codezAgentService；给惰性桩避免 undefined 成员访问。
  codezAgentService: {
    onAgentRuntimeExited: vi.fn(() => ({ dispose() {} })),
    onDynamicPluginStartupDegraded: vi.fn(() => () => ({ dispose() {} })),
  },
  projectService: {
    resolveSessionDirectories: vi.fn(async (task) => ({
      ...task,
      projectId: null,
      additionalDirectories: [],
    })),
  },
  // 普通任务也会读取 Bot 绑定并订阅广播，补齐依赖以保持激活动效测试的原有范围。
  botsService: {
    getBotStates: vi.fn(async () => []),
  },
  broadcastService: {
    onMessage: vi.fn(() => ({ dispose: vi.fn() })),
  },
  highspeedCardService: {
    getSnapshot: vi.fn(
      async (): Promise<{
        card: HighspeedCardSnapshot | null;
        nextDrawAt: number | null;
        drawing: boolean;
      }> => ({ card: null, nextDrawAt: null, drawing: false }),
    ),
    prepareTurn: vi.fn(),
    healthy: vi.fn(async () => ({
      cardId: "card",
      promptTokens: 0,
      completionTokens: 0,
      durationSeconds: 0,
    })),
    share: vi.fn(),
  
      getCurrentOwnerKey: vi.fn(async () => null),
      invalidateCard: vi.fn(async () => {}),
    },
  // readiness hook 将 service 作为 effect 依赖；每次 render 重建会导致无限重渲染。
  codezSessionService: {
    updateProviderRegistry: vi.fn(),
  },
  codezTaskService: {
    restartWorkspaceProcess: vi.fn(),
  },
}));

// Start 套餐推荐是 sendText 在 prepare 之前的真实 await；用例据此把发送挂在 prepare 之前，
// 模拟配置屏障 / 推荐 / 建会话期间用户切换 Task。桩必须是稳定引用（发送回调以其为依赖）。
const startPlanRecommendation = vi.hoisted(() => {
  const state = { hold: null as Promise<void> | null };
  return {
    state,
    recommend: vi.fn(async <T>(selection: T): Promise<T> => {
      await state.hold;
      return selection;
    }),
  };
});

// 上游 3.17.1 新增 SessionPane 的运行时重启入口：useSessionRuntimeRestart →
// useWorkspaceServices → useResolvedRemoteWorkspaceSessionId → useTabStore，要求 TabStoreProvider。
// 本文件只验证既有目标，按本仓库既有隔离做法桩掉该入口，不引入真实 Tab store；
// 桩必须是稳定引用，避免 SessionPane 的 effect 依赖每轮变化。
const sessionRuntimeRestartStub = vi.hoisted(() => ({
  restart: async () => false,
  pending: false,
}));
vi.mock("@/app-shell/useWorkspaceSessionReload.js", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, useSessionRuntimeRestart: () => sessionRuntimeRestartStub };
});

// 最小 DOM 没有 body / requestAnimationFrame，真实 toast() 会在 ensureHost 里抛 TypeError，
// 把用例真正的断言失败盖掉（编辑提交被 blocked 时 SessionPane 会弹「保存失败」）。
// 这里桩掉 toast，只保留“是否弹过提示”的可观测性。
const toastMock = vi.hoisted(() => vi.fn());
vi.mock("@/components/ui/toast.js", () => ({ toast: toastMock }));

vi.mock("@/hooks/useStartPlanRecommendation.js", () => ({
  useStartPlanRecommendation: () => startPlanRecommendation.recommend,
}));

vi.mock("@/hooks/useSettingService.js", () => ({
  useSettings: () => ({
    error: null,
    loading: false,
    refresh: vi.fn(async () => {}),
    settings: { codezInteractionBehavior: "queue" },
    update: vi.fn(async () => {}),
  }),
}));

vi.mock("@/hooks/useCodexModelCatalog.js", () => ({
  useCodexModelCatalog: () => ({ status: "unavailable", reload: vi.fn(), readCurrent: vi.fn() }),
}));
vi.mock("@/hooks/useServices.js", () => ({
  useComposerClientNamespace: () => "desktop",
  useOptionalServices: () => null,
  useServices: () => servicesMock,
}));

vi.mock("@/v4/useConversationProjection.js", () => ({
  useConversationProjection: () => projectionState.current,
}));

vi.mock("@/v4/V4ConversationContext.js", () => ({
  useV4Conversation: () => ({
    attachmentPut: vi.fn(),
    fileChanges: vi.fn(),
    fileRewindPreview: vi.fn(),
    layer: layerMock,
    sendCommand: sendCommandMock,
    // 桩必须是稳定引用：effect 以 workflowRuns 为依赖，每次渲染换新函数会死循环。
    workflowRuns: workflowRunsQueryMock,
  }),
}));

vi.mock("@/store/StoreProvider.js", () => ({
  useCodezStoreWithDefault: (_selector: unknown, fallback: unknown) => fallback,
}));

vi.mock("@/v4/composer/useDraftConfigControl.js", () => {
  return {
  buildDraftCreateConfigPayload: () => ({}),
  useDraftConfigControl: () => ({
    // 对齐现状：editUserQuery 与普通发送共用 fail-closed 提交门禁，
    // createComposerSubmissionConfig 需要 draftConfig 带有效 modelSelection 且 View 能校验它，
    // 否则 handleEdit 直接 blocked，一条命令都不会发（激活动效也就无从登记）。
    modelSelectionRead: { state: draftConfigMock.modelSelectionState, reload: vi.fn() },
    captureAcceptedModelSelection: () => vi.fn(),
    draftConfigRef: { current: draftConfigMock.draftConfig },
    draftConfigSeedSignal: 0,
    handleDraftSelectModel: vi.fn(),
    handleDraftSelectThought: vi.fn(),
    handleDraftSwitchMode: vi.fn(),
    resolveInitialDraftConfig: vi.fn(),
    // 上游 v4.0.0 扩充了 hook 返回形状（composerDraft/staging 等）；SessionPane 会解构消费，
    // 本文件不验证这些语义，按惰性缺省补齐，保持既有字段原值。
    composerDraft: {},
    composerDraftScopeToken: undefined,
    draftConfig: draftConfigMock.draftConfig,
    stageComposerContent: vi.fn(),
    captureComposerContentLifecycleCommit: vi.fn(),
    captureComposerSubmissionDraftTransaction: vi.fn(),
    persistComposerContent: vi.fn(),
    updateComposerContent: vi.fn(),
    replaceComposerDraft: vi.fn(),
    promoteComposerDraft: () => true,
    observeDraftPermissionGrant: vi.fn(),
    keepEditConfigOnExit: vi.fn(),
  }),
  };
});

vi.mock("@/v4/composer/useDraftSessionPrewarm.js", () => ({
  useDraftSessionPrewarm: () => ({
    binding: null,
  }),
}));

vi.mock("@/v4/ConversationComposer.js", async () => {
  const React = await import("react");
  return {
    ConversationComposer: (props: Record<string, unknown>) => {
      composerProps.push(props as (typeof composerProps)[number]);
      return React.createElement("div", { "data-testid": "mock-composer" });
    },
  };
});

vi.mock("@/v4/ConversationHeader.js", async () => {
  const React = await import("react");
  return { ConversationHeader: () => React.createElement("div", { "data-testid": "mock-header" }) };
});

vi.mock("@/v4/ConversationTimeline.js", async () => {
  const React = await import("react");
  return {
    ConversationTimeline: (props: Record<string, unknown>) => {
      timelineProps.push(props as (typeof timelineProps)[number]);
      return React.createElement(
        Fragment,
        null,
        React.createElement("div", { "data-testid": "mock-timeline" }),
        props.bottomDock as ReactNode,
      );
    },
  };
});

vi.mock("@/v4/ConversationStatusPanel.js", async () => {
  const React = await import("react");
  return {
    ConversationStatusPanel: () => React.createElement("div", { "data-testid": "mock-status" }),
  };
});

vi.mock("@/v4/ConversationQueuePanel.js", async () => {
  const React = await import("react");
  return {
    ConversationQueuePanel: () => React.createElement("div", { "data-testid": "mock-queue" }),
  };
});

vi.mock("@/v4/V4InteractionDialogs.js", async () => {
  const React = await import("react");
  return {
    V4InteractionDialogs: () => React.createElement("div", { "data-testid": "mock-interactions" }),
  };
});

vi.mock("@/request-security-edition/V4ProviderRuntimeHeadersController.js", async () => {
  const React = await import("react");
  return {
    V4ProviderRuntimeHeadersController: () =>
      React.createElement("div", { "data-testid": "mock-runtime-headers" }),
  };
});

vi.mock("@/v4/ConversationDraftEmptyState.js", async () => {
  const React = await import("react");
  return {
    ConversationDraftEmptyState: () =>
      React.createElement("div", { "data-testid": "mock-draft-empty" }),
  };
});

// 捕获 document/window 的事件监听，供唤醒补偿用例手动触发（模拟息屏后回到窗口）。
const domEventListeners: Array<{
  target: "document" | "window";
  type: string;
  handler: () => void;
}> = [];

function triggerDomEvent(target: "document" | "window", type: string): void {
  for (const listener of [...domEventListeners]) {
    if (listener.target === target && listener.type === type) listener.handler();
  }
}

function createMinimalElement(ownerDocument: Document, tagName = "div") {
  const element = {
    addEventListener: () => {},
    appendChild: (child: { parentNode?: unknown }) => {
      child.parentNode = element;
      return child;
    },
    childNodes: [] as unknown[],
    getAttribute: () => null,
    insertBefore: (child: { parentNode?: unknown }) => {
      child.parentNode = element;
      return child;
    },
    nodeName: tagName.toUpperCase(),
    nodeType: 1,
    ownerDocument,
    parentNode: null as unknown,
    removeAttribute: () => {},
    removeChild: (child: { parentNode?: unknown }) => {
      child.parentNode = null;
      return child;
    },
    removeEventListener: () => {},
    setAttribute: () => {},
    style: {},
    tagName: tagName.toUpperCase(),
  };
  return element as unknown as Element;
}

function installMinimalDom() {
  domEventListeners.length = 0;
  const documentMock = {
    // IntlProvider 会写 document.documentElement.lang；最小 DOM 需补齐该节点。
    documentElement: { lang: "" },
    // toast() 会 document.body.appendChild(host)；编辑提交被 blocked 时会走到这里，
    // 缺 body 会抛 TypeError 把真正的失败原因盖掉。body 的 ownerDocument 要指回自己，
    // 因此先占位、构造完成后回填（对象字面量里直接引用自身会踩 TDZ）。
    body: undefined as unknown as Element,
    addEventListener: (type: string, handler: () => void) => {
      domEventListeners.push({ target: "document", type, handler });
    },
    createElement: (tagName: string) =>
      createMinimalElement(documentMock as unknown as Document, tagName),
    createElementNS: (_namespace: string, tagName: string) =>
      createMinimalElement(documentMock as unknown as Document, tagName),
    createTextNode: (nodeValue: string) => ({
      nodeType: 3,
      nodeValue,
      ownerDocument: documentMock,
      parentNode: null,
    }),
    nodeType: 9,
    removeEventListener: () => {},
    visibilityState: "visible",
  } as unknown as Document;
  (documentMock as unknown as { body: Element }).body = createMinimalElement(documentMock, "body");
  const windowMock = {
    addEventListener: (type: string, handler: () => void) => {
      domEventListeners.push({ target: "window", type, handler });
    },
    clearTimeout,
    document: documentMock,
    HTMLElement: function HTMLElement() {},
    HTMLIFrameElement: function HTMLIFrameElement() {},
    Node: function Node() {},
    removeEventListener: () => {},
    setTimeout,
  } as unknown as Window & typeof globalThis;
  Object.assign(globalThis, {
    document: documentMock,
    HTMLElement: windowMock.HTMLElement,
    HTMLIFrameElement: windowMock.HTMLIFrameElement,
    IS_REACT_ACT_ENVIRONMENT: true,
    Node: windowMock.Node,
    window: windowMock,
  });
  return createMinimalElement(documentMock, "div");
}

async function flushMicrotasks(): Promise<void> {
  for (let index = 0; index < 8; index += 1) {
    await Promise.resolve();
  }
}

function makeSnapshot(sessionId: string): ConversationSnapshot {
  return {
    protocolVersion: 1,
    sessionId,
    logEpoch: "epoch-1",
    seq: 1,
    revision: 7,
    control: {
      phase: "completedSuccess",
      sessionEnded: true,
      canStop: false,
      stopState: "idle",
      stopTargetKind: "unknown",
      activeWorks: [],
      lastError: null,
      apiRetry: null,
    },
    availability: {
      fork: { allowed: true },
      compact: { allowed: true },
      switchModelConfig: { allowed: true },
      setFollowupMode: { allowed: true },
      queueEdit: { allowed: true },
      sendQueuedNow: {
        allowed: false,
        reasonCode: "sendQueuedNowRequiresRunning",
      },
      pauseGoal: { allowed: false, reasonCode: "noGoalToPause" },
      resumeGoal: { allowed: false, reasonCode: "noGoalToResume" },
    },
    inputRouting: { mode: "startNow" },
    meta: { title: "Session", titleSource: "generated" },
    config: {
      provider: "builtin:bigmodel-coding-plan",
      model: "GLM-5.3",
      thought: "",
      followupMode: "queue",
      mode: "build",
    },
    usage: {
      contextWindow: null,
      cumulative: {
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      },
    },
    queue: { items: [], autoDrain: true },
    pendingInteractions: [],
    pendingCommands: [],
    backgroundWorks: [],
    goal: null,
    plan: null,
    // beginUserQueryEdit 只在 rows.window 里找到 kind=userInput 且 actions.canEdit 的行时
    // 才进入编辑态；编辑重发类用例必须有这一行，否则 onEdit 直接早退。
    // 但 sendText 类用例的快照必须保持空行窗口：多一条用户输入行会改变发送路径上的
    // 既有门禁与 Highspeed prepare 时序（startPlanRecommendation 不再被调用）。
    // 因此该行由 armComposerSubmission 一并打开，afterEach 复位。
    rows: {
      window: (draftConfigMock.editableRow
        ? [
            {
              rowId: 42,
              turnId: "turn-1",
              createdAt: 1_700_000_000_042,
              createdAtSeq: 42,
              kind: "userInput",
              entityId: "message-user-42",
              origin: "realUser",
              text: "原问题",
              actions: { canEdit: true },
            },
          ]
        : []) as ConversationSnapshot["rows"]["window"],
      totalCount: draftConfigMock.editableRow ? 1 : 0,
      firstRowId: draftConfigMock.editableRow ? 42 : null,
    },
  };
}

function makeCard(cardId: string, taskId = "session-a"): HighspeedCardSnapshot {
  return {
    cardId,
    taskId,
    provider: "builtin:bigmodel-coding-plan",
    model: "GLM-5.3",
    issuedAt: 1,
    expiresAt: Date.now() + 60_000,
  };
}

function mockDrawHit(card: HighspeedCardSnapshot): void {
  servicesMock.highspeedCardService.prepareTurn.mockResolvedValueOnce({
    kind: "accelerated",
    card,
    nextDrawAt: card.expiresAt,
  });
}

function latestComposer() {
  const props = composerProps.at(-1);
  if (!props) throw new Error("composer 尚未渲染");
  return props;
}

async function renderPane(root: Root, sessionId: string): Promise<void> {
  projectionState.current = {
    status: "live",
    snapshot: makeSnapshot(sessionId),
    subscriptionId: `sub-${sessionId}`,
    lastError: null,
    optimisticCommands: [],
    loadingOlder: false,
  };
  await act(async () => {
    root.render(
      createElement(
        CodezIntlProvider,
        { initialLocale: "zh-CN" },
        createElement(SessionPaneWithTabStore, {
          paneId: "workspace-main",
          sessionId,
          workspacePath: "/workspace",
        }),
      ),
    );
    await flushMicrotasks();
  });
}

/** 走行内编辑重发路径：与 sendText 共用 prepareHighspeedTurnForSend 的发送前抽卡。 */
/**
 * 对齐现状：editUserQuery 与普通发送共用 fail-closed 提交门禁——
 * createComposerSubmissionConfig 需要 draftConfig 带有效 modelSelection，且 View 能按
 * optionSpecs.reasoningLevel 校验该选择；否则 handleEdit 直接 blocked，一条命令都不会发。
 * 只有编辑重发用例需要它；sendText 用例自带 submission，不能改它们的默认门禁状态。
 */
function armComposerSubmission(): void {
  draftConfigMock.editableRow = true;
  draftConfigMock.modelSelectionState = {
    status: "ready",
    view: {
      revision: 1,
      providers: [
        {
          providerId: "builtin:bigmodel-coding-plan",
          models: [
            {
              modelId: "GLM-5.3",
              config: { optionSpecs: { reasoningLevel: { values: ["low", "high"] } } },
            },
          ],
        },
      ],
    },
  };
  draftConfigMock.draftConfig = {
    mode: "build",
    planEnabled: false,
    modelSelection: {
      providerId: "builtin:bigmodel-coding-plan",
      modelId: "GLM-5.3",
      options: { reasoningLevel: "high" },
    },
  };
}

async function sendThroughEdit(): Promise<void> {
  // 对齐现状：编辑重发是两步——timeline onEdit 只进入编辑态并回填原文/附件，
  // editUserQuery 由 composer 的发送路由（handleSendText → submitComposerEdit）提交。
  await act(async () => {
    await timelineProps.at(-1)?.onEdit?.({ rowId: 42, entityId: "message-user-42" });
    await flushMicrotasks();
  });
  await act(async () => {
    await composerProps.at(-1)?.onSendText?.("再加速一轮", {
      attachments: [],
      conversationQuotes: [],
    });
    await flushMicrotasks();
  });
}

/**
 * 走 Composer sendText 路径，并让发送停在 prepare 之前的 Start 套餐推荐 await；
 * 返回的 release 放行后才会进入 Highspeed prepare。
 */
async function sendTextHeldBeforePrepare(): Promise<{
  release: () => void;
  sending: Promise<unknown>;
}> {
  let release: () => void = () => {};
  startPlanRecommendation.state.hold = new Promise<void>((resolve) => {
    release = resolve;
  });
  let sending: Promise<unknown> = Promise.resolve();
  await act(async () => {
    sending =
      latestComposer().onSendText?.("加速一轮", {
        submission: {
          mode: "build",
          planEnabled: false,
          modelSelection: { providerId: "builtin:bigmodel-coding-plan", modelId: "GLM-5.3" },
        },
      }) ?? Promise.reject(new Error("composer 未提供 onSendText"));
    await flushMicrotasks();
  });
  expect(startPlanRecommendation.recommend).toHaveBeenCalledTimes(1);
  expect(servicesMock.highspeedCardService.prepareTurn).not.toHaveBeenCalled();
  return { release, sending };
}

/**
 * 截获到期清退 timer（挂载时刻 + 延时恰为 expiresAt）改由用例手动触发，其余 timer 照常执行。
 * 需配合固定的 Date.now，才能按挂载时刻精确识别。
 */
function captureExpiryTimers(expiresAt: number) {
  const realSetTimeout = window.setTimeout;
  const realClearTimeout = window.clearTimeout;
  const pending = new Map<number, () => void>();
  let nextId = 0;
  window.setTimeout = ((handler: () => void, delay = 0) => {
    if (Date.now() + delay !== expiresAt) return realSetTimeout(handler, delay);
    nextId -= 1;
    pending.set(nextId, handler);
    return nextId;
  }) as typeof window.setTimeout;
  window.clearTimeout = ((id?: number) => {
    if (id !== undefined && pending.delete(id)) return;
    realClearTimeout(id);
  }) as typeof window.clearTimeout;
  return {
    get pendingCount() {
      return pending.size;
    },
    fireNext: () => {
      const next = pending.entries().next().value;
      if (!next) return;
      pending.delete(next[0]);
      next[1]();
    },
  };
}

afterEach(() => {
  toastMock.mockClear();
  draftConfigMock.modelSelectionState = { status: "loading" };
  draftConfigMock.draftConfig = {};
  draftConfigMock.editableRow = false;
  // 用 mockReset 而不是 mockClear：mockClear 不清除未消费的 mockResolvedValueOnce 队列。
  // 编辑重发用例会排队一次性 ACK，一旦某条用例没有真正发出命令，残留 ACK 就会泄漏到
  // 下一个用例，把它的 editUserQuery 判成 rejected/stale，handleEdit 返回 false 并弹「保存失败」。
  sendCommandMock.mockReset();
  sendCommandMock.mockImplementation(async (envelope: { commandId: string; baseRevision?: number }) => ({
    commandId: envelope.commandId,
    revisionAtDecision: envelope.baseRevision ?? 0,
    status: "accepted",
  }));
  composerProps.length = 0;
  timelineProps.length = 0;
  servicesMock.highspeedCardService.getSnapshot.mockReset();
  servicesMock.highspeedCardService.getSnapshot.mockResolvedValue({
    card: null,
    nextDrawAt: null,
    drawing: false,
  });
  servicesMock.highspeedCardService.prepareTurn.mockReset();
  startPlanRecommendation.state.hold = null;
  startPlanRecommendation.recommend.mockClear();
  projectionState.current = null;
  delete (globalThis as { document?: unknown }).document;
  delete (globalThis as { window?: unknown }).window;
  delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: unknown }).IS_REACT_ACT_ENVIRONMENT;
});

describe("SessionPane Highspeed 激活动效请求", () => {
  it("draw 新命中只登记一次激活；切走再切回与同卡再次发送都不重播", async () => {
    armComposerSubmission();
    const card = makeCard("card-1");
    const root = createRoot(installMinimalDom());
    try {
      await renderPane(root, "session-a");
      expect(latestComposer().highspeedCard).toBeNull();
      expect(latestComposer().highspeedActivationCardId).toBeNull();

      mockDrawHit(card);
      await sendThroughEdit();
      expect(latestComposer().highspeedCard?.cardId).toBe("card-1");
      expect(latestComposer().highspeedActivationCardId).toBe("card-1");

      // composer 锁定入场方式后回调消费：请求清空，但卡片仍然有效。
      await act(async () => {
        latestComposer().onHighspeedActivationApplied?.("card-1");
      });
      expect(latestComposer().highspeedActivationCardId).toBeNull();
      expect(latestComposer().highspeedCard?.cardId).toBe("card-1");

      // Service 仍持有该卡；切到其他 Task 时卡不属于它，输入框回到普通态。
      servicesMock.highspeedCardService.getSnapshot.mockResolvedValue({
        card,
        nextDrawAt: card.expiresAt,
        drawing: false,
      });
      await renderPane(root, "session-b");
      expect(latestComposer().highspeedCard).toBeNull();

      // 切回：恢复链路与 draw 命中共用同一张卡快照，但不能再登记激活。
      await renderPane(root, "session-a");
      expect(latestComposer().highspeedCard?.cardId).toBe("card-1");
      expect(latestComposer().highspeedActivationCardId).toBeNull();

      // 同一张卡继续加速下一轮：prepare 仍返回 accelerated，但不是新命中。
      mockDrawHit(card);
      await sendThroughEdit();
      expect(servicesMock.highspeedCardService.prepareTurn).toHaveBeenCalledTimes(2);
      expect(latestComposer().highspeedCard?.cardId).toBe("card-1");
      expect(latestComposer().highspeedActivationCardId).toBeNull();
    } finally {
      await act(async () => root.unmount());
    }
  });

  it("Renderer 重载后经 getSnapshot 恢复的卡，再次发送也不补播激活", async () => {
    armComposerSubmission();
    const card = makeCard("card-restored");
    servicesMock.highspeedCardService.getSnapshot.mockResolvedValue({
      card,
      nextDrawAt: card.expiresAt,
      drawing: false,
    });
    const root = createRoot(installMinimalDom());
    try {
      await renderPane(root, "session-a");
      expect(latestComposer().highspeedCard?.cardId).toBe("card-restored");
      expect(latestComposer().highspeedActivationCardId).toBeNull();

      mockDrawHit(card);
      await sendThroughEdit();
      expect(latestComposer().highspeedCard?.cardId).toBe("card-restored");
      expect(latestComposer().highspeedActivationCardId).toBeNull();
    } finally {
      await act(async () => root.unmount());
    }
  });

  it("换到新卡时重新登记激活；迟到的旧卡消费回调不清掉新请求", async () => {
    armComposerSubmission();
    const restoredCard = makeCard("card-old");
    servicesMock.highspeedCardService.getSnapshot.mockResolvedValue({
      card: restoredCard,
      nextDrawAt: restoredCard.expiresAt,
      drawing: false,
    });
    const root = createRoot(installMinimalDom());
    try {
      await renderPane(root, "session-a");
      expect(latestComposer().highspeedCard?.cardId).toBe("card-old");

      mockDrawHit(makeCard("card-new"));
      await sendThroughEdit();
      expect(latestComposer().highspeedCard?.cardId).toBe("card-new");
      expect(latestComposer().highspeedActivationCardId).toBe("card-new");

      await act(async () => {
        latestComposer().onHighspeedActivationApplied?.("card-old");
      });
      expect(latestComposer().highspeedActivationCardId).toBe("card-new");
    } finally {
      await act(async () => root.unmount());
    }
  });

  it("息屏期间到期的卡在窗口唤醒时立即清退，不残留 00:00:00 僵尸加速态", async () => {
    armComposerSubmission();
    // 回归（spec §9.2/§9.3 清退时钟补偿）：清卡 setTimeout 在页面冻结期间停摆，
    // 唤醒后若不按真实时钟重估，输入框会停在加速态、倒计时却已显示 00:00:00。
    const card = makeCard("card-wake");
    const root = createRoot(installMinimalDom());
    const nowSpy = vi.spyOn(Date, "now");
    try {
      await renderPane(root, "session-a");
      mockDrawHit(card);
      await sendThroughEdit();
      expect(latestComposer().highspeedCard?.cardId).toBe("card-wake");

      // 模拟息屏：清卡定时器停摆，卡按墙钟已过期。
      nowSpy.mockReturnValue(card.expiresAt + 1_000);
      // 回到窗口（focus + 恢复可见）触发补偿，立即清卡。
      await act(async () => {
        triggerDomEvent("window", "focus");
        triggerDomEvent("document", "visibilitychange");
        await flushMicrotasks();
      });
      expect(latestComposer().highspeedCard).toBeNull();
    } finally {
      // 断言失败也必须还原墙钟，否则固定的 Date.now 会泄漏到后续用例。
      nowSpy.mockRestore();
      await act(async () => root.unmount());
    }
  });

  it("清退 timer 早于墙钟到期触发时按剩余时长重挂，到期后清卡", async () => {
    armComposerSubmission();
    // 回归：setTimeout 按单调时钟计时，到期判定读墙钟 Date.now()；两者的毫秒级偏差或 NTP
    // 回拨会让 timer 在墙钟到期前触发。若此时只判定不重挂，窗口常驻前台时加速态永不退出。
    const startedAt = Date.now();
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(startedAt);
    const card = makeCard("card-early-timer");
    const root = createRoot(installMinimalDom());
    const expiryTimers = captureExpiryTimers(card.expiresAt);
    try {
      await renderPane(root, "session-a");
      mockDrawHit(card);
      await sendThroughEdit();
      expect(latestComposer().highspeedCard?.cardId).toBe("card-early-timer");
      expect(expiryTimers.pendingCount).toBe(1);

      // timer 提前 1ms 触发：墙钟尚未到期，卡保留并重挂剩余时长。
      nowSpy.mockReturnValue(card.expiresAt - 1);
      await act(async () => {
        expiryTimers.fireNext();
        await flushMicrotasks();
      });
      expect(latestComposer().highspeedCard?.cardId).toBe("card-early-timer");
      expect(expiryTimers.pendingCount).toBe(1);

      // 重挂的 timer 在墙钟到期后触发：清卡，且不再重挂。
      nowSpy.mockReturnValue(card.expiresAt);
      await act(async () => {
        expiryTimers.fireNext();
        await flushMicrotasks();
      });
      expect(latestComposer().highspeedCard).toBeNull();
      expect(expiryTimers.pendingCount).toBe(0);
    } finally {
      nowSpy.mockRestore();
      await act(async () => root.unmount());
    }
  });

  it("抽卡返回前已切到其他 Task 时，旧 Task 的卡不呈现到当前 Task、也不登记激活", async () => {
    armComposerSubmission();
    // 回归（spec §9.2「卡片不属于当前 Task 时恢复普通态」）：SessionPane 跨 Task 复用同一实例，
    // prepare 在 await 期间用户切走，返回后若直接写卡片状态，A 的卡会出现在 B 的输入框并播放激活。
    const card = makeCard("card-late", "session-a");
    const root = createRoot(installMinimalDom());
    try {
      await renderPane(root, "session-a");
      let resolvePrepare: (value: unknown) => void = () => {};
      servicesMock.highspeedCardService.prepareTurn.mockReturnValueOnce(
        new Promise((resolve) => {
          resolvePrepare = resolve;
        }),
      );
      let sending: Promise<unknown> = Promise.resolve();
      // 两步编辑流：onEdit 只进入编辑态，editUserQuery 与 Highspeed prepare 由 composer 发送触发。
      await act(async () => {
        await timelineProps.at(-1)?.onEdit?.({ rowId: 42, entityId: "message-user-42" });
        await flushMicrotasks();
      });
      await act(async () => {
        sending = Promise.resolve(
          composerProps.at(-1)?.onSendText?.("再加速一轮", {
            attachments: [],
            conversationQuotes: [],
          }),
        );
        await flushMicrotasks();
      });
      expect(servicesMock.highspeedCardService.prepareTurn).toHaveBeenCalledTimes(1);

      await renderPane(root, "session-b");
      await act(async () => {
        resolvePrepare({ kind: "accelerated", card, nextDrawAt: card.expiresAt });
        await sending;
        await flushMicrotasks();
      });
      expect(latestComposer().highspeedCard).toBeNull();
      expect(latestComposer().highspeedActivationCardId).toBeNull();

      // 切回所属 Task：经快照恢复呈现，按 restore 入场，不补播激活。
      servicesMock.highspeedCardService.getSnapshot.mockResolvedValue({
        card,
        nextDrawAt: card.expiresAt,
        drawing: false,
      });
      await renderPane(root, "session-a");
      expect(latestComposer().highspeedCard?.cardId).toBe("card-late");
      expect(latestComposer().highspeedActivationCardId).toBeNull();
    } finally {
      await act(async () => root.unmount());
    }
  });

  it("prepare 开始前已切到其他 Task 时，旧 Task 的卡同样不呈现到当前 Task", async () => {
    // 回归（CR-01）：发送起点曾在 prepare 入口才读取；配置屏障、套餐推荐、建会话等前置 await
    // 期间切到 B 后，起点已被读成 B，A 的卡会呈现到 B 的输入框并播放激活。
    const card = makeCard("card-pre-prepare", "session-a");
    const root = createRoot(installMinimalDom());
    try {
      await renderPane(root, "session-a");
      const { release, sending } = await sendTextHeldBeforePrepare();

      await renderPane(root, "session-b");
      mockDrawHit(card);
      await act(async () => {
        release();
        await sending;
        await flushMicrotasks();
      });
      // 卡仍用于 A 的本轮发送。
      expect(servicesMock.highspeedCardService.prepareTurn).toHaveBeenCalledWith(
        expect.objectContaining({ taskId: "session-a" }),
      );
      expect(sendCommandMock).toHaveBeenCalledWith(
        expect.objectContaining({ type: "sendText", sessionId: "session-a" }),
      );
      expect(latestComposer().highspeedCard).toBeNull();
      expect(latestComposer().highspeedActivationCardId).toBeNull();
    } finally {
      await act(async () => root.unmount());
    }
  });

  it("A → B → A 后结果才返回时，按本端发送路径的首次呈现播放激活", async () => {
    const card = makeCard("card-round-trip", "session-a");
    const root = createRoot(installMinimalDom());
    try {
      await renderPane(root, "session-a");
      const { release, sending } = await sendTextHeldBeforePrepare();

      await renderPane(root, "session-b");
      await renderPane(root, "session-a");
      mockDrawHit(card);
      await act(async () => {
        release();
        await sending;
        await flushMicrotasks();
      });
      expect(latestComposer().highspeedCard?.cardId).toBe("card-round-trip");
      expect(latestComposer().highspeedActivationCardId).toBe("card-round-trip");
    } finally {
      await act(async () => root.unmount());
    }
  });

  it("唤醒时未到期的卡保持加速态并重挂剩余时长的清退 timer", async () => {
    armComposerSubmission();
    const startedAt = Date.now();
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(startedAt);
    const card = makeCard("card-early-wake");
    const root = createRoot(installMinimalDom());
    const expiryTimers = captureExpiryTimers(card.expiresAt);
    try {
      await renderPane(root, "session-a");
      mockDrawHit(card);
      await sendThroughEdit();
      expect(latestComposer().highspeedCard?.cardId).toBe("card-early-wake");

      // 息屏片刻后唤醒：卡仍有效，补偿不得误清，并用剩余时长替换原 timer。
      nowSpy.mockReturnValue(card.expiresAt - 10_000);
      await act(async () => {
        triggerDomEvent("window", "focus");
        triggerDomEvent("document", "visibilitychange");
        await flushMicrotasks();
      });
      expect(latestComposer().highspeedCard?.cardId).toBe("card-early-wake");
      expect(expiryTimers.pendingCount).toBe(1);

      // 重挂的 timer 到期触发后清卡。
      nowSpy.mockReturnValue(card.expiresAt);
      await act(async () => {
        expiryTimers.fireNext();
        await flushMicrotasks();
      });
      expect(latestComposer().highspeedCard).toBeNull();
    } finally {
      nowSpy.mockRestore();
      await act(async () => root.unmount());
    }
  });
});
