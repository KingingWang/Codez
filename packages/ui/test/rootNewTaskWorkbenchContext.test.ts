// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { CODEZ_AGENT_PROVIDER, type IPlatformService } from "@codez/shared";
import type { IProjectService, VirtualProject } from "@codez/services";
import {
  readV4ComposerDraft,
  readComposerWorkspaceScope,
  rememberComposerWorkspaceScope,
  resolveComposerScope,
} from "@/v4/composer/composerDraftStore.js";
import { selectRemoteWorkspaceProjectFromDialog } from "@/root/useRemoteWorkspaceHistory.js";
import * as toastModule from "@/components/ui/toast.js";
import type { CreateTaskOptions } from "@/app-shell/types.js";
import { useRootWorkspaceActions } from "@/root/useRootWorkspaceActions.js";
import { useCodezSessionStore } from "@/store/codezSessionStore.js";
import { onTaskNavigationCommitted } from "@/store/codezSessionStoreNavigation.js";
import {
  INITIAL_PANE_LAYOUT,
  V4_PRIMARY_PANE_ID,
  countPanes,
  usePaneLayoutStore,
} from "@/v4/paneLayoutStore.js";
import { useWorkbenchGroupStore } from "@/v4/workbenchGroupStore.js";

function projectFixture(id: string, roots: readonly string[] = []): VirtualProject {
  return {
    id,
    hostId: "local",
    name: "Fixture project",
    nameOverridden: false,
    roots: roots.map((rootPath, position) => ({
      rootPath,
      position,
      isPrimary: position === 0,
    })),
    position: 0,
    pinned: false,
    deleted: false,
    createdAt: 1,
    updatedAt: 1,
  };
}

