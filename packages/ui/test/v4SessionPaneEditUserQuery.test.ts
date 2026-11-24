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
  V4ConversationFileChangesResult,
} from "@codez/shared/codez-protocol-v4";
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

const {
  draftConfigMock,
  fileChangesMock,
  fileRewindPreviewMock,
  headerProps,
  layerMock,
  queueProps,
  sendCommandMock,
  timelineProps,
  composerProps,
} = vi.hoisted(() => ({
  draftConfigMock: {
    modelSelectionState: { status: "loading" } as Record<string, unknown>,
    draftConfig: {} as Record<string, unknown>,
  },
  fileChangesMock: vi.fn(),
  fileRewindPreviewMock: vi.fn(),
  headerProps: [] as Array<{
    onDelete?: () => void;
    onRename?: (title: string) => void;
  }>,
  layerMock: {
    acquire: vi.fn(() => ({
      store: {
        markCommandPending: vi.fn(),
        // editUserQuery 的 ACK 早于 replacement 行时要等编辑呈现，避免行内编辑器先收起。
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
  queueProps: [] as Array<{ onSendNow?: (queueItemId: string) => void }>,
  sendCommandMock: vi.fn(
    async (envelope: CommandEnvelope): Promise<CommandAck> => ({
      commandId: envelope.commandId,
      revisionAtDecision: envelope.baseRevision ?? 0,
      status: "accepted",
    }),
  ),
  timelineProps: [] as Array<{
    bottomDock?: ReactNode;
    scrollMemoryKey?: string | null;
    rowContext?: {
      fetchFileChanges?: (
        target: ConversationRowTarget,
        options: {
          cachePolicy: "in-flight" | "terminal";
          fileChangesState?: "active" | "reverted";
        },
      ) => Promise<V4ConversationFileChangesResult>;
      previewFileRewind?: (target: ConversationRowTarget) => Promise<unknown>;
    };
    onFork?: (target: ConversationRowTarget) => void;
    onRetry?: (target: ConversationRowTarget) => void;
    // 对齐现状：timeline 的 onEdit 就是 composerEdit.beginUserQueryEdit(target)，
    // 只负责进入编辑态并回填原文/附件；editUserQuery 由 composer 发送路由提交（见 beginEditAndSend）。
    onEdit?: (target: ConversationRowTarget) => Promise<void> | void;
  }>,
  composerProps: [] as Array<{
    onSendText?: (
      text: string,
      options?: { attachments?: readonly AttachmentRef[]; conversationQuotes?: unknown[] },
    ) => Promise<unknown>;
  }>,
}));

// 永不 resolve：这些文件不测发现查询；resolve 会在环境拆除后触发 setState（未处理异常）。
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
  highspeedCardService: {
    getSnapshot: vi.fn(async () => ({ card: null, nextDrawAt: null, drawing: false })),
    prepareTurn: vi.fn(async () => ({
      kind: "fallback" as const,
      reason: "draw-miss" as const,
      nextDrawAt: null,
    })),
    healthy: vi.fn(),
    share: vi.fn(),
  
      getCurrentOwnerKey: vi.fn(async () => null),
      invalidateCard: vi.fn(async () => {}),
    },
  // 修复原因：readiness hook 将 service 作为 effect 依赖；每次 render 重建会导致无限重渲染直至 OOM。
  codezSessionService: {
    updateProviderRegistry: vi.fn(),
  },
  codezTaskService: {
    restartWorkspaceProcess: vi.fn(),
  },
}));

// 本组隔离编辑/设置行为，群投递服务由独立单测及 Host/CLI E2E 覆盖。
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

vi.mock("@/v4/BotGroupDeliveryAction.js", () => ({
  BotGroupDeliveryProvider: ({ children }: { children: unknown }) => children,
  ConnectedBotGroupDeliveryAction: () => null,
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
    fileChanges: fileChangesMock,
    fileRewindPreview: fileRewindPreviewMock,
    layer: layerMock,
    sendCommand: sendCommandMock,
    // SessionPane 挂载即拉 journal 兜底的 run 发现查询：缺桩会在 effect 里 TypeError；
    // 桩必须是稳定引用——effect 以 workflowRuns 为依赖，每次渲染换新函数会死循环。
    workflowRuns: workflowRunsQueryMock,
  }),
}));

vi.mock("@/store/StoreProvider.js", () => ({
  useCodezStoreWithDefault: (_selector: unknown, fallback: unknown) => fallback,
}));

