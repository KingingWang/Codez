import { describe, expect, it } from "vitest";
import {
  conversationSnapshotSchema,
  statePatchSchema,
  type ConversationSnapshot,
} from "../src/codez-protocol-v4/index.js";

function snapshot(): ConversationSnapshot {
  return {
    protocolVersion: 1,
    sessionId: "s-1",
    logEpoch: "epoch-1",
    seq: 0,
    revision: 0,
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
      sendQueuedNow: { allowed: true },
      pauseGoal: { allowed: true },
      resumeGoal: { allowed: true },
    },
    inputRouting: { mode: "startNow" },
    meta: { title: "", titleSource: "default" },
    config: { provider: "", model: "", thought: "", followupMode: "queue", mode: "" },
    modelTransition: null,
    usage: {
      contextWindow: null,
      cumulative: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
    },
    queue: { items: [], autoDrain: true },
    pendingInteractions: [],
    pendingCommands: [],
    backgroundWorks: [],
    workspaceHookAdmission: null,
    goal: null,
    plan: null,
    rows: { window: [], totalCount: 0, firstRowId: null },
  };
}

describe("retired Codex runtime notice wire compatibility", () => {
  it("strips notice fields from older snapshots and patches", () => {
    const runtimeNotices = [
      { id: "notice-1", kind: "warning", message: "native warning", at: 123 },
    ];
    const parsedSnapshot = conversationSnapshotSchema.parse({ ...snapshot(), runtimeNotices });
    const parsedPatch = statePatchSchema.parse({ runtimeNotices });
    expect("runtimeNotices" in parsedSnapshot).toBe(false);
    expect("runtimeNotices" in parsedPatch).toBe(false);
  });
});
