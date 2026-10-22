// @vitest-environment jsdom
import { createElement } from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CodezTaskChangeSummary } from "@codez/shared";
import type { RemoteProjectHost } from "@/project-sidebar/contract.js";
import {
  TaskHoverCard,
  isPointerOnTaskRowActionTarget,
  resolveTaskHoverCardMeta,
  type TaskHoverCardTask,
} from "@/project-sidebar/TaskHoverCard.js";

const directoryMock = vi.hoisted(() => ({
  deviceNames: new Map<string, string>([["srv-1", "moga22"]]),
  hosts: [
    {
      id: "remote:ssh:dev@10.0.0.8:22",
      membershipId: "m-1",
      kind: "ssh",
      target: { kind: "ssh", host: "10.0.0.8", port: 22, username: "dev" },
      position: 0,
    },
  ] as RemoteProjectHost[],
}));

vi.mock("@/project-sidebar/ProjectDirectoryProvider.js", () => ({
  useOptionalProjectDirectory: () => ({
    deviceNames: directoryMock.deviceNames,
    directory: { hosts: directoryMock.hosts, entries: [] },
  }),
}));

vi.mock("@/i18n/IntlProvider.js", () => ({
  useCodezIntl: () => ({
    intl: {
      formatMessage: ({ id }: { id: string }, values?: Record<string, string>) => {
        const map: Record<string, string> = {
          "taskList.justNow": "刚刚",
          "taskList.minutesAgo": "{minutes}分",
          "taskList.hoursAgo": "{hours}小时",
          "taskList.daysAgo": "{days}天",
          "taskList.untitled": "新对话",
          "taskList.forkedUntitled": "分支对话",
        };
        let text = map[id] ?? id;
        if (values) {
          for (const [key, value] of Object.entries(values)) {
            text = text.replaceAll(`{${key}}`, value);
          }
        }
        return text;
      },
    },
  }),
}));

function createChangeSummary(added: number, removed: number): CodezTaskChangeSummary {
  return {
    fileCount: 1,
    added,
    removed,
    files: [
      {
        path: "/workspace/file.ts",
        added,
        removed,
        writeCount: 1,
        lastTurnIndex: 1,
      },
    ],
  };
}

function createIntl() {
  return {
    formatMessage: ({ id }: { id: string }, values?: Record<string, string>) => {
      const map: Record<string, string> = {
        "taskList.justNow": "刚刚",
        "taskList.minutesAgo": "{minutes}分",
        "taskList.hoursAgo": "{hours}小时",
        "taskList.daysAgo": "{days}天",
        "taskList.untitled": "新对话",
        "taskList.forkedUntitled": "分支对话",
      };
      let text = map[id] ?? id;
      if (values) {
        for (const [key, value] of Object.entries(values)) {
          text = text.replaceAll(`{${key}}`, value);
        }
      }
      return text;
    },
  };
}

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("resolveTaskHoverCardMeta", () => {
  it("resolves local task metadata without remote host line", () => {
    const now = Date.now();
    const task: TaskHoverCardTask = {
      hostId: "local",
      title: "模板中 Annex C: 变更历史 我改成表格样式了。你看看提示词要不要改改",
      updatedAt: now - 24 * 60 * 60 * 1000,
      workspacePath: "/Users/dev/agent-system",
      changeSummary: createChangeSummary(12, 3),
    };

    const meta = resolveTaskHoverCardMeta({
      task,
      intl: createIntl(),
    });

    expect(meta).toEqual({
      title: "模板中 Annex C: 变更历史 我改成表格样式了。你看看提示词要不要改改",
      timeLabel: "1天",
      workspaceLabel: "agent-system",
      isRemote: false,
      remoteHostLabel: null,
      changeParts: ["+12", "-3"],
    });
  });

  it("resolves remote task metadata with remote host label from deviceNames or host target", () => {
    const now = Date.now();
    const remoteServerTask: TaskHoverCardTask = {
      hostId: "remote:server:srv-1",
      title: "修复远程确认 bug 并推送验证构建",
      updatedAt: now - 23 * 60 * 60 * 1000,
      workspacePath: "/root/workspace/Codez-worktree-1",
      workspaceIdentity: "remote:server:srv-1:/root/workspace/Codez-worktree-1",
    };

    const serverMeta = resolveTaskHoverCardMeta({
      task: remoteServerTask,
      deviceNames: directoryMock.deviceNames,
      hosts: directoryMock.hosts,
      intl: createIntl(),
    });

    expect(serverMeta).toEqual({
      title: "修复远程确认 bug 并推送验证构建",
      timeLabel: "23小时",
      workspaceLabel: "Codez-worktree-1",
      isRemote: true,
      remoteHostLabel: "moga22",
      changeParts: [],
    });

    const sshTask: TaskHoverCardTask = {
      hostId: "remote:ssh:dev@10.0.0.8:22",
      title: "SSH 任务",
      updatedAt: now,
      workspacePath: "/srv/app",
      workspaceIdentity: "remote:ssh:dev@10.0.0.8:22:/srv/app",
    };

    const sshMeta = resolveTaskHoverCardMeta({
      task: sshTask,
      hosts: directoryMock.hosts,
      intl: createIntl(),
    });

    expect(sshMeta.isRemote).toBe(true);
    expect(sshMeta.remoteHostLabel).toBe("dev@10.0.0.8");
  });
});