vi.mock("@/v4/composer/useDraftConfigControl.js", () => ({
  buildDraftCreateConfigPayload: () => ({}),
  useDraftConfigControl: () => ({
    modelSelectionRead: { state: draftConfigMock.modelSelectionState, reload: vi.fn() },
    captureAcceptedModelSelection: () => vi.fn(),
    draftConfig: draftConfigMock.draftConfig,
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
}));

vi.mock("@/v4/composer/useDraftSessionPrewarm.js", () => ({
  useDraftSessionPrewarm: () => ({
    binding: null,
  }),
}));

vi.mock("@/v4/ConversationComposer.js", async () => {
  const React = await import("react");
  return {
    ConversationComposer: (props: Record<string, unknown>) => {
      composerProps.push(props as unknown as (typeof composerProps)[number]);
      return React.createElement("div", { "data-testid": "mock-composer" });
    },
  };
});

vi.mock("@/v4/ConversationHeader.js", async () => {
  const React = await import("react");
  return {
    ConversationHeader: (props: Record<string, unknown>) => {
      headerProps.push(props as (typeof headerProps)[number]);
      return React.createElement("div", { "data-testid": "mock-header" });
    },
  };
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
    ConversationQueuePanel: (props: Record<string, unknown>) => {
      queueProps.push(props as (typeof queueProps)[number]);
      return React.createElement("div", { "data-testid": "mock-queue" });
    },
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

/**
 * 对齐现状：editUserQuery 与普通发送共用 fail-closed 提交门禁——
 * createComposerSubmissionConfig 要求 draftConfig 带有效 modelSelection，且 modelSelectionView
 * 能校验该选择；否则 handleEdit 直接 toast「发送失败」并返回 blocked，一条命令都不会发。
 * 编辑类用例必须先给 composer 一个可提交配置。
 */
function armComposerSubmission() {
  // validateModelSelectionOptions 要求 model.config.optionSpecs.reasoningLevel.values 存在，
  // 且选择必须带一个在候选内的 reasoningLevel；缺任一个都判不可提交。
  draftConfigMock.modelSelectionState = {
    status: "ready",
    view: {
      revision: 1,
      providers: [
        {
          providerId: "edit-provider",
          models: [
            {
              modelId: "edit-model",
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
      providerId: "edit-provider",
      modelId: "edit-model",
      options: { reasoningLevel: "high" },
    },
  };
}

function installMinimalDom() {
  const documentMock = {
    // IntlProvider 会写 document.documentElement.lang；最小 DOM 需补齐该节点。
    documentElement: { lang: "" },
    // toast() 会 document.body.appendChild(host)；提交门禁失败等分支会走到这里，
    // 缺 body 会抛 TypeError 把真正的失败原因盖掉。body 需要 ownerDocument 指回自己，
    // 因此先占位、构造完成后再回填（对象字面量里直接引用自身会踩 TDZ）。
    body: undefined as unknown as Element,
    addEventListener: () => {},
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
  } as unknown as Document;
  (documentMock as unknown as { body: Element }).body = createMinimalElement(documentMock, "body");
  // toast() 在宿主未挂载时用 requestAnimationFrame 重试入队；编辑提交被 blocked 的分支
  // （failed/rejected/stale ACK）会走到 toast，最小 DOM 必须补上这个计时器 shim。
  const requestAnimationFrameShim = (callback: FrameRequestCallback) =>
    setTimeout(() => callback(Date.now()), 0) as unknown as number;
  const cancelAnimationFrameShim = (handle: number) => clearTimeout(handle);
  const windowMock = {
    addEventListener: () => {},
    cancelAnimationFrame: cancelAnimationFrameShim,
    clearTimeout,
    document: documentMock,
    HTMLElement: function HTMLElement() {},
    HTMLIFrameElement: function HTMLIFrameElement() {},
    Node: function Node() {},
    removeEventListener: () => {},
    requestAnimationFrame: requestAnimationFrameShim,
    setTimeout,
  } as unknown as Window & typeof globalThis;
  Object.assign(globalThis, {
    cancelAnimationFrame: cancelAnimationFrameShim,
    document: documentMock,
    HTMLElement: windowMock.HTMLElement,
    HTMLIFrameElement: windowMock.HTMLIFrameElement,
    IS_REACT_ACT_ENVIRONMENT: true,
    Node: windowMock.Node,
    requestAnimationFrame: requestAnimationFrameShim,
    window: windowMock,
  });
  return createMinimalElement(documentMock, "div");
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

function makeSnapshot(rows: ConversationSnapshot["rows"]["window"] = []): ConversationSnapshot {
  return {
    protocolVersion: 1,
    sessionId: "session-1",
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
      provider: "",
      model: "",
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
    rows: { window: rows, totalCount: rows.length, firstRowId: rows[0]?.rowId ?? null },
  };
}

/**
 * 可编辑的用户输入行。beginUserQueryEdit 只在 snapshot.rows.window 里找到
 * kind === "userInput" 且 actions.canEdit 的行时才进入编辑态，因此编辑类用例必须把它投进快照。
 */
function editableUserRow(
  rowId = 42,
  entityId = "message-user-42",
  text = "原问题",
): ConversationSnapshot["rows"]["window"][number] {
  return {
    rowId,
    turnId: "turn-1",
    createdAt: 1_700_000_000_000 + rowId,
    createdAtSeq: rowId,
    kind: "userInput",
    entityId,
    origin: "realUser",
    text,
    actions: { canEdit: true },
  } as ConversationSnapshot["rows"]["window"][number];
}

/**
 * 两步编辑流：timeline onEdit 进入编辑态 → composer 发送路由提交 editUserQuery。
 * 旧的一步式 onEdit(target, newText, attachments) 已不存在。
 */
async function beginEditAndSend(
  target: ConversationRowTarget,
  newText: string,
  attachments?: readonly AttachmentRef[],
) {
  await act(async () => {
    await timelineProps.at(-1)?.onEdit?.(target);
    await flushMicrotasks();
  });
  await act(async () => {
    await composerProps.at(-1)?.onSendText?.(newText, {
      ...(attachments ? { attachments } : {}),
      conversationQuotes: [],
    });
    await flushMicrotasks();
  });
}

function makeEmptyFileChanges(): V4ConversationFileChangesResult {
  return {
    files: 0,
    additions: 0,
    deletions: 0,
    items: [],
  };
}

afterEach(() => {
  fileChangesMock.mockReset();
  fileRewindPreviewMock.mockReset();
  // 用 mockReset 而不是 mockClear：mockClear 不会清掉未消费的 mockResolvedValueOnce /
  // mockImplementationOnce 队列。编辑类用例一旦没有真正发出命令，排好的 ACK 就会泄漏到
  // 下一个用例，把它的 fork/edit ACK 顶掉（表现为 fork 收到默认 accepted 而不导航）。
  sendCommandMock.mockReset();
  sendCommandMock.mockImplementation(async (envelope: CommandEnvelope): Promise<CommandAck> => ({
    commandId: envelope.commandId,
    revisionAtDecision: envelope.baseRevision ?? 0,
    status: "accepted",
  }));
  layerMock.acquire.mockImplementation(() => ({
    store: {
      markCommandPending: vi.fn(),
      waitForEditPresentation: vi.fn(async () => {}),
      expectAcceptedInputProjection: vi.fn(),
      recoverFromStaleAuthority: vi.fn(),
      onOnlineModelTransition: vi.fn(() => () => {}),
      refreshPlans: vi.fn(async () => {}),
      settleCommand: vi.fn(),
    },
    release: vi.fn(),
  }));
  headerProps.length = 0;
  queueProps.length = 0;
  timelineProps.length = 0;
  composerProps.length = 0;
  draftConfigMock.modelSelectionState = { status: "loading" };
  draftConfigMock.draftConfig = {};
  servicesMock.highspeedCardService.prepareTurn.mockReset();
  servicesMock.highspeedCardService.prepareTurn.mockResolvedValue({
    kind: "fallback",
    reason: "draw-miss",
    nextDrawAt: null,
  });
  projectionState.current = null;
  delete (globalThis as { document?: unknown }).document;
  delete (globalThis as { window?: unknown }).window;
  delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: unknown }).IS_REACT_ACT_ENVIRONMENT;
});

describe("SessionPane user query editing", () => {
  it("builds pane-isolated timeline scroll memory keys for bound sessions", async () => {
    projectionState.current = {
      status: "live",
      snapshot: makeSnapshot(),
      subscriptionId: "sub-1",
      lastError: null,
      optimisticCommands: [],
      loadingOlder: false,
    };
    const root: Root = createRoot(installMinimalDom());

    await act(async () => {
      root.render(
        createElement(
          CodezIntlProvider,
          { initialLocale: "zh-CN" },
          createElement(SessionPaneWithTabStore, {
            paneId: "pane-2",
            sessionId: "session-1",
            workspaceIdentity: "ssh://demo",
            workspacePath: "/workspace",
          }),
        ),
      );
      await flushMicrotasks();
    });

    expect(timelineProps.at(-1)?.scrollMemoryKey).toBe(
      "ssh://demo::pane:pane-2::session:session-1",
    );

    await act(async () => {
      root.unmount();
    });
  });

  it("虚拟行复挂载共享同一 fileChanges 请求，target 或 logEpoch 变化后才重查", async () => {
    projectionState.current = {
      status: "live",
      snapshot: makeSnapshot(),
      subscriptionId: "sub-1",
      lastError: null,
      optimisticCommands: [],
      loadingOlder: false,
    };
    let resolveFirstRequest: ((value: V4ConversationFileChangesResult) => void) | undefined;
    const firstRequest = new Promise<V4ConversationFileChangesResult>((resolve) => {
      resolveFirstRequest = resolve;
    });
    fileChangesMock.mockReturnValueOnce(firstRequest).mockResolvedValue(makeEmptyFileChanges());
    const root: Root = createRoot(installMinimalDom());
    const renderPane = () =>
      createElement(
        CodezIntlProvider,
        { initialLocale: "zh-CN" },
        createElement(SessionPaneWithTabStore, {
          paneId: "workspace-main",
          sessionId: "session-1",
          workspacePath: "/workspace",
        }),
      );

    await act(async () => {
      root.render(renderPane());
      await flushMicrotasks();
    });

    const target = { rowId: 42, entityId: "entity-42" };
    const fetchBeforeRemount = timelineProps.at(-1)?.rowContext?.fetchFileChanges;
    const pendingFromFirstMount = fetchBeforeRemount?.(target, {
      cachePolicy: "terminal",
    });
    await act(async () => {
      root.render(renderPane());
      await flushMicrotasks();
    });
    const fetchAfterRemount = timelineProps.at(-1)?.rowContext?.fetchFileChanges;
    const pendingFromRemount = fetchAfterRemount?.({ ...target }, { cachePolicy: "terminal" });

    expect(fileChangesMock).toHaveBeenCalledTimes(1);
    expect(pendingFromRemount).toBe(pendingFromFirstMount);
    resolveFirstRequest?.(makeEmptyFileChanges());
    await Promise.all([pendingFromFirstMount, pendingFromRemount]);

    await fetchAfterRemount?.({ ...target }, { cachePolicy: "terminal" });
    expect(fileChangesMock).toHaveBeenCalledTimes(1);

    await fetchAfterRemount?.({ rowId: 43, entityId: "entity-43" }, { cachePolicy: "terminal" });
    expect(fileChangesMock).toHaveBeenCalledTimes(2);

    const nextSnapshot = makeSnapshot();
    nextSnapshot.logEpoch = "epoch-2";
    nextSnapshot.revision = 8;
    projectionState.current = {
      ...projectionState.current,
      snapshot: nextSnapshot,
    } as NonNullable<typeof projectionState.current>;
    await act(async () => {
      root.render(renderPane());
      await flushMicrotasks();
    });

    await timelineProps
      .at(-1)
      ?.rowContext?.fetchFileChanges?.({ ...target }, { cachePolicy: "terminal" });
    expect(fileChangesMock).toHaveBeenCalledTimes(3);
    expect(fileChangesMock).toHaveBeenLastCalledWith(
      expect.objectContaining({
        baseLogEpoch: "epoch-2",
        target,
      }),
    );

    await act(async () => root.unmount());
  });

  it("终态 fileChanges 缓存按 active/reverted 状态隔离", async () => {
    projectionState.current = {
      status: "live",
      snapshot: makeSnapshot(),
      subscriptionId: "sub-1",
      lastError: null,
      optimisticCommands: [],
      loadingOlder: false,
    };
    const activeResult = {
      ...makeEmptyFileChanges(),
      state: "active" as const,
      files: 1,
      items: [{ path: "/workspace/README.md", patches: [] }],
    };
    const revertedResult = {
      ...makeEmptyFileChanges(),
      state: "reverted" as const,
    };
    fileChangesMock.mockResolvedValueOnce(activeResult).mockResolvedValueOnce(revertedResult);
    const root: Root = createRoot(installMinimalDom());
    const renderPane = () =>
      createElement(
        CodezIntlProvider,
        { initialLocale: "zh-CN" },
        createElement(SessionPaneWithTabStore, {
          paneId: "workspace-main",
          sessionId: "session-1",
          workspacePath: "/workspace",
        }),
      );

    await act(async () => {
      root.render(renderPane());
      await flushMicrotasks();
    });

    const target = { rowId: 42, entityId: "entity-42" };
    const fetchActive = timelineProps.at(-1)?.rowContext?.fetchFileChanges;
    await expect(
      fetchActive?.(target, {
        cachePolicy: "terminal",
        fileChangesState: "active",
      }),
    ).resolves.toEqual(activeResult);
    await expect(
      fetchActive?.(
        { ...target },
        {
          cachePolicy: "terminal",
          fileChangesState: "active",
        },
      ),
    ).resolves.toEqual(activeResult);
    expect(fileChangesMock).toHaveBeenCalledTimes(1);

    const revertedSnapshot = makeSnapshot();
    revertedSnapshot.revision = 8;
    projectionState.current = {
      ...projectionState.current,
      snapshot: revertedSnapshot,
    } as NonNullable<typeof projectionState.current>;
    await act(async () => {
      root.render(renderPane());
      await flushMicrotasks();
    });

    const fetchReverted = timelineProps.at(-1)?.rowContext?.fetchFileChanges;
    await expect(
      fetchReverted?.(target, {
        cachePolicy: "terminal",
        fileChangesState: "reverted",
      }),
    ).resolves.toEqual(revertedResult);
    await expect(
      fetchReverted?.(
        { ...target },
        {
          cachePolicy: "terminal",
          fileChangesState: "reverted",
        },
      ),
    ).resolves.toEqual(revertedResult);
    expect(fileChangesMock).toHaveBeenCalledTimes(2);
    expect(fileChangesMock).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ baseRevision: 8, target }),
    );

    await act(async () => root.unmount());
  });

  it("fileChanges 完整结果缓存最多保留 20 个 turn", async () => {
    projectionState.current = {
      status: "live",
      snapshot: makeSnapshot(),
      subscriptionId: "sub-1",
      lastError: null,
      optimisticCommands: [],
      loadingOlder: false,
    };
    fileChangesMock.mockResolvedValue(makeEmptyFileChanges());
    const root: Root = createRoot(installMinimalDom());
    await act(async () => {
      root.render(
        createElement(
          CodezIntlProvider,
          { initialLocale: "zh-CN" },
          createElement(SessionPaneWithTabStore, {
            paneId: "workspace-main",
            sessionId: "session-1",
            workspacePath: "/workspace",
          }),
        ),
      );
      await flushMicrotasks();
    });

    const fetchFileChanges = timelineProps.at(-1)?.rowContext?.fetchFileChanges;
    for (let rowId = 1; rowId <= 21; rowId += 1) {
      await fetchFileChanges?.({ rowId, entityId: `entity-${rowId}` }, { cachePolicy: "terminal" });
    }
    await fetchFileChanges?.({ rowId: 1, entityId: "entity-1" }, { cachePolicy: "terminal" });

    expect(fileChangesMock).toHaveBeenCalledTimes(22);
    await act(async () => root.unmount());
  });

  it("运行中 revision 前进后重查 fileChanges，终态结果才跨复挂载缓存", async () => {
    const runningSnapshot = makeSnapshot();
    runningSnapshot.revision = 7;
    projectionState.current = {
      status: "live",
      snapshot: runningSnapshot,
      subscriptionId: "sub-1",
      lastError: null,
      optimisticCommands: [],
      loadingOlder: false,
    };
    const partialResult = {
      ...makeEmptyFileChanges(),
      files: 1,
      items: [{ path: "/workspace/README.md", patches: [] }],
    };
    const finalResult = {
      ...makeEmptyFileChanges(),
      files: 2,
      items: [
        { path: "/workspace/README.md", patches: [] },
        { path: "/workspace/index.html", patches: [] },
      ],
    };
    let resolveRunningRequest: ((value: V4ConversationFileChangesResult) => void) | undefined;
    const runningRequest = new Promise<V4ConversationFileChangesResult>((resolve) => {
      resolveRunningRequest = resolve;
    });
    fileChangesMock.mockReturnValueOnce(runningRequest).mockResolvedValueOnce(finalResult);
    const root: Root = createRoot(installMinimalDom());
    const renderPane = () =>
      createElement(
        CodezIntlProvider,
        { initialLocale: "zh-CN" },
        createElement(SessionPaneWithTabStore, {
          paneId: "workspace-main",
          sessionId: "session-1",
          workspacePath: "/workspace",
        }),
      );

    await act(async () => {
      root.render(renderPane());
      await flushMicrotasks();
    });
    const target = { rowId: 42, entityId: "entity-42" };
    const fetchWhileRunning = timelineProps.at(-1)?.rowContext?.fetchFileChanges;
    const firstRunningResult = fetchWhileRunning?.(target, {
      cachePolicy: "in-flight",
    });
    const duplicateRunningResult = fetchWhileRunning?.({ ...target }, { cachePolicy: "in-flight" });
    expect(duplicateRunningResult).toBe(firstRunningResult);
    expect(fileChangesMock).toHaveBeenCalledTimes(1);
    resolveRunningRequest?.(partialResult);
    await expect(firstRunningResult).resolves.toEqual(partialResult);
    await expect(duplicateRunningResult).resolves.toEqual(partialResult);

    const terminalSnapshot = makeSnapshot();
    terminalSnapshot.revision = 8;
    projectionState.current = {
      ...projectionState.current,
      snapshot: terminalSnapshot,
    } as NonNullable<typeof projectionState.current>;
    await act(async () => {
      root.render(renderPane());
      await flushMicrotasks();
    });

    const fetchAfterTerminal = timelineProps.at(-1)?.rowContext?.fetchFileChanges;
    await expect(fetchAfterTerminal?.(target, { cachePolicy: "terminal" })).resolves.toEqual(
      finalResult,
    );
    await expect(fetchAfterTerminal?.({ ...target }, { cachePolicy: "terminal" })).resolves.toEqual(
      finalResult,
    );

    expect(fileChangesMock).toHaveBeenCalledTimes(2);
    expect(fileChangesMock).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ baseRevision: 7, target }),
    );
    expect(fileChangesMock).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ baseRevision: 8, target }),
    );
    await act(async () => root.unmount());
  });

  it("row command 收到 stale log epoch ACK 时触发 projection resync", async () => {
    const recoverFromStaleLogEpoch = vi.fn();
    layerMock.acquire.mockReturnValue({
      store: {
        markCommandPending: vi.fn(),
        // editUserQuery 的 ACK 早于 replacement 行时要等编辑呈现，避免行内编辑器先收起。
        waitForEditPresentation: vi.fn(async () => {}),
        expectAcceptedInputProjection: vi.fn(),
        onOnlineModelTransition: vi.fn(() => () => {}),
        refreshPlans: vi.fn(async () => {}),
        recoverFromStaleAuthority: recoverFromStaleLogEpoch,
        settleCommand: vi.fn(),
      },
      release: vi.fn(),
    } as never);
    projectionState.current = {
      status: "live",
      snapshot: makeSnapshot(),
      subscriptionId: "sub-1",
      lastError: null,
      optimisticCommands: [],
      loadingOlder: false,
    };
    sendCommandMock.mockImplementationOnce(async (command: CommandEnvelope) => ({
      commandId: command.commandId,
      revisionAtDecision: 8,
      status: "stale",
      reasonCode: "proto.staleLogEpoch",
    }));
    const root: Root = createRoot(installMinimalDom());
    await act(async () => {
      root.render(
        createElement(
          CodezIntlProvider,
          { initialLocale: "zh-CN" },
          createElement(SessionPaneWithTabStore, {
            paneId: "workspace-main",
            sessionId: "session-1",
            workspacePath: "/workspace",
          }),
        ),
      );
      await flushMicrotasks();
    });

    await act(async () => {
      timelineProps.at(-1)?.onRetry?.({ rowId: 42, entityId: "message-assistant-42" });
      await flushMicrotasks();
    });

    expect(recoverFromStaleLogEpoch).toHaveBeenCalledTimes(1);
    await act(async () => root.unmount());
  });

  it.each(["proto.staleTarget", "proto.staleRevision"])(
    "row command 收到 %s ACK 时同样触发 projection resync",
    async (reasonCode) => {
      const recoverFromStaleAuthority = vi.fn();
      layerMock.acquire.mockReturnValue({
        store: {
          markCommandPending: vi.fn(),
          waitForEditPresentation: vi.fn(async () => {}),
          expectAcceptedInputProjection: vi.fn(),
          onOnlineModelTransition: vi.fn(() => () => {}),
          refreshPlans: vi.fn(async () => {}),
          recoverFromStaleAuthority,
          settleCommand: vi.fn(),
        },
        release: vi.fn(),
      } as never);
      projectionState.current = {
        status: "live",
        snapshot: makeSnapshot(),
        subscriptionId: "sub-1",
        lastError: null,
        optimisticCommands: [],
        loadingOlder: false,
      };
      sendCommandMock.mockResolvedValueOnce({
        commandId: "cmd-stale-target",
        revisionAtDecision: 8,
        status: "stale",
        reasonCode,
      });
      const root: Root = createRoot(installMinimalDom());
      await act(async () => {
        root.render(
          createElement(
            CodezIntlProvider,
            { initialLocale: "zh-CN" },
            createElement(SessionPaneWithTabStore, {
              paneId: "workspace-main",
              sessionId: "session-1",
              workspacePath: "/workspace",
            }),
          ),
        );
        await flushMicrotasks();
      });
      await act(async () => {
        timelineProps.at(-1)?.onRetry?.({ rowId: 42, entityId: "stale-entity" });
        await flushMicrotasks();
      });
      expect(recoverFromStaleAuthority).toHaveBeenCalledTimes(1);
      await act(async () => root.unmount());
    },
  );

  it("file changes/preview stale authority fault 触发同一 projection recovery", async () => {
    const recoverFromStaleAuthority = vi.fn();
    layerMock.acquire.mockReturnValue({
      store: {
        markCommandPending: vi.fn(),
        // editUserQuery 的 ACK 早于 replacement 行时要等编辑呈现，避免行内编辑器先收起。
        waitForEditPresentation: vi.fn(async () => {}),
        expectAcceptedInputProjection: vi.fn(),
        onOnlineModelTransition: vi.fn(() => () => {}),
        refreshPlans: vi.fn(async () => {}),
        recoverFromStaleAuthority,
        settleCommand: vi.fn(),
      },
      release: vi.fn(),
    } as never);
    projectionState.current = {
      status: "live",
      snapshot: makeSnapshot(),
      subscriptionId: "sub-1",
      lastError: null,
      optimisticCommands: [],
      loadingOlder: false,
    };
    fileChangesMock.mockRejectedValueOnce(new Error("proto.staleLogEpoch"));
    fileRewindPreviewMock.mockRejectedValueOnce(new Error("proto.staleTarget"));
    const root: Root = createRoot(installMinimalDom());
    await act(async () => {
      root.render(
        createElement(
          CodezIntlProvider,
          { initialLocale: "zh-CN" },
          createElement(SessionPaneWithTabStore, {
            paneId: "workspace-main",
            sessionId: "session-1",
            workspacePath: "/workspace",
          }),
        ),
      );
      await flushMicrotasks();
    });
    const target = { rowId: 42, entityId: "entity-42" };
    await expect(
      timelineProps.at(-1)?.rowContext?.fetchFileChanges?.(target, { cachePolicy: "terminal" }),
    ).rejects.toThrow("proto.staleLogEpoch");
    fileChangesMock.mockResolvedValueOnce(makeEmptyFileChanges());
    await expect(
      timelineProps.at(-1)?.rowContext?.fetchFileChanges?.(target, { cachePolicy: "terminal" }),
    ).resolves.toEqual(makeEmptyFileChanges());
    expect(fileChangesMock).toHaveBeenCalledTimes(2);
    await expect(timelineProps.at(-1)?.rowContext?.previewFileRewind?.(target)).rejects.toThrow(
      "proto.staleTarget",
    );
    expect(recoverFromStaleAuthority).toHaveBeenCalledTimes(2);
    await act(async () => root.unmount());
  });

  it("running 时向 Timeline 提供 edit、fork 与 retry 回调，由 row.actions 裁决展示", async () => {
    const snapshot = makeSnapshot();
    snapshot.control = {
      ...snapshot.control,
      phase: "running",
      sessionEnded: false,
      canStop: true,
      stopState: "stoppable",
      activeWorks: [{ kind: "primaryTurn", startedAt: 1_700_000_000_000 }],
    };
    projectionState.current = {
      status: "live",
      snapshot,
      subscriptionId: "sub-1",
      lastError: null,
      optimisticCommands: [],
      loadingOlder: false,
    };
    const root: Root = createRoot(installMinimalDom());

    await act(async () => {
      root.render(
        createElement(
          CodezIntlProvider,
          { initialLocale: "zh-CN" },
          createElement(SessionPaneWithTabStore, {
            paneId: "workspace-main",
            sessionId: "session-1",
            workspacePath: "/workspace",
          }),
        ),
      );
      await flushMicrotasks();
    });

    const props = timelineProps.at(-1);
    expect(typeof props?.onEdit).toBe("function");
    expect(props?.onFork).toBeTypeOf("function");
    // row.actions 是唯一 action authority；Timeline 收到稳定 resolver，再逐 row 决定是否展示 retry。
    expect(props?.onRetry).toBeTypeOf("function");

    await act(async () => {
      root.unmount();
    });
  });

  it("dispatches editUserQuery with edited text and original attachments", async () => {
    armComposerSubmission();
    const attachments: AttachmentRef[] = [
      {
        bytes: 12,
        fileName: "note.txt",
        mime: "text/plain",
        ref: "/workspace/note.txt",
      },
    ];
    projectionState.current = {
      status: "live",
      snapshot: makeSnapshot([editableUserRow()]),
      subscriptionId: "sub-1",
      lastError: null,
      optimisticCommands: [],
      loadingOlder: false,
    };
    const root: Root = createRoot(installMinimalDom());

    await act(async () => {
      root.render(
        createElement(
          CodezIntlProvider,
          { initialLocale: "zh-CN" },
          createElement(SessionPaneWithTabStore, {
            paneId: "workspace-main",
            sessionId: "session-1",
            workspacePath: "/workspace",
          }),
        ),
      );
      await flushMicrotasks();
    });

    await beginEditAndSend({ rowId: 42, entityId: "message-user-42" }, "改过的问题", attachments);

    expect(sendCommandMock).toHaveBeenCalledTimes(1);
    expect(sendCommandMock.mock.calls[0]?.[0]).toMatchObject({
      baseRevision: 7,
      baseLogEpoch: "epoch-1",
      payload: {
        attachments,
        newText: "改过的问题",
        target: { rowId: 42, entityId: "message-user-42" },
      },
      sessionId: "session-1",
      type: "editUserQuery",
    });

    await act(async () => {
      root.unmount();
    });
  });

  it("编辑重发时携带当前 Composer 的模型、思考等级与计划模式配置", async () => {
    draftConfigMock.modelSelectionState = {
      status: "ready",
      view: {
        revision: 1,
        providers: [
          {
            providerId: "custom-provider",
            models: [
              {
                modelId: "model-secondary",
                config: {
                  optionSpecs: {
                    reasoningLevel: {
                      values: ["low", "high"],
                    },
                  },
                },
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
        providerId: "custom-provider",
        modelId: "model-secondary",
        options: { reasoningLevel: "high" },
      },
    };
    projectionState.current = {
      status: "live",
      snapshot: makeSnapshot([editableUserRow()]),
      subscriptionId: "sub-1",
      lastError: null,
      optimisticCommands: [],
      loadingOlder: false,
    };
    const root: Root = createRoot(installMinimalDom());

    try {
      await act(async () => {
        root.render(
          createElement(
            CodezIntlProvider,
            { initialLocale: "zh-CN" },
            createElement(SessionPaneWithTabStore, {
              paneId: "workspace-main",
              sessionId: "session-1",
              workspacePath: "/workspace",
            }),
          ),
        );
        await flushMicrotasks();
      });

      await beginEditAndSend({ rowId: 42, entityId: "message-user-42" }, "切换模型后的问题", []);

      expect(sendCommandMock).toHaveBeenCalledTimes(1);
      expect(servicesMock.projectService.resolveSessionDirectories).toHaveBeenCalledWith(
        { workspacePath: "/workspace", workspaceIdentity: undefined, taskId: "session-1" },
        "local",
      );
      expect(sendCommandMock.mock.calls[0]?.[0]).toMatchObject({
        baseRevision: 7,
        baseLogEpoch: "epoch-1",
        payload: {
          attachments: [],
          newText: "切换模型后的问题",
          target: { rowId: 42, entityId: "message-user-42" },
          mode: "build",
          planEnabled: false,
          modelSelection: {
            providerId: "custom-provider",
            modelId: "model-secondary",
            options: { reasoningLevel: "high" },
          },
        },
        sessionId: "session-1",
        type: "editUserQuery",
      });
    } finally {
      draftConfigMock.modelSelectionState = { status: "loading" };
      draftConfigMock.draftConfig = {};
      await act(async () => {
        root.unmount();
      });
    }
  });

  it("重新编辑时重新准备 Highspeed，并随 editUserQuery 提交本次卡和 runtime", async () => {
    armComposerSubmission();
    const snapshot = makeSnapshot([editableUserRow()]);
    snapshot.config = {
      ...snapshot.config,
      provider: "builtin:bigmodel-coding-plan",
      model: "GLM-5.3",
    };
    projectionState.current = {
      status: "live",
      snapshot,
      subscriptionId: "sub-1",
      lastError: null,
      optimisticCommands: [],
      loadingOlder: false,
    };
    const highspeedMeta = {
      schemaVersion: 1 as const,
      cardId: "card-edit",
      taskId: "session-1",
      provider: "builtin:bigmodel-coding-plan",
      model: "GLM-5.3",
      issuedAt: 1,
      expiresAt: Date.now() + 60_000,
    };
    const execution = {
      modelSelection: { providerId: "account:bigmodel-highspeed-card", modelId: "GLM-5.3" },
      requestAuth: {
        apiKey: "card-jwt",
        headers: { Authorization: "Bearer card-jwt", "X-Highspeed-Card-ID": "card-edit" },
      },
      selectionFallback: {
        providerId: "account:bigmodel-highspeed-card",
        rules: [
          { reason: "highspeed_card_expired" as const, providerErrorCode: "3402" },
          { reason: "highspeed_request_failed" as const },
        ],
      },
    };
    servicesMock.highspeedCardService.prepareTurn.mockResolvedValueOnce({
      kind: "accelerated",
      card: highspeedMeta,
      nextDrawAt: highspeedMeta.expiresAt,
      execution,
    });
    const root: Root = createRoot(installMinimalDom());

    await act(async () => {
      root.render(
        createElement(
          CodezIntlProvider,
          { initialLocale: "zh-CN" },
          createElement(SessionPaneWithTabStore, {
            paneId: "workspace-main",
            sessionId: "session-1",
            workspacePath: "/workspace",
          }),
        ),
      );
      await flushMicrotasks();
    });
    await beginEditAndSend({ rowId: 42, entityId: "message-user-42" }, "重新加速的问题", []);

    expect(servicesMock.highspeedCardService.prepareTurn).toHaveBeenCalledWith(
      expect.objectContaining({ taskId: "session-1" }),
    );
    expect(sendCommandMock.mock.calls[0]?.[0]).toMatchObject({
      type: "editUserQuery",
      payload: {
        highspeedMeta,
        // 显式重编辑会重新抽卡：Selection 与执行材料必须整体刷新，且永远是 execution 作用域，
        // 不允许把会话常驻 Selection 改成加速卡 Provider。
        modelSelection: execution.modelSelection,
        modelExecution: {
          selectionScope: "execution",
          requestAuth: execution.requestAuth,
          selectionFallback: execution.selectionFallback,
        },
      },
    });
    expect(
      layerMock.acquire.mock.results.at(-1)?.value.store.expectAcceptedInputProjection,
    ).toHaveBeenCalledWith(sendCommandMock.mock.calls[0]?.[0].commandId);

    await act(async () => root.unmount());
  });

  it("手动发送 Highspeed 队列项时刷新同卡 runtime 后再提升", async () => {
    const snapshot = makeSnapshot();
    const highspeedMeta = {
      schemaVersion: 1 as const,
      cardId: "card-queue",
      taskId: "session-1",
      provider: "builtin:bigmodel-coding-plan",
      model: "GLM-5.3",
      issuedAt: 1,
      expiresAt: Date.now() + 60_000,
    };
    snapshot.queue = {
      autoDrain: false,
      items: [
        {
          sourceCommandId: "source-queue",
          queueItemId: "queue-1",
          clientId: "client-1",
          kind: "sendText",
          text: "排队消息",
          attachments: [],
          delivery: { requested: "queue", admitted: "queue" },
          order: { admissionSeq: 1, queuePosition: 0 },
          steer: { state: "notRequested" },
          dispatch: { state: "queued" },
          admittedAt: 1,
          highspeed: highspeedMeta,
        },
      ],
    };
    snapshot.availability = {
      ...snapshot.availability,
      sendQueuedNow: { allowed: true },
    };
    snapshot.config = {
      ...snapshot.config,
      provider: "builtin:bigmodel-coding-plan",
      model: "GLM-5.3",
    };
    projectionState.current = {
      status: "live",
      snapshot,
      subscriptionId: "sub-1",
      lastError: null,
      optimisticCommands: [],
      loadingOlder: false,
    };
    const execution = {
      modelSelection: { providerId: "account:bigmodel-highspeed-card", modelId: "GLM-5.3" },
      requestAuth: {
        apiKey: "card-jwt",
        headers: { Authorization: "Bearer card-jwt", "X-Highspeed-Card-ID": "card-queue" },
      },
      selectionFallback: {
        providerId: "account:bigmodel-highspeed-card",
        rules: [
          { reason: "highspeed_card_expired" as const, providerErrorCode: "3402" },
          { reason: "highspeed_request_failed" as const },
        ],
      },
    };
    servicesMock.highspeedCardService.prepareTurn.mockResolvedValueOnce({
      kind: "accelerated",
      card: highspeedMeta,
      nextDrawAt: highspeedMeta.expiresAt,
      execution,
    });
    const root: Root = createRoot(installMinimalDom());

    await act(async () => {
      root.render(
        createElement(
          CodezIntlProvider,
          { initialLocale: "zh-CN" },
          createElement(SessionPaneWithTabStore, {
            paneId: "workspace-main",
            sessionId: "session-1",
            workspacePath: "/workspace",
          }),
        ),
      );
      await flushMicrotasks();
    });
    await act(async () => {
      queueProps.at(-1)?.onSendNow?.("queue-1");
      await flushMicrotasks();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(sendCommandMock.mock.calls[0]?.[0]).toMatchObject({
      type: "sendQueuedNow",
      payload: {
        queueItemId: "queue-1",
        highspeedMeta,
        modelSelection: execution.modelSelection,
        modelExecution: {
          selectionScope: "execution",
          requestAuth: execution.requestAuth,
          selectionFallback: execution.selectionFallback,
        },
      },
    });

    await act(async () => root.unmount());
  });

  it("serializes an explicit empty attachment list when edit removes every ref", async () => {
    armComposerSubmission();
    projectionState.current = {
      status: "live",
      snapshot: makeSnapshot([editableUserRow()]),
      subscriptionId: "sub-1",
      lastError: null,
      optimisticCommands: [],
      loadingOlder: false,
    };
    const root: Root = createRoot(installMinimalDom());

    await act(async () => {
      root.render(
        createElement(
          CodezIntlProvider,
          { initialLocale: "zh-CN" },
          createElement(SessionPaneWithTabStore, {
            paneId: "workspace-main",
            sessionId: "session-1",
            workspacePath: "/workspace",
          }),
        ),
      );
      await flushMicrotasks();
    });

    await beginEditAndSend({ rowId: 42, entityId: "message-user-42" }, "保留正文", []);

    expect(sendCommandMock.mock.calls[0]?.[0]).toMatchObject({
      payload: {
        attachments: [],
        newText: "保留正文",
        target: { rowId: 42, entityId: "message-user-42" },
      },
      type: "editUserQuery",
    });

    await act(async () => root.unmount());
  });

  it("keeps accepted legacy fork-disposition edit ACK on the current session", async () => {
    armComposerSubmission();
    projectionState.current = {
      status: "live",
      snapshot: makeSnapshot([editableUserRow()]),
      subscriptionId: "sub-1",
      lastError: null,
      optimisticCommands: [],
      loadingOlder: false,
    };
    sendCommandMock.mockImplementationOnce(async (envelope: CommandEnvelope) => ({
      commandId: envelope.commandId,
      revisionAtDecision: 7,
      status: "accepted",
      result: {
        type: "editUserQuery",
        disposition: "fork",
        sessionId: "session-child",
      },
    }));
    const onSessionCreated = vi.fn();
    const root: Root = createRoot(installMinimalDom());
    await act(async () => {
      root.render(
        createElement(
          CodezIntlProvider,
          { initialLocale: "zh-CN" },
          createElement(SessionPaneWithTabStore, {
            paneId: "workspace-main",
            sessionId: "session-1",
            workspacePath: "/workspace",
            onSessionCreated,
          }),
        ),
      );
      await flushMicrotasks();
    });

    await beginEditAndSend({ rowId: 42, entityId: "message-user-42" }, "edited child text");

    // 编辑 ACK 即使带 fork disposition 与 sessionId 也不导航：导航只属于 forkAssistant ACK。
    expect(sendCommandMock).toHaveBeenCalledOnce();
    expect(sendCommandMock.mock.calls[0]?.[0]).toMatchObject({ type: "editUserQuery" });
    expect(onSessionCreated).not.toHaveBeenCalled();
    await act(async () => root.unmount());
  });

  it("duplicate fork ACK 导航既有 child，edit 与失败 ACK 即使带 result 也不导航", async () => {
    armComposerSubmission();
    projectionState.current = {
      status: "live",
      snapshot: makeSnapshot([editableUserRow(42, "message-target-42")]),
      subscriptionId: "sub-1",
      lastError: null,
      optimisticCommands: [],
      loadingOlder: false,
    };
    const ack = (
      status: CommandAck["status"],
      type: "forkAssistant" | "editUserQuery",
      sessionId: string,
    ): CommandAck => ({
      commandId: `cmd-${status}-${type}`,
      revisionAtDecision: 7,
      status,
      result:
        type === "forkAssistant" ? { type, sessionId } : { type, disposition: "fork", sessionId },
    });
    sendCommandMock
      .mockResolvedValueOnce(ack("duplicate", "editUserQuery", "session-edit-existing"))
      .mockResolvedValueOnce(ack("duplicate", "forkAssistant", "session-fork-existing"))
      .mockResolvedValueOnce(ack("failed", "editUserQuery", "session-failed"))
      .mockResolvedValueOnce(ack("rejected", "editUserQuery", "session-rejected"))
      .mockResolvedValueOnce(ack("stale", "editUserQuery", "session-stale"));
    const onSessionCreated = vi.fn();
    const root: Root = createRoot(installMinimalDom());
    await act(async () => {
      root.render(
        createElement(
          CodezIntlProvider,
          { initialLocale: "zh-CN" },
          createElement(SessionPaneWithTabStore, {
            paneId: "workspace-main",
            sessionId: "session-1",
            workspacePath: "/workspace",
            onSessionCreated,
          }),
        ),
      );
      await flushMicrotasks();
    });
    const target = { rowId: 42, entityId: "message-target-42" };
    await act(async () => {
      await timelineProps.at(-1)?.onEdit?.(target);
      await composerProps.at(-1)?.onSendText?.("duplicate edit", { attachments: [], conversationQuotes: [] });
      timelineProps.at(-1)?.onFork?.(target);
      await flushMicrotasks();
      await timelineProps.at(-1)?.onEdit?.(target);
      await composerProps.at(-1)?.onSendText?.("failed edit", { attachments: [], conversationQuotes: [] });
      await timelineProps.at(-1)?.onEdit?.(target);
      await composerProps.at(-1)?.onSendText?.("rejected edit", { attachments: [], conversationQuotes: [] });
      await timelineProps.at(-1)?.onEdit?.(target);
      await composerProps.at(-1)?.onSendText?.("stale edit", { attachments: [], conversationQuotes: [] });
      await flushMicrotasks();
      // handleFork 是 void dispatchCommand(...).then(...)，dispatchCommand 内部有多次 await
      // （lease 获取、ACK 后处理），两轮微任务不足以让 fork 的 then 落地；补一次宏任务排空。
      await new Promise((resolve) => setTimeout(resolve, 0));
      await flushMicrotasks();
    });

    expect(onSessionCreated.mock.calls).toEqual([["session-fork-existing"]]);
    await act(async () => root.unmount());
  });

  it("does not expose task rename or delete actions in conversation pane chrome", async () => {
    projectionState.current = {
      status: "live",
      snapshot: makeSnapshot(),
      subscriptionId: "sub-1",
      lastError: null,
      optimisticCommands: [],
      loadingOlder: false,
    };
    const root: Root = createRoot(installMinimalDom());

    await act(async () => {
      root.render(
        createElement(
          CodezIntlProvider,
          { initialLocale: "zh-CN" },
          createElement(SessionPaneWithTabStore, {
            paneId: "workspace-main",
            sessionId: "session-1",
            workspacePath: "/workspace",
          }),
        ),
      );
      await flushMicrotasks();
    });

    expect(headerProps.at(-1)?.onRename).toBeUndefined();
    expect(headerProps.at(-1)?.onDelete).toBeUndefined();

    await act(async () => {
      root.unmount();
    });
  });
});