function fixture(
  clientMode: "desktop-continuous" | "web-remote-replayable" = "desktop-continuous",
  openRemoteProjectWorkspace?: (target: {
    workspacePath: string;
    workspaceIdentity?: string;
    hostId: string;
  }) => Promise<void>,
  openMobileProjectDraft?: (request: CreateTaskOptions) => Promise<void>,
  isDesktop = false,
) {
  let next = 0;
  const prepared = new Map<string, string>();
  const prepareSession = vi.fn(
    async (input?: {
      projectId?: string;
      draftId?: string;
      reuseDraft?: boolean;
      hostId?: string;
    }) => {
      const path = input?.projectId
        ? "/project-primary"
        : (input?.draftId && prepared.get(input.draftId)) || `/managed/${++next}`;
      if (input?.draftId) prepared.set(input.draftId, path);
      return {
        workspacePath: path,
        projectId: input?.projectId ?? null,
        additionalDirectories: [],
      };
    },
  );
  const readTree = vi.fn(async (_input?: unknown) => ({
    tasks: [] as {
      taskId: string;
      workspacePath: string;
      workspaceIdentity?: string;
      projectId: string | null;
    }[],
  }));
  const saveProject = vi.fn<IProjectService["saveProject"]>(async (input) =>
    projectFixture("opened-project", input.roots ?? []),
  );
  const readProjects = vi.fn<IProjectService["readProjects"]>(async () => []);
  const activateOrSetWorkspace = vi.fn<IPlatformService["activateOrSetWorkspace"]>(async () => ({
    activated: false,
  }));
  const addTab = vi.fn();
  const state = {
    tabs: [],
    activeWorkspacePath: "/old",
    activeWorkspaceIdentity: null,
    activateTabByPath: vi.fn(() => true),
  };
  const options = {
    intl: { formatMessage: ({ id }: { id: string }) => id } as never,
    platform: { activateOrSetWorkspace } as never,
    services: { projectService: { prepareSession, readTree, saveProject, readProjects } } as never,
    tabStoreApi: { getState: () => state } as never,
    addTab,
    activeWorkspacePath: "/old",
    activeWorkspaceIdentity: null,
    supportsSettings: true,
    isDesktop,
    allowOpenWorkspace: true,
    preferDirectoryBrowser: false,
    refreshProviderState: vi.fn(),
    updateAppSettings: vi.fn(),
    setOAuthError: vi.fn(),
    setUser: vi.fn(),
    workbenchGroupClientMode: clientMode,
    openMobileProjectDraft,
  };
  const { result, rerender } = renderHook(
    ({ opener }) => useRootWorkspaceActions({ ...options, openRemoteProjectWorkspace: opener }),
    { initialProps: { opener: openRemoteProjectWorkspace } },
  );
  return {
    result,
    rerender,
    prepareSession,
    readTree,
    readProjects,
    saveProject,
    activateOrSetWorkspace,
    addTab,
    state,
  };
}
beforeEach(() => {
  localStorage.clear();
  useCodezSessionStore.setState({ workspaces: {} });
  usePaneLayoutStore.setState(INITIAL_PANE_LAYOUT);
  useWorkbenchGroupStore.getState().resetWorkbenchGroups();
});
describe("Root local project open compatibility", () => {
  it.each([
    [undefined, true],
    [true, true],
    [false, false],
    [{ activateOtherWindow: false }, false],
    [{ throwOnError: true }, true],
    [{ activateOtherWindow: false, throwOnError: true }, false],
  ] as const)("保留打开选项 %j 的窗口激活与项目归属", async (options, shouldActivate) => {
    const path = "/worktree-open";
    const { result, saveProject, activateOrSetWorkspace, addTab } = fixture(
      "desktop-continuous",
      undefined,
      undefined,
      true,
    );
    await act(async () => {
      await result.current.handleSelectProject(path, options);
    });
    expect(saveProject).toHaveBeenCalledOnce();
    expect(saveProject).toHaveBeenCalledWith({ roots: [path], reuseExistingRoot: true });
    expect(activateOrSetWorkspace).toHaveBeenCalledTimes(shouldActivate ? 1 : 0);
    if (shouldActivate) expect(activateOrSetWorkspace).toHaveBeenCalledWith(path);
    expect(addTab).toHaveBeenCalledOnce();
    expect(addTab).toHaveBeenCalledWith(path);
    expect(useCodezSessionStore.getState().getWorkspaceState(path).draftProjectId).toBe(
      "opened-project",
    );
    expect(result.current.workspaceActionError).toBeNull();
  });

  it("其他窗口已接管时保留项目接纳，不提交本窗口 tab/草稿", async () => {
    const path = "/already-open";
    const { result, saveProject, activateOrSetWorkspace, addTab } = fixture(
      "desktop-continuous",
      undefined,
      undefined,
      true,
    );
    activateOrSetWorkspace.mockResolvedValueOnce({ activated: true });
    await act(async () => {
      await result.current.handleSelectProject(path);
    });
    expect(saveProject).toHaveBeenCalledWith({ roots: [path], reuseExistingRoot: true });
    expect(activateOrSetWorkspace).toHaveBeenCalledWith(path);
    expect(addTab).not.toHaveBeenCalled();
    expect(useCodezSessionStore.getState().workspaces[path]).toBeUndefined();
  });

  it.each(["project", "activation"] as const)(
    "%s 失败向 throwOnError 调用者传播原错误，不提交 tab/草稿",
    async (failureAt) => {
      const error = new Error(`${failureAt} open failed`);
      const { result, saveProject, activateOrSetWorkspace, addTab } = fixture(
        "desktop-continuous",
        undefined,
        undefined,
        true,
      );
      if (failureAt === "project") saveProject.mockRejectedValueOnce(error);
      else activateOrSetWorkspace.mockRejectedValueOnce(error);
      await act(async () => {
        await expect(
          result.current.handleSelectProject("/failed-open", { throwOnError: true }),
        ).rejects.toBe(error);
      });
      expect(addTab).not.toHaveBeenCalled();
      expect(result.current.workspaceActionError).toBe(error.message);
    },
  );

  it("默认目录入口仍只记录 Root 错误，不抛给未请求异常的调用者", async () => {
    const error = new Error("ordinary open failed");
    const { result, activateOrSetWorkspace, addTab } = fixture();
    activateOrSetWorkspace.mockRejectedValueOnce(error);
    await act(async () => {
      await expect(result.current.handleSelectProject("/ordinary-open")).resolves.toBeUndefined();
    });
    expect(result.current.workspaceActionError).toBe(error.message);
    expect(addTab).not.toHaveBeenCalled();
  });

  it("迟到失败仍通知原 Worktree 调用者，但不覆盖新导航错误", async () => {
    const previousError = new Error("previous open failed");
    const currentError = new Error("current open failed");
    const { result, activateOrSetWorkspace, addTab } = fixture();
    let rejectPrevious: ((reason: Error) => void) | undefined;
    activateOrSetWorkspace
      .mockImplementationOnce(
        () =>
          new Promise<{ activated: boolean }>((_resolve, reject) => {
            rejectPrevious = reject;
          }),
      )
      .mockRejectedValueOnce(currentError);
    await act(async () => {
      const previous = result.current.handleSelectProject("/previous-open", {
        throwOnError: true,
      });
      await result.current.handleSelectProject("/current-open");
      if (!rejectPrevious) throw new Error("previous platform open was not started");
      rejectPrevious(previousError);
      await expect(previous).rejects.toBe(previousError);
    });
    expect(result.current.workspaceActionError).toBe(currentError.message);
    expect(addTab).not.toHaveBeenCalled();
  });
});
it.each([null, "other-project", "retained-project"])(
  "恢复原项目时显式初始化草稿归属，不沿用缓存 %s",
  async (cachedProjectId) => {
    const path = "/srv/project";
    const identity = "remote:server:source-1:/srv/project";
    const projectId = "retained-project";
    if (cachedProjectId)
      rememberComposerWorkspaceScope(
        path,
        identity,
        resolveComposerScope(cachedProjectId, identity),
      );
    const { result } = fixture();
    const activation = vi.fn(
      (target: { workspacePath: string; workspaceIdentity: string; projectId?: string | null }) =>
        result.current.startDraftInWorkspace(target.workspacePath, target.workspaceIdentity, {
          projectId: target.projectId,
        }),
    );
    await act(async () => {
      await selectRemoteWorkspaceProjectFromDialog({
        canUseRemoteWorkspace: true,
        sessionId: "session-1",
        path,
        preparedWorkspaceIdentity: identity,
        draftProjectId: projectId,
        restoringWorkspaceTabId: "tab",
        loadingMessage: "loading",
        getRemoteWorkspaceSession: () =>
          ({
            sessionId: "session-1",
            target: { kind: "ssh", host: "dev.example.com", username: "dev" },
          }) as never,
        getWorkspaceTabs: () => [
          {
            id: "tab",
            kind: "workspace",
            label: "project",
            workspacePath: path,
            workspaceIdentity: identity,
            remoteSessionId: "session-1",
          },
        ],
        resolveRemoteWorkspaceCanonicalPath: async () => path,
        activateTabByPath: () => true,
        handleCancelRemoteProject: vi.fn(),
        bindRemoteWorkspaceScope: async () => ({
          workspacePath: path,
          workspaceIdentity: identity,
        }),
        commitRemoteWorkspaceSessionMutation: async (mutation) => mutation.entry,
        getRemoteSessions: () => [],
        bindRemoteWorkspacePath: vi.fn(),
        bindRemoteWorkspaceIdentity: vi.fn(),
        addTab: vi.fn(),
        onWorkspaceActivated: activation,
      });
    });
    expect(activation).toHaveBeenCalledOnce();
    expect(activation).toHaveBeenCalledWith({
      workspacePath: path,
      workspaceIdentity: identity,
      projectId,
    });
    expect(useCodezSessionStore.getState().getWorkspaceState(path, identity).draftProjectId).toBe(
      projectId,
    );
    expect(readComposerWorkspaceScope(path, identity)?.projectId).toBe(projectId);
  },
);
describe("project-aware new task creation", () => {
  it("keeps new-task callbacks stable while using the latest committed remote opener", async () => {
    const previous = vi.fn(async () => {});
    const latest = vi.fn(async () => {});
    const { result, rerender, prepareSession } = fixture("desktop-continuous", previous);
    const create = result.current.handleCreateTask;
    const createConversation = result.current.handleCreateConversationTask;
    rerender({ opener: latest });
    expect(result.current.handleCreateTask).toBe(create);
    expect(result.current.handleCreateConversationTask).toBe(createConversation);
    prepareSession.mockResolvedValueOnce({
      workspacePath: "/remote",
      workspaceIdentity: "remote:server:s:/remote",
      projectId: "p",
      additionalDirectories: [],
    } as never);
    await act(async () => create({ projectId: "p", hostId: "remote:server:s" }));
    expect(previous).not.toHaveBeenCalled();
    expect(latest).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceIdentity: "remote:server:s:/remote", projectId: "p" }),
    );
  });
  it.each([true, false])(
    "publishes a settings return only after tab activation succeeds (%s)",
    (activated) => {
      useCodezSessionStore.getState().setActiveTaskId("/old", "old-session");
      const { result, state } = fixture();
      state.activateTabByPath.mockReturnValue(activated);
      const history = useCodezSessionStore.getState().taskNavHistory;
      const viewed = vi.fn();
      const subscription = onTaskNavigationCommitted(viewed);
      try {
        act(() => result.current.handleBackFromSettings());
        expect(viewed).toHaveBeenCalledTimes(activated ? 1 : 0);
        if (activated)
          expect(viewed).toHaveBeenCalledWith({
            kind: "task",
            workspacePath: "/old",
            taskId: "old-session",
            workspaceIdentity: undefined,
          });
        expect(useCodezSessionStore.getState().taskNavHistory).toBe(history);
      } finally {
        subscription.dispose();
      }
    },
  );
  it("routes the selected Host and binds its attachment before creating a draft under the returned identity", async () => {
    const open = vi.fn(async () => {});
    const { result, prepareSession, addTab } = fixture("desktop-continuous", open);
    prepareSession.mockResolvedValueOnce({
      workspacePath: "/remote",
      workspaceIdentity: "remote:server:s:/remote",
      projectId: "p",
      additionalDirectories: [],
    } as never);
    await act(async () => {
      await result.current.handleCreateTask({ projectId: "p", hostId: "remote:server:s" });
    });
    expect(prepareSession).toHaveBeenCalledWith({ projectId: "p", hostId: "remote:server:s" });
    expect(open).toHaveBeenCalledWith(
      expect.objectContaining({
        hostId: "remote:server:s",
        workspacePath: "/remote",
        workspaceIdentity: "remote:server:s:/remote",
      }),
    );
    expect(addTab).not.toHaveBeenCalled();
    expect(
      useCodezSessionStore.getState().getWorkspaceState("/remote", "remote:server:s:/remote")
        .draftProjectId,
    ).toBe("p");
    expect(useCodezSessionStore.getState().workspaces["/remote"]).toBeUndefined();
  });
  it.each(["desktop-continuous"] as const)(
    "PD01 连续新建复用未发送目录，显式 local Host 也保持同一身份（%s）",
    async (mode) => {
      useCodezSessionStore.getState().setActiveTaskId("/old", "old-session");
      const { result, prepareSession, addTab } = fixture(mode);
      await act(async () => {
        await result.current.handleCreateTask({ projectId: null, hostId: "local" });
        await result.current.handleCreateTask({ projectId: null, hostId: "local" });
      });
      expect(prepareSession).toHaveBeenCalledTimes(2);
      expect(addTab).toHaveBeenNthCalledWith(1, "/managed/1", { workspacePurpose: "conversation" });
      expect(addTab).toHaveBeenNthCalledWith(2, "/managed/1", { workspacePurpose: "conversation" });
      expect(
        useCodezSessionStore.getState().getWorkspaceState("/managed/1").draftProjectId,
      ).toBeNull();
      expect(useCodezSessionStore.getState().getWorkspaceState("/old").activeTaskId).toBe(
        "old-session",
      );
    },
  );
  it("uses the selected project primary directory, exits split view and preserves mention spacing", async () => {
    const { result, prepareSession } = fixture();
    usePaneLayoutStore.getState().splitPaneWithBinding(V4_PRIMARY_PANE_ID, "right", {
      workspaceScope: { workspacePath: "/unrelated" },
      sessionId: "another",
    });
    const mention = {
      id: "skill:creator",
      category: "skills" as const,
      label: "creator",
      value: "creator",
      markdown: "$creator",
    };
    await act(async () => {
      await result.current.handleCreateTask({
        projectId: "project-a",
        initialPrompt: "$creator ",
        initialPromptMention: mention,
      });
    });
    expect(prepareSession).toHaveBeenCalledWith({ projectId: "project-a" });
    const draft = useCodezSessionStore.getState().getWorkspaceState("/project-primary");
    expect(draft.draftProjectId).toBe("project-a");
    expect(draft.composerTextInsertRequest).toMatchObject({ text: "$creator ", mention });
    expect(countPanes(usePaneLayoutStore.getState())).toBe(1);
    expect(useWorkbenchGroupStore.getState().activeGroupId).toBeNull();
  });
  it("leaves the current session intact when directory preparation fails", async () => {
    useCodezSessionStore.getState().setActiveTaskId("/old", "old-session");
    const toastSpy = vi.spyOn(toastModule, "toast");
    const { result, prepareSession, addTab } = fixture();
    prepareSession.mockRejectedValueOnce(new Error("directory unavailable"));
    await act(async () => {
      await result.current.handleCreateTask();
    });
    expect(addTab).not.toHaveBeenCalled();
    expect(useCodezSessionStore.getState().getWorkspaceState("/old").activeTaskId).toBe(
      "old-session",
    );
    expect(result.current.workspaceActionError).toContain("directory unavailable");
    expect(toastSpy).toHaveBeenCalledWith(expect.stringContaining("directory unavailable"));
    toastSpy.mockRestore();
  });
});

