// 手机远控 bridge 重建导致整树重挂时，投影 store 经模块级交接缓存携带
// subscribe base 恢复：CLI 裁决 resume 后只补增量帧，不再全量重发。
import { beforeEach, describe, expect, it } from "vitest";
import type {
  ConversationSnapshot,
  ConversationTopicFrame,
  SubscribeParams,
  TopicFrameDeliveryKind,
  V4ConversationSubscribeResult,
} from "@codez/shared/codez-protocol-v4";
import {
  clearConversationSnapshotHandoffs,
  takeConversationSnapshotHandoff,
  writeConversationSnapshotHandoff,
} from "@/v4/conversationSnapshotHandoff.js";
import { ConversationProjectionStore } from "@/v4/conversationProjectionStore.js";
import type { ConversationTransport } from "@/v4/transport.js";

function makeSnapshot(seq: number, sessionId = "s1"): ConversationSnapshot {
  return {
    protocolVersion: 1,
    sessionId,
    logEpoch: "epoch-1",
    seq,
    revision: 0,
    control: {
      phase: "idle",
      sessionEnded: false,
      canStop: false,
      stopState: "idle",
      stopTargetKind: "unknown",
      activeWorks: [],
      lastError: null,
      apiRetry: null,
    },
    availability: {
      fork: { allowed: true },
      compact: { allowed: false, reasonCode: "idleCannotCompact" },
      switchModelConfig: { allowed: true },
      setFollowupMode: { allowed: true },
      queueEdit: { allowed: true },
      sendQueuedNow: { allowed: false, reasonCode: "sendQueuedNowRequiresRunning" },
      pauseGoal: { allowed: false, reasonCode: "noGoalToPause" },
      resumeGoal: { allowed: false, reasonCode: "noGoalToResume" },
    },
    inputRouting: { mode: "startNow" },
    config: { provider: "", model: "", thought: "", followupMode: "queue" },
    modelTransition: null,
    usage: {
      contextWindow: null,
      cumulative: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
    },
    queue: { items: [], autoDrain: true },
    pendingInteractions: [],
    pendingCommands: [],
    backgroundWorks: [],
    goal: null,
    plan: null,
    rows: { window: [], totalCount: 0, firstRowId: null },
  };
}

class MinimalTransport {
  subscribeCalls: SubscribeParams[] = [];
  private frameListeners = new Set<
    (frame: ConversationTopicFrame, context?: { deliveryKind: TopicFrameDeliveryKind }) => void
  >();
  private subCounter = 0;
  subscribeMode: "snapshot" | "resume" = "snapshot";

  async subscribe(params: SubscribeParams): Promise<V4ConversationSubscribeResult> {
    this.subscribeCalls.push(params);
    const subscriptionId = `sub-${++this.subCounter}`;
    return {
      ack: { subscriptionId, mode: this.subscribeMode, logEpoch: "epoch-1" },
    };
  }

  async unsubscribe(): Promise<void> {}

  activate(): void {}

  async resync(): Promise<never> {
    throw new Error("not used");
  }

  async sendCommand(): Promise<never> {
    throw new Error("not used");
  }

  async queryCommands(): Promise<never> {
    throw new Error("not used");
  }

  async rowsRange(): Promise<never> {
    throw new Error("not used");
  }

  async plans(): Promise<never> {
    throw new Error("not used");
  }

  onFrame(
    listener: (
      frame: ConversationTopicFrame,
      context?: { deliveryKind: TopicFrameDeliveryKind },
    ) => void,
  ): () => void {
    this.frameListeners.add(listener);
    return () => this.frameListeners.delete(listener);
  }

  onAssemblyFault(): () => void {
    return () => {};
  }

  onRuntimeRestart(): () => void {
    return () => {};
  }
}

function makeTransport(): MinimalTransport & ConversationTransport {
  return new MinimalTransport() as unknown as ConversationTransport & MinimalTransport;
}

