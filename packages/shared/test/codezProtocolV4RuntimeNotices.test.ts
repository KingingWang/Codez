import { describe, expect, it } from "vitest";
import {
  applyConversationDeltas,
  applyConversationDeltasMutable,
  coalesceConversationDeltas,
  conversationSnapshotSchema,
  createMutableConversationSnapshotAccumulator,
  runtimeNoticeSchema,
  statePatchSchema,
  type ConversationDelta,
  type ConversationSnapshot,
} from "../src/codez-protocol-v4/index.js";

const warning = {
  id: "notice-1",
  kind: "warning" as const,
  message: "native warning",
  at: 123,
};

function oldSnapshot(): ConversationSnapshot {
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

describe("Codex runtime notices", () => {
  it("keeps old snapshots valid and validates bounded notice payloads", () => {
    expect(conversationSnapshotSchema.parse(oldSnapshot()).runtimeNotices).toBeUndefined();
    expect(
      runtimeNoticeSchema.parse({
        ...warning,
        kind: "authRecovery",
        turnId: "turn-1",
        provider: "openai",
        phase: "started",
      }),
    ).toMatchObject({ turnId: "turn-1", provider: "openai", phase: "started" });
    expect(runtimeNoticeSchema.safeParse({ ...warning, message: "x".repeat(4_097) }).success).toBe(
      false,
    );
  });

  it("uses whole-key replacement for immutable, mutable and coalesced deltas", () => {
    const recovery = {
      ...warning,
      id: "notice-2",
      kind: "authRecovery" as const,
      turnId: "turn-1",
      provider: "openai",
      phase: "completed" as const,
    };
    const deltas: ConversationDelta[] = [
      { op: "state.updated", patch: statePatchSchema.parse({ runtimeNotices: [warning] }) },
      { op: "state.updated", patch: statePatchSchema.parse({ runtimeNotices: [recovery] }) },
    ];
    const base = oldSnapshot();
    const direct = applyConversationDeltas(base, deltas);
    const coalesced = applyConversationDeltas(base, coalesceConversationDeltas(deltas));
    expect(coalesced.runtimeNotices).toEqual([recovery]);
    const accumulator = createMutableConversationSnapshotAccumulator(base);
    applyConversationDeltasMutable(accumulator, coalesceConversationDeltas(deltas));
    expect(accumulator.snapshot).toEqual(direct);
  });
});