it("hands mobile project intent to the bridge owner without preparing or mutating the old Root", async () => {
  let finish!: () => void;
  const openMobileProjectDraft = vi.fn(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  );
  const { result, prepareSession, addTab } = fixture(
    "web-remote-replayable",
    undefined,
    openMobileProjectDraft,
  );
  useCodezSessionStore.getState().setActiveTaskId("/old", "old-session");
  const request = { projectId: "p", hostId: "remote:server:s", initialPrompt: "$creator " };
  let pending!: Promise<void>;
  await act(async () => {
    pending = result.current.handleCreateTask(request);
  });
  expect(openMobileProjectDraft).toHaveBeenCalledWith(request);
  expect(prepareSession).not.toHaveBeenCalled();
  useCodezSessionStore
    .getState()
    .startDraft("/new", undefined, "remote:server:s:/new", { projectId: "p" });
  await act(async () => {
    finish();
    await pending;
  });
  expect(addTab).not.toHaveBeenCalled();
  expect(useCodezSessionStore.getState().getWorkspaceState("/old").activeTaskId).toBe(
    "old-session",
  );
  expect(
    useCodezSessionStore.getState().getWorkspaceState("/new", "remote:server:s:/new")
      .draftProjectId,
  ).toBe("p");
});
it("initializes a handed off draft with its project and exact input under the new identity", () => {
  const { result } = fixture("web-remote-replayable");
  const mention = {
    id: "skill:creator",
    category: "skills" as const,
    label: "creator",
    value: "creator",
    markdown: "$creator",
  };
  act(() =>
    result.current.startDraftInWorkspace("/new", "remote:server:s:/new", {
      projectId: "p",
      // 上游 provider wire 使用引擎常量，产品名不是可提交的 provider 标识。
      provider: CODEZ_AGENT_PROVIDER,
      initialPrompt: "$creator ",
      initialPromptMention: mention,
    }),
  );
  const draft = useCodezSessionStore.getState().getWorkspaceState("/new", "remote:server:s:/new");
  expect(draft.draftProjectId).toBe("p");
  expect(draft.composerTextInsertRequest).toMatchObject({ text: "$creator ", mention });
  expect(useCodezSessionStore.getState().workspaces["/new"]).toBeUndefined();
});