describe("conversationSnapshotHandoff", () => {
  beforeEach(() => {
    clearConversationSnapshotHandoffs();
  });

  it("写入后可取走一次，二次取走为空", () => {
    writeConversationSnapshotHandoff("conversation/s1", makeSnapshot(7), 1000);
    expect(takeConversationSnapshotHandoff("conversation/s1", 1001)?.seq).toBe(7);
    expect(takeConversationSnapshotHandoff("conversation/s1", 1002)).toBeNull();
  });

  it("超过 TTL 的条目被丢弃", () => {
    writeConversationSnapshotHandoff("conversation/s1", makeSnapshot(7), 1000);
    expect(takeConversationSnapshotHandoff("conversation/s1", 1000 + 31 * 60 * 1000)).toBeNull();
  });

  it("最多保留两个 topic，最旧的被逐出", () => {
    writeConversationSnapshotHandoff("conversation/s1", makeSnapshot(1), 1000);
    writeConversationSnapshotHandoff("conversation/s2", makeSnapshot(2), 1001);
    writeConversationSnapshotHandoff("conversation/s3", makeSnapshot(3), 1002);
    expect(takeConversationSnapshotHandoff("conversation/s1", 1003)).toBeNull();
    expect(takeConversationSnapshotHandoff("conversation/s2", 1003)?.seq).toBe(2);
    expect(takeConversationSnapshotHandoff("conversation/s3", 1003)?.seq).toBe(3);
  });

  it("重复写同一 topic 只保留最新", () => {
    writeConversationSnapshotHandoff("conversation/s1", makeSnapshot(1), 1000);
    writeConversationSnapshotHandoff("conversation/s1", makeSnapshot(9), 1001);
    expect(takeConversationSnapshotHandoff("conversation/s1", 1002)?.seq).toBe(9);
  });
});

describe("ConversationProjectionStore 快照交接", () => {
  beforeEach(() => {
    clearConversationSnapshotHandoffs();
  });

  it("close 后新 store 继承快照，connect 携带 base 请求增量续传", async () => {
    const first = new ConversationProjectionStore("conversation/s1", makeTransport());
    // 通过 handleFrame 走正式路径应用快照帧。
    const frame: ConversationTopicFrame = {
      topic: "conversation/s1",
      subscriptionId: "sub-0",
      fromSeq: 0,
      toSeq: 5,
      sentAt: 1,
      payload: { kind: "snapshot", snapshot: makeSnapshot(5) },
    };
    (
      first as unknown as {
        applyFrame(
          frame: ConversationTopicFrame,
          context: {
            subscribeMode: "snapshot" | "resume" | null;
            recovery: boolean;
            online: boolean;
          },
        ): void;
      }
    ).applyFrame(frame, { subscribeMode: "snapshot", recovery: false, online: true });
    expect(first.getState().snapshot?.seq).toBe(5);
    await first.close();

    const transport = makeTransport();
    transport.subscribeMode = "resume";
    const second = new ConversationProjectionStore("conversation/s1", transport);
    // 重挂后的新 store 立即有内容可渲染，不再白屏转圈。
    expect(second.getState().snapshot?.seq).toBe(5);
    expect(second.getState().status).toBe("connecting");

    await second.connect();
    expect(transport.subscribeCalls).toHaveLength(1);
    expect(transport.subscribeCalls[0]?.base).toEqual({ logEpoch: "epoch-1", seq: 5 });
    await second.close();
  });

  it("无交接时 connect 不带 base（保持全量订阅现状）", async () => {
    const transport = makeTransport();
    const store = new ConversationProjectionStore("conversation/s1", transport);
    expect(store.getState().snapshot).toBeNull();
    await store.connect();
    expect(transport.subscribeCalls[0]?.base).toBeUndefined();
    await store.close();
  });

  it("快照为空的 store close 不写交接", async () => {
    const store = new ConversationProjectionStore("conversation/s1", makeTransport());
    await store.close();
    expect(takeConversationSnapshotHandoff("conversation/s1")).toBeNull();
  });
});
