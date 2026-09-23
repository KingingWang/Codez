import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ICodezSessionService } from "@codez/services";
import { invalidateDeferredDraftSessionForSkillChange } from "../src/lib/codezDraftSkillInvalidation.js";
import { useCodezSessionStore } from "../src/store/codezSessionStore.js";

function createSessionService(
  closeSession: ICodezSessionService["closeSession"] = vi.fn(async () => {}),
): Pick<ICodezSessionService, "closeSession"> {
  return { closeSession };
}

beforeEach(() => {
  useCodezSessionStore.setState((state) => ({
    ...state,
    workspaces: {},
  }));
});

describe("invalidateDeferredDraftSessionForSkillChange", () => {
  it("closes and clears the current workspace draft session", async () => {
    const closeSession = vi.fn(async () => {});
    const workspacePath = "/workspace/app";
    const workspaceIdentity = "ssh:dev";
    useCodezSessionStore.getState().setDraftSessionId(workspacePath, "draft-1", workspaceIdentity);

    await invalidateDeferredDraftSessionForSkillChange({
      reason: "test",
      workspacePath,
      workspaceIdentity,
      codezSessionService: createSessionService(closeSession),
    });

    expect(closeSession).toHaveBeenCalledWith({
      workspacePath,
      workspaceIdentity,
      sessionId: "draft-1",
    });
    expect(
      useCodezSessionStore.getState().getWorkspaceState(workspacePath, workspaceIdentity)
        .draftSessionId,
    ).toBeNull();
    expect(
      useCodezSessionStore.getState().getWorkspaceState(workspacePath, workspaceIdentity)
        .draftRuntimeInvalidationVersion,
    ).toBe(1);
  });

  it("invalidates a protocol-v4 prewarm even when there is no legacy draft session", async () => {
    const closeSession = vi.fn(async () => {});
    const workspacePath = "/workspace/app";

    await invalidateDeferredDraftSessionForSkillChange({
      reason: "test",
      workspacePath,
      codezSessionService: createSessionService(closeSession),
    });

    expect(closeSession).not.toHaveBeenCalled();
    expect(
      useCodezSessionStore.getState().getWorkspaceState(workspacePath)
        .draftRuntimeInvalidationVersion,
    ).toBe(1);
  });

  it("still clears the draft when closing the stale session fails", async () => {
    const closeSession = vi.fn(async () => {
      throw new Error("stale draft");
    });
    const workspacePath = "/workspace/app";
    useCodezSessionStore.getState().setDraftSessionId(workspacePath, "draft-1");

    await invalidateDeferredDraftSessionForSkillChange({
      reason: "test",
      workspacePath,
      codezSessionService: createSessionService(closeSession),
    });

    expect(closeSession).toHaveBeenCalledWith({
      workspacePath,
      sessionId: "draft-1",
    });
    expect(
      useCodezSessionStore.getState().getWorkspaceState(workspacePath).draftSessionId,
    ).toBeNull();
    expect(
      useCodezSessionStore.getState().getWorkspaceState(workspacePath)
        .draftRuntimeInvalidationVersion,
    ).toBe(1);
  });
});
