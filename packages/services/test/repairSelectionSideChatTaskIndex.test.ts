import { describe, expect, it, vi } from "vitest";
import type { CodezSessionStateSnapshot } from "@codez/shared";
import type { ICodezAgentService } from "../src/codez-agent/codezAgent.js";
import type { TaskIndexRepo } from "../src/session/taskIndexRepo.js";
import { repairSelectionSideChatTaskIndex } from "../src/codez-agent/repairSelectionSideChatTaskIndex.js";

const target = { workspacePath: "/workspace" };

function snapshotOf(
  sessionId: string,
  sessionKind: string,
): Pick<CodezSessionStateSnapshot, "session"> {
  return {
    session: {
      sessionId,
      sessionKind,
      workspace: { workspacePath: "/workspace", workspaceKey: "/workspace" },
    },
  } as Pick<CodezSessionStateSnapshot, "session">;
}

describe("repairSelectionSideChatTaskIndex", () => {
  it("soft-deletes only rows confirmed as selection side-chat children", async () => {
    const updateTaskState = vi.fn();
    const taskIndexRepo = {
      listTaskMetas: vi.fn(async () => [
        { taskId: "stale-side-chat" },
        { taskId: "stale-normal" },
        { taskId: "gone-thread" },
        { taskId: "visible-task" },
      ]),
      updateTaskState,
    } as unknown as Pick<TaskIndexRepo, "listTaskMetas" | "updateTaskState">;
    const readSession = vi.fn().mockImplementation(async (params: { sessionId: string }) => {
      if (params.sessionId === "stale-side-chat")
        return snapshotOf("stale-side-chat", "selection_side_chat");
      if (params.sessionId === "stale-normal") return snapshotOf("stale-normal", "interactive");
      throw new Error("thread gone");
    });
    const onRemoved = vi.fn();

    await repairSelectionSideChatTaskIndex({
      target,
      visibleSessionIds: new Set(["visible-task"]),
      agentService: { readSession } as unknown as Pick<ICodezAgentService, "readSession">,
      taskIndexRepo,
      isCurrent: () => true,
      onRemoved,
    });

    // 可见行不做身份查询；只读不可见候选。
    expect(readSession.mock.calls.map((call) => call[0].sessionId)).toEqual([
      "stale-side-chat",
      "stale-normal",
      "gone-thread",
    ]);
    expect(updateTaskState).toHaveBeenCalledTimes(1);
    expect(updateTaskState).toHaveBeenCalledWith({
      ...target,
      taskId: "stale-side-chat",
      patch: { deleted: true },
    });
    expect(onRemoved).toHaveBeenCalledTimes(1);
  });

  it("stops when the subscription generation is stale", async () => {
    const updateTaskState = vi.fn();
    const taskIndexRepo = {
      listTaskMetas: vi.fn(async () => [{ taskId: "a" }, { taskId: "b" }]),
      updateTaskState,
    } as unknown as Pick<TaskIndexRepo, "listTaskMetas" | "updateTaskState">;
    const readSession = vi
      .fn()
      .mockImplementation(async (params: { sessionId: string }) =>
        snapshotOf(params.sessionId, "selection_side_chat"),
      );
    let current = true;
    const onRemoved = vi.fn(() => {
      current = false;
    });

    await repairSelectionSideChatTaskIndex({
      target,
      visibleSessionIds: new Set(),
      agentService: { readSession } as unknown as Pick<ICodezAgentService, "readSession">,
      taskIndexRepo,
      isCurrent: () => current,
      onRemoved,
    });

    expect(updateTaskState).toHaveBeenCalledTimes(1);
  });
});
