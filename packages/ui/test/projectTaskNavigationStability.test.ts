// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import type { ProjectSidebarProps } from "@/project-sidebar/contract.js";
import { useProjectTaskNavigation } from "@/project-sidebar/useProjectTaskNavigation.js";
const focus = vi.hoisted(() => ({ activeTaskId: "original", draftFocusVersion: 0 }));
const feedback = vi.hoisted(() => ({ toast: vi.fn(), error: vi.fn() }));
vi.mock("@/components/ui/toast.js", () => ({ toast: feedback.toast }));
vi.mock("@/logger.js", () => ({ logger: { error: feedback.error, debug: vi.fn() } }));
vi.mock("@/store/codezSessionStore.js", () => ({
  useCodezSessionStore: { getState: () => ({ getWorkspaceState: () => ({ ...focus }) }) },
}));
beforeEach(() => {
  focus.activeTaskId = "original";
  focus.draftFocusVersion = 0;
  vi.clearAllMocks();
});

it.each([
  [
    Object.assign(new Error("project.navigation-cancelled"), {
      code: "remote-connection-canceled",
    }),
    false,
  ],
  [Object.assign(new Error("bind canceled"), { code: "remote-bind-canceled" }), false],
  [new DOMException("aborted", "AbortError"), false],
  [new Error("provisioning failed"), true],
  [new Error("remote-project.host-removed"), true],
  [new Error("project.workspace-identity-mismatch"), true],
])("navigation reports only non-cancellation errors: %s", async (error, visible) => {
  const task = {
    taskId: "remote-task",
    workspacePath: "/same",
    workspaceIdentity: "remote:server:s:/same",
    hostId: "remote:server:s",
  };
  const { result } = renderHook(() =>
    useProjectTaskNavigation(
      { workspacePath: "/current", onSelectTask: vi.fn() } as unknown as ProjectSidebarProps,
      { projects: [], tasks: [task] } as never,
      {
        readDirectory: async () => {
          throw error;
        },
      } as never,
    ),
  );
  await act(async () => result.current(task.workspacePath, task.taskId, task.workspaceIdentity));
  expect(feedback.toast).toHaveBeenCalledTimes(visible ? 1 : 0);
  expect(feedback.error).toHaveBeenCalledTimes(visible ? 1 : 0);
});
vi.mock("@/store/TabStoreProvider.js", () => ({
  useTabStore: (select: (state: unknown) => unknown) => select({ activeWorkspaceIdentity: null }),
}));
it("keeps the row action stable across tree refreshes and uses the latest navigation callback", async () => {
  const first = vi.fn();
  const second = vi.fn();
  const { result, rerender } = renderHook(
    ({ select }) =>
      useProjectTaskNavigation({ onSelectTask: select } as unknown as ProjectSidebarProps, {
        projects: [],
        tasks: [],
      }),
    { initialProps: { select: first } },
  );
  const before = result.current;
  rerender({ select: second });
  expect(result.current).toBe(before);
  result.current("/same", "task");
  expect(first).not.toHaveBeenCalled();
  expect(second).toHaveBeenCalledWith("/same", "task", undefined, undefined, undefined);
});

it.each(["task", "draft"])(
  "ignores a late directory response after another %s selection in the same workspace",
  async (kind) => {
    const pending = Promise.withResolvers<{ hosts: never[] }>();
    const select = vi.fn();
    const task = {
      taskId: "remote-task",
      workspacePath: "/same",
      workspaceIdentity: "remote:server:s:/same",
      hostId: "remote:server:s",
    };
    const { result } = renderHook(() =>
      useProjectTaskNavigation(
        { workspacePath: "/current", onSelectTask: select } as unknown as ProjectSidebarProps,
        { projects: [], tasks: [task] } as never,
        { readDirectory: () => pending.promise } as never,
      ),
    );
    await act(async () => {
      result.current(task.workspacePath, task.taskId, task.workspaceIdentity);
      if (kind === "task") focus.activeTaskId = "other";
      else focus.draftFocusVersion++;
      pending.resolve({ hosts: [] });
      await pending.promise;
    });
    expect(select).not.toHaveBeenCalled();
  },
);