describe("TaskHoverCard component", () => {
  it("renders local hover card without remote host row and remote hover card with host row", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("PointerEvent", MouseEvent);

    const now = Date.now();
    const { rerender } = render(
      createElement(
        TaskHoverCard,
        {
          task: {
            hostId: "local",
            title: "本地长标题任务",
            updatedAt: now - 60 * 60 * 1000,
            workspacePath: "/work/agent-system",
            changeSummary: createChangeSummary(8, 2),
          },
        },
        createElement("div", { "data-testid": "row-trigger" }, "row"),
      ),
    );

    const trigger = screen.getByTestId("row-trigger");
    fireEvent.pointerMove(trigger, { pointerType: "mouse" });
    fireEvent.pointerEnter(trigger, { pointerType: "mouse" });
    await act(() => vi.advanceTimersByTimeAsync(350));

    expect(screen.getAllByTestId("task-hover-card-title")[0]?.textContent).toBe("本地长标题任务");
    expect(screen.getAllByTestId("task-hover-card-env-icon")[0]?.getAttribute("data-env")).toBe(
      "local",
    );
    expect(screen.getAllByTestId("task-hover-card-workspace")[0]?.textContent).toContain(
      "agent-system",
    );
    expect(screen.getAllByTestId("task-hover-card-changes")[0]?.textContent).toBe("+8-2");
    expect(screen.queryByTestId("task-hover-card-host")).toBeNull();

    rerender(
      createElement(
        TaskHoverCard,
        {
          task: {
            hostId: "remote:server:srv-1",
            title: "修复远程确认 bug 并推送验证构建",
            updatedAt: now - 23 * 60 * 60 * 1000,
            workspacePath: "/work/Codez-worktree-1",
            workspaceIdentity: "remote:server:srv-1:/work/Codez-worktree-1",
          },
        },
        createElement("div", { "data-testid": "row-trigger" }, "row"),
      ),
    );

    expect(screen.getAllByTestId("task-hover-card-env-icon")[0]?.getAttribute("data-env")).toBe(
      "remote",
    );
    expect(screen.getAllByTestId("task-hover-card-host")[0]?.textContent).toContain("moga22");
  });

  it("suppresses the task hover card when pointer moves onto inline action buttons", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("PointerEvent", MouseEvent);

    render(
      createElement(
        TaskHoverCard,
        {
          task: {
            hostId: "local",
            title: "测试悬停按钮抑制",
            updatedAt: Date.now(),
            workspacePath: "/work/demo",
          },
        },
        createElement(
          "div",
          { "data-testid": "row-trigger" },
          createElement("span", { "data-testid": "row-title" }, "title"),
          createElement(
            "span",
            { "data-task-row-actions": "true" },
            createElement("button", { "data-testid": "inline-action" }, "Archive"),
          ),
        ),
      ),
    );

    const title = screen.getByTestId("row-title");
    const action = screen.getByTestId("inline-action");
    expect(isPointerOnTaskRowActionTarget(title)).toBe(false);
    expect(isPointerOnTaskRowActionTarget(action)).toBe(true);

    fireEvent.pointerMove(title, { pointerType: "mouse" });
    fireEvent.pointerEnter(screen.getByTestId("row-trigger"), { pointerType: "mouse" });
    await act(() => vi.advanceTimersByTimeAsync(350));
    expect(screen.queryAllByTestId("task-hover-card").length).toBeGreaterThan(0);

    fireEvent.pointerMove(action, { pointerType: "mouse" });
    expect(screen.queryAllByTestId("task-hover-card")).toHaveLength(0);
  });
});
