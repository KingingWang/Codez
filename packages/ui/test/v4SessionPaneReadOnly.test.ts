// @vitest-environment jsdom
import { createElement, type ReactNode } from "react";
import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ConversationSnapshot } from "@codez/shared/codez-protocol-v4";
import { CodezIntlProvider } from "@/i18n/IntlProvider.js";
import { SessionPane } from "@/v4/SessionPane.js";
import type { ConversationShareSelectionDraft } from "@/store/conversationShareSelectionStore.js";
import type { ConversationRowRenderContext } from "@/v4/conversationRowContext.js";

const sessionPaneSource = readFileSync("packages/ui/src/v4/SessionPane.tsx", "utf8");

const projectionState = vi.hoisted(() => ({
  current: null as {
    status: "live" | "error";
    snapshot: ConversationSnapshot;
    subscriptionId: string;
    lastError: string | null;
    optimisticCommands: readonly [];
    loadingOlder: boolean;
  } | null,
}));

const timelineState = vi.hoisted(() => ({
  apiRetry: null as ConversationSnapshot["control"]["apiRetry"],
  rowContext: null as unknown,
  backgroundScrollLocked: false,
  selectionActionsEnabled: null as boolean | null,
  scrollToQueryActionRef: null as { current: unknown } | null,
  onFork: undefined as unknown,
  onRetry: undefined as unknown,
  onEdit: undefined as unknown,
}));

// SSR 渲染不执行 effect，因此 zustand 的 getServerSnapshot（= 初始 state）看不到真实 store
// 的写入。这里直接替换 store，让测试能声明式地摆出任意 share draft。
const shareStoreState = vi.hoisted(() => ({
  draft: undefined as unknown,
}));

const leaseStoreMocks = vi.hoisted(() => ({
  retry: vi.fn(async () => {}),
  refreshPlans: vi.fn(async () => {}),
  onOnlineModelTransition: vi.fn(() => () => {}),
  release: vi.fn(),
  lease: {
    release: () => leaseStoreMocks.release(),
    store: {
      retry: () => leaseStoreMocks.retry(),
      refreshPlans: () => leaseStoreMocks.refreshPlans(),
      onOnlineModelTransition: (handler: unknown) =>
        (leaseStoreMocks.onOnlineModelTransition as (h: unknown) => () => void)(handler),
    },
  },
  layer: {
    acquire: vi.fn(() => leaseStoreMocks.lease),
    refreshWriterConflict: vi.fn(async () => {}),
  },
}));

const workflowRunsQueryMock = vi.hoisted(() =>
  vi.fn(() => new Promise<{ runs: unknown[] }>(() => {})),
);

const servicesMock = vi.hoisted(() => ({
  highspeedCardService: {
    getSnapshot: vi.fn(() => new Promise(() => {})),
    prepareTurn: vi.fn(async () => ({
      kind: "fallback" as const,
      reason: "draw-miss" as const,
      nextDrawAt: null,
    })),
    healthy: vi.fn(),
    share: vi.fn(),
  },
  codezSessionService: {
    updateProviderRegistry: vi.fn(),
  },
  codezTaskService: {
    restartWorkspaceProcess: vi.fn(),
  },
}));

vi.mock("@/v4/BotGroupDeliveryAction.js", () => ({
  BotGroupDeliveryProvider: ({ children }: { children: unknown }) => children,
  ConnectedBotGroupDeliveryAction: () => null,
}));

vi.mock("@/store/conversationShareSelectionStore.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/store/conversationShareSelectionStore.js")>();
  const fakeState = () => ({
    drafts: shareStoreState.draft ? { "child-session": shareStoreState.draft } : {},
    // ac4bc6e79c 起 SessionPane 从 dockStates[sessionId] 读取发布中 dock 状态，
    // mock 缺这个字段会让 SSR selector 读 undefined[sessionId] 直接抛错。
    dockStates: {},
    closeShare: vi.fn(),
    confirmSelectionEdit: vi.fn(),
    beginSelectionEdit: vi.fn(),
    cancelSelectionEdit: vi.fn(),
    togglePendingRow: vi.fn(),
    setAllPendingRowsSelected: vi.fn(),
    deselectProductTurn: vi.fn(),
    updateDockState: vi.fn(),
    setAccessMode: vi.fn(),
    syncAvailableTurns: vi.fn(),
  });
  // 只替换 hook 与 getState；派生 selector 保留真实实现，避免测试自证。
  const hook = (selector: (state: unknown) => unknown) => selector(fakeState());
  return {
    ...actual,
    useConversationShareSelectionStore: Object.assign(hook, { getState: fakeState }),
  };
});