it("does not allocate a directory when the mobile peer lacks project admission", async () => {
  const { result, prepareSession, addTab } = fixture("web-remote-replayable");
  await act(async () => {
    await result.current.handleCreateTask();
  });
  expect(prepareSession).not.toHaveBeenCalled();
  expect(addTab).not.toHaveBeenCalled();
  expect(result.current.workspaceActionError).toBe("project.remote-navigation-unavailable");
});

it.each(["desktop-continuous", "web-remote-replayable"] as const)(
  "TD07 %s 空白创建意图只留在内存，文字出现时才保存项目和分组",
  (mode) => {
    const { result } = fixture(mode);
    act(() =>
      result.current.startDraftInWorkspace("/metadata", "remote:server:s:/metadata", {
        projectId: "p",
        taskGroupId: "g",
      }),
    );
    expect(
      useCodezSessionStore.getState().getWorkspaceState("/metadata", "remote:server:s:/metadata"),
    ).toMatchObject({ draftProjectId: "p", draftTaskGroupId: "g" });
    expect(
      readV4ComposerDraft("/metadata", "remote:server:s:/metadata", "__draft__", {
        clientNamespace: "desktop",
        hostId: "remote:server:s",
        projectId: "p",
      }),
    ).toBeNull();
    act(() =>
      result.current.startDraftInWorkspace("/metadata", "remote:server:s:/metadata", {
        projectId: "p",
        taskGroupId: "g",
        initialPrompt: "draft",
      }),
    );
    expect(
      readV4ComposerDraft("/metadata", "remote:server:s:/metadata", "__draft__", {
        clientNamespace: "desktop",
        hostId: "remote:server:s",
        projectId: "p",
      }),
    ).toMatchObject({ text: "draft", projectId: "p", taskGroupId: "g" });
  },
);

it.each(["desktop-continuous", "web-remote-replayable"] as const)(
  "D3 %s inherits the current session project by exact task identity",
  async (mode) => {
    useCodezSessionStore.getState().setActiveTaskId("/old", "session");
    const open = vi.fn(async () => {});
    const { result, prepareSession, readTree, readProjects } = fixture(mode, undefined, open);
    readProjects.mockResolvedValueOnce([projectFixture("current", ["/old"])]);
    readTree.mockResolvedValueOnce({
      tasks: [
        { taskId: "session", workspacePath: "/other", projectId: "wrong" },
        { taskId: "session", workspacePath: "/old", projectId: "current" },
      ],
    });
    await act(async () => {
      await result.current.handleCreateTask();
    });
    if (mode === "desktop-continuous") {
      expect(prepareSession).toHaveBeenCalledWith({ projectId: "current" });
    } else {
      expect(open).toHaveBeenCalledWith({ projectId: "current" });
      expect(prepareSession).not.toHaveBeenCalled();
    }
  },
);

it("D3 inherits draft project without reading task history; explicit null opts out", async () => {
  useCodezSessionStore
    .getState()
    .startDraft("/old", undefined, undefined, { projectId: "draft-project" });
  const { result, prepareSession, readTree, readProjects } = fixture();
  readProjects.mockResolvedValueOnce([projectFixture("draft-project", ["/old"])]);
  await act(async () => {
    await result.current.handleCreateTask();
  });
  expect(prepareSession).toHaveBeenLastCalledWith({ projectId: "draft-project" });
  expect(readTree).not.toHaveBeenCalled();
  await act(async () => {
    await result.current.handleCreateTask({ projectId: null });
  });
  expect(prepareSession).toHaveBeenLastCalledWith({
    draftId: expect.any(String),
    reuseDraft: false,
  });
});

it("D3 discards project lookup after the user selects another session", async () => {
  useCodezSessionStore.getState().setActiveTaskId("/old", "session");
  const { result, prepareSession, readTree, addTab } = fixture();
  let finish!: (tree: Awaited<ReturnType<typeof readTree>>) => void;
  readTree.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  let pending!: Promise<void>;
  await act(async () => {
    pending = result.current.handleCreateTask();
  });
  act(() => useCodezSessionStore.getState().setActiveTaskId("/old", "other"));
  await act(async () => {
    finish({ tasks: [{ taskId: "session", workspacePath: "/old", projectId: "current" }] });
    await pending;
  });
  expect(prepareSession).not.toHaveBeenCalled();
  expect(addTab).not.toHaveBeenCalled();
});