vi.mock("@/v4/useConversationProjection.js", () => ({
  useConversationProjection: () => projectionState.current,
}));

vi.mock("@/v4/V4ConversationContext.js", () => ({
  useV4Conversation: () => ({
    attachmentPut: vi.fn(),
    layer: leaseStoreMocks.layer,
    sendCommand: vi.fn(),
    workflowRuns: workflowRunsQueryMock,
  }),
}));

vi.mock("@/store/StoreProvider.js", () => ({
  useCodezStoreWithDefault: (_selector: unknown, fallback: unknown) => fallback,
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

// 此夹具验证 legacy pane；原生目录有独立回归，不依赖这里未挂载的 TabStore。
vi.mock("@/hooks/useCodexModelCatalog.js", () => ({
  useCodexModelCatalog: () => ({ status: "unavailable", reload: vi.fn(), readCurrent: vi.fn() }),
}));
vi.mock("@/hooks/useServices.js", () => ({
  useComposerClientNamespace: () => "desktop",
  useOptionalServices: () => null,
  useServices: () => servicesMock,
}));

vi.mock("@/v4/composer/useDraftConfigControl.js", () => ({
  buildDraftCreateConfigPayload: () => ({}),
  useDraftConfigControl: () => ({
    modelSelectionRead: { state: { status: "loading" }, reload: vi.fn() },
    captureAcceptedModelSelection: () => vi.fn(),
    draftConfigRef: { current: {} },
    handleDraftSelectModel: vi.fn(),
    handleDraftSelectThought: vi.fn(),
    handleDraftSwitchMode: vi.fn(),
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
    ConversationComposer: () =>
      React.createElement("div", { "data-testid": "mock-composer" }, "composer"),
  };
});

vi.mock("@/v4/ConversationTimeline.js", async () => {
  const React = await import("react");
  return {
    ConversationTimeline: ({
      apiRetry,
      backgroundScrollLocked,
      bottomDock,
      rowContext,
      selectionActions,
      scrollToQueryActionRef,
      onFork,
      onRetry,
      onEdit,
    }: {
      apiRetry?: ConversationSnapshot["control"]["apiRetry"];
      backgroundScrollLocked?: boolean;
      bottomDock?: ReactNode;
      rowContext?: ConversationRowRenderContext;
      selectionActions?: { enabled: boolean };
      scrollToQueryActionRef?: { current: unknown };
      onFork?: unknown;
      onRetry?: unknown;
      onEdit?: unknown;
    }) => {
      timelineState.apiRetry = apiRetry ?? null;
      timelineState.rowContext = rowContext ?? null;
      timelineState.backgroundScrollLocked = backgroundScrollLocked ?? false;
      timelineState.selectionActionsEnabled = selectionActions?.enabled ?? null;
      timelineState.scrollToQueryActionRef = scrollToQueryActionRef ?? null;
      timelineState.onFork = onFork;
      timelineState.onRetry = onRetry;
      timelineState.onEdit = onEdit;
      return React.createElement("div", { "data-testid": "mock-timeline" }, bottomDock);
    },
  };
});

vi.mock("@/v4/ConversationHeader.js", async () => {
  const React = await import("react");
  return {
    ConversationHeader: () => React.createElement("div", { "data-testid": "mock-header" }),
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

function makeSnapshot(
  lastError: ConversationSnapshot["control"]["lastError"] = null,
): ConversationSnapshot {
  return {
    availability: {
      fork: { allowed: true },
      compact: { allowed: true },
      queueEdit: { allowed: true },
      pauseGoal: { allowed: false, reasonCode: "noGoalToPause" },
      resumeGoal: { allowed: false, reasonCode: "noGoalToResume" },
      sendQueuedNow: { allowed: true },
      setFollowupMode: { allowed: true },
      switchModelConfig: { allowed: true },
    },
    backgroundWorks: [],
    config: { followupMode: "queue", model: "", provider: "", thought: "" },
    control: {
      activeWorks: [],
      apiRetry: null,
      canStop: false,
      lastError,
      phase: "completedSuccess",
      sessionEnded: true,
      stopState: "idle",
      stopTargetKind: "unknown",
    },
    goal: null,
    inputRouting: { mode: "startNow" },
    logEpoch: "epoch-1",
    meta: { title: "Subagent", titleSource: "generated" },
    pendingCommands: [],
    pendingInteractions: [],
    plan: null,
    protocolVersion: 1,
    queue: { autoDrain: true, items: [] },
    revision: 1,
    rows: { firstRowId: null, totalCount: 0, window: [] },
    seq: 1,
    sessionId: "child-session",
    usage: {
      contextWindow: null,
      cumulative: {
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        inputTokens: 0,
        outputTokens: 0,
      },
    },
  };
}

function renderReadOnlyPane({
  allowWorkspaceFileRewind = false,
  apiRetry = null,
  lastError = null,
  locale = "zh-CN",
  readOnly = true,
  subscriptionStatus = "live",
  writerConflict,
  workflowRuns,
  sharedContextImport,
}: {
  allowWorkspaceFileRewind?: boolean;
  apiRetry?: ConversationSnapshot["control"]["apiRetry"];
  lastError?: ConversationSnapshot["control"]["lastError"];
  locale?: "zh-CN" | "en-US";
  readOnly?: boolean;
  subscriptionStatus?: "live" | "error";
  writerConflict?: ConversationSnapshot["writerConflict"];
  workflowRuns?: ConversationSnapshot["workflowRuns"];
  sharedContextImport?: ConversationSnapshot["sharedContextImport"];
} = {}): string {
  const snapshot = makeSnapshot(lastError);
  snapshot.control.apiRetry = apiRetry;
  if (writerConflict) snapshot.writerConflict = writerConflict;
  if (workflowRuns) snapshot.workflowRuns = workflowRuns;
  snapshot.sharedContextImport = sharedContextImport;
  projectionState.current = {
    lastError: subscriptionStatus === "error" ? "history refresh failed" : null,
    loadingOlder: false,
    optimisticCommands: [],
    snapshot,
    status: subscriptionStatus,
    subscriptionId: "sub-1",
  };

  return renderToStaticMarkup(
    createElement(
      CodezIntlProvider,
      { initialLocale: locale },
      createElement(SessionPane, {
        allowWorkspaceFileRewind,
        paneId: "pane-1",
        readOnly,
        sessionId: "child-session",
        workspacePath: "/workspace",
        ...(readOnly ? {} : { onOpenWorkflowRun: () => {} }),
      }),
    ),
  );
}

describe("SessionPane read-only mode", () => {
  afterEach(() => {
    cleanup();
    timelineState.apiRetry = null;
    timelineState.rowContext = null;
    timelineState.onFork = undefined;
    timelineState.onRetry = undefined;
    timelineState.onEdit = undefined;
    leaseStoreMocks.retry.mockClear();
    leaseStoreMocks.layer.refreshWriterConflict.mockClear();
  });

  it("renders subagent child panes without composer or queue input affordances", () => {
    const html = renderReadOnlyPane();

    expect(html).toContain('data-testid="mock-timeline"');
    expect(html).not.toContain('data-testid="mock-composer"');
    expect(html).not.toContain('data-testid="mock-queue"');
    expect(timelineState.rowContext).toMatchObject({
      previewFileRewind: undefined,
      applyFileRewind: undefined,
    });
  });

  it("把 child snapshot 的 provider retry 传入只读时间线", () => {
    const apiRetry = {
      attempt: 2,
      maxAttempts: 6,
      nextRetryAt: 1_700_000_001_000,
      reasonCode: "fault.provider.requestFailed",
    };

    const html = renderReadOnlyPane({ apiRetry });

    expect(html).not.toContain('data-testid="mock-composer"');
    expect(timelineState.apiRetry).toEqual(apiRetry);
  });

  it("can expose workspace file rewind without making the child conversation editable", () => {
    const html = renderReadOnlyPane({ allowWorkspaceFileRewind: true });

    expect(html).not.toContain('data-testid="mock-composer"');
    expect(html).not.toContain('data-testid="mock-queue"');
    expect(timelineState.rowContext).toMatchObject({
      previewFileRewind: expect.any(Function),
      applyFileRewind: expect.any(Function),
    });
  });

  it("shows the current child projection error without adding an editable composer", () => {
    const html = renderReadOnlyPane({
      lastError: {
        at: 1_700_000_000_000,
        code: "fault.provider.requestFailed",
        message: "Provider connection failed",
        recoverable: true,
        source: "provider",
      },
    });

    expect(html).toContain('data-testid="v4-subagent-readonly-error"');
    expect(html).toContain("Provider connection failed");
    expect(html).not.toContain('data-testid="mock-composer"');
  });

  // 浮岛已删除（docs/dynamic-workflow/presentation.md「Other places a run appears」item 1）：运行态迁进状态胶囊的
  // Workflows 分区，composer 上方不再有任何 workflow 浮层。原来这里是「只读缺席 / 主对话在场」
  // 两个方向的用例，现在**两个方向都断言无岛**——留一条正向用例才能钉住"删除是全局的"，
  // 只删掉在场那条会让主对话 pane 重新长出浮岛而没人发现。
  const runningWorkflowRuns = {
    revision: 1,
    runs: [
      {
        runId: "dwfrun-1",
        toolCallId: "tool-wf-1",
        status: "running" as const,
        usage: { spentTokens: 0, nodesUsed: 0 },
        actors: [],
        nodes: [],
        lastEventSequence: 1,
      },
    ],
  };

  it("read-only panes never float the workflow run island", () => {
    const html = renderReadOnlyPane({ workflowRuns: runningWorkflowRuns });

    expect(html).not.toContain('data-testid="workflow-run-island"');
  });

  it("primary conversation panes no longer float the workflow run island either", () => {
    const html = renderReadOnlyPane({ readOnly: false, workflowRuns: runningWorkflowRuns });

    expect(html).toContain('data-testid="mock-composer"');
    expect(html).not.toContain('data-testid="workflow-run-island"');
    expect(html).not.toContain("workflow-run-island-pill");
  });

  it("does not show the legacy imported-share notice in read-only panes", () => {
    const html = renderReadOnlyPane({
      sharedContextImport: { title: "筛选近一年收益前10%的偏股混合基金" },
    });

    expect(html).not.toContain('data-testid="conversation-share-import-notice"');
    expect(html).not.toContain("shared_context");
  });

  it("renders writer-conflict read-only banner inside timeline bottomDock instead of top area", () => {
    const html = renderReadOnlyPane({
      readOnly: false,
      writerConflict: { readOnly: true },
    });

    const statusIndex = html.indexOf('data-testid="mock-status"');
    const timelineIndex = html.indexOf('data-testid="mock-timeline"');
    const dockIndex = html.indexOf('data-testid="conversation-bottom-dock-transition"');
    const bannerIndex = html.indexOf('data-testid="v4-writer-conflict-banner"');

    expect(statusIndex).toBeGreaterThanOrEqual(0);
    expect(timelineIndex).toBeGreaterThan(statusIndex);
    expect(dockIndex).toBeGreaterThan(timelineIndex);
    expect(bannerIndex).toBeGreaterThan(dockIndex);
    expect(html).toContain("上次检查");
    expect(html).toContain("只读");
    expect(html).toContain("刷新历史");
    expect(html).not.toContain('data-testid="mock-composer"');
    expect(html).not.toContain('data-testid="mock-queue"');
    expect(html).not.toContain('data-testid="mock-interactions"');
    expect(timelineState.onFork).toEqual(expect.any(Function));
    expect(timelineState.onRetry).toBeUndefined();
    expect(timelineState.onEdit).toBeUndefined();
  });

  it("English writer-conflict copy describes the last check and persisted-history refresh", () => {
    const html = renderReadOnlyPane({
      locale: "en-US",
      readOnly: false,
      writerConflict: { readOnly: true },
    });

    expect(html).toMatch(/last check/i);
    expect(html).toMatch(/read.only/i);
    expect(html).toMatch(/refresh history/i);
  });

  it("冲突刷新失败后仍显示旧时间线与只读门禁，而不是用全屏错误替换历史", () => {
    const html = renderReadOnlyPane({
      readOnly: false,
      subscriptionStatus: "error",
      writerConflict: { readOnly: true },
    });

    expect(html).toContain('data-testid="mock-timeline"');
    expect(html).toContain('data-testid="v4-writer-conflict-banner"');
    expect(html).toContain("刷新失败，仍显示上次读取的历史。");
    expect(html).not.toContain('data-testid="mock-composer"');
  });

  it("refreshes the current conflicted session when clicking the bottom-dock action", () => {
    const snapshot = makeSnapshot(null);
    snapshot.writerConflict = { readOnly: true };
    projectionState.current = {
      lastError: null,
      loadingOlder: false,
      optimisticCommands: [],
      snapshot,
      status: "live",
      subscriptionId: "sub-1",
    };

    render(
      createElement(
        CodezIntlProvider,
        { initialLocale: "zh-CN" },
        createElement(SessionPane, {
          paneId: "pane-1",
          readOnly: false,
          sessionId: "child-session",
          workspacePath: "/workspace",
        }),
      ),
    );

    const banner = screen.getByTestId("v4-writer-conflict-banner");
    expect(banner.closest('[data-testid="mock-timeline"]')).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /刷新历史.*重试/ }));
    expect(leaseStoreMocks.layer.refreshWriterConflict).toHaveBeenCalledExactlyOnceWith(
      "child-session",
    );
    expect(leaseStoreMocks.retry).not.toHaveBeenCalled();
  });
});

/**
 * 这些用例守护 SessionPane 到 timeline 的分享模式接线。
 *
 * 分享浮窗必须保留 Composer 和正文滚动，勾选期仍禁用 message 工具条。
 * 断言必须落在 SessionPane 真正传给 ConversationTimeline 的 props 上。
 */
describe("SessionPane 分享模式接线", () => {
  afterEach(() => {
    timelineState.apiRetry = null;
    timelineState.rowContext = null;
    timelineState.backgroundScrollLocked = false;
    timelineState.selectionActionsEnabled = null;
    timelineState.scrollToQueryActionRef = null;
    shareStoreState.draft = undefined;
  });

  const partialDraft = (
    overrides: Partial<ConversationShareSelectionDraft> = {},
  ): ConversationShareSelectionDraft => ({
    open: true,
    pendingExcludedRowIds: [],
    availableRowIds: [1],
    excludedRowIds: [],
    productTurnIdByRowId: { 1: "product-turn-1" },
    accessMode: "private",
    ...overrides,
  });

  const renderSharePane = (draft?: ConversationShareSelectionDraft): string => {
    shareStoreState.draft = draft;
    projectionState.current = {
      lastError: null,
      loadingOlder: false,
      optimisticCommands: [],
      snapshot: makeSnapshot(null),
      status: "live",
      subscriptionId: "sub-1",
    };
    return renderToStaticMarkup(
      createElement(
        CodezIntlProvider,
        { initialLocale: "zh-CN" },
        createElement(SessionPane, {
          paneId: "pane-1",
          readOnly: false,
          sessionId: "child-session",
          workspacePath: "/workspace",
        }),
      ),
    );
  };

  it("选择面板展开和收起时都保留正文滚动", () => {
    renderSharePane(partialDraft());
    expect(timelineState.backgroundScrollLocked).toBe(false);

    renderSharePane(partialDraft({ pendingExcludedRowIds: null }));
    expect(timelineState.backgroundScrollLocked).toBe(false);
  });

  it("选择面板展开时向 Timeline 传递正文定位 action ref", () => {
    renderSharePane(partialDraft());
    expect(timelineState.scrollToQueryActionRef).not.toBeNull();
  });

  it("分享选择确认 handler 接线到当前 session 的 confirmShareSelection", () => {
    const nextHandlerStart = sessionPaneSource.indexOf(
      "const handleConfirmShareSelection = useCallback",
    );
    const nextHandlerEnd = sessionPaneSource.indexOf(
      "const handleDismissShareError = useCallback",
      nextHandlerStart,
    );
    expect(nextHandlerStart).toBeGreaterThanOrEqual(0);
    expect(nextHandlerEnd).toBeGreaterThan(nextHandlerStart);

    const nextHandler = sessionPaneSource.slice(nextHandlerStart, nextHandlerEnd);
    expect(nextHandler).toContain("confirmShareSelection(sessionId)");
  });

  it("不在分享模式时不锁定背景滚动", () => {
    renderSharePane(undefined);

    expect(timelineState.backgroundScrollLocked).toBe(false);
  });

  it("局部勾选期间禁用全局 message 工具条，退出分享后恢复", () => {
    renderSharePane(partialDraft());
    expect(timelineState.selectionActionsEnabled).toBe(false);

    renderSharePane(undefined);
    expect(timelineState.selectionActionsEnabled).toBe(true);
  });

  it("分享浮窗保持 chat 输入区，不再替换 Composer", () => {
    expect(renderSharePane(undefined)).toContain('data-conversation-bottom-dock-mode="chat"');
    const html = renderSharePane(partialDraft());
    expect(html).toContain('data-conversation-bottom-dock-mode="chat"');
    expect(html).toContain('data-testid="mock-composer"');
    expect(html).not.toContain('data-conversation-bottom-dock-mode="confirmation"');
  });
});
