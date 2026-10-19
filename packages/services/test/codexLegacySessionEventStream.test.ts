import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Emitter } from "@codez/rpc";
import { resolveWorkspaceKey, type CodezProtocolMessage } from "@codez/shared";
import type { ConversationSnapshot } from "@codez/shared/codez-protocol-v4";
import { setDataBaseDir } from "../src/paths.js";
import { createCodezAgentService } from "../src/codez-agent/codezAgentService.js";
import type { CodezAgentServiceEvent } from "../src/codez-agent/codezAgent.js";
import { CodezAgentProcessManager } from "../src/codez-agent/codezAgentProcessManager.js";
import { CodezProtocolClient } from "../src/codez-agent/codezProtocolClient.js";

// 服务级接线测试（spec: specs/codex-bot-stream-projection.md）：codex 模式下
// onDynamicSessionEvent 必须改走 v4 conversation 订阅并把快照差分成 legacy
// session 事件——这是 Bot 流式回复的唯一事件源。回归目标：bridge 拒绝
// session/subscribe 后 Bot 再也收不到 agent_message_chunk/task_complete。

const SESSION_ID = "session-wire-1";

function makeSnapshot(
  rows: readonly Record<string, unknown>[],
  phase: string,
): ConversationSnapshot {
  return {
    protocolVersion: 1,
    sessionId: SESSION_ID,
    logEpoch: "e1",
    seq: 1,
    revision: 1,
    control: {
      phase,
      sessionEnded: false,
      canStop: phase === "running",
      stopState: phase === "running" ? "stoppable" : "idle",
      stopTargetKind: "assistant",
      activeWorks: [],
      lastError: null,
      apiRetry: null,
    },
    availability: Object.fromEntries(
      [
        "fork",
        "compact",
        "switchModelConfig",
        "setFollowupMode",
        "queueEdit",
        "sendQueuedNow",
        "pauseGoal",
        "resumeGoal",
      ].map((key) => [key, { allowed: true }]),
    ),
    inputRouting: { mode: "startNow" },
    meta: { title: "", titleSource: "default" },
    config: {
      provider: "p",
      model: "m",
      thought: "medium",
      mode: "yolo",
      planEnabled: false,
      followupMode: "queue",
    },
    modelTransition: null,
    usage: {
      contextWindow: null,
      cumulative: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
      codexObserved: { inputTokens: 10, outputTokens: 5 },
    },
    queue: { items: [], autoDrain: false },
    pendingInteractions: [],
    pendingCommands: [],
    backgroundWorks: [],
    goal: null,
    plan: null,
    workspaceHookAdmission: null,
    rows: {
      window: rows,
      totalCount: rows.length,
      firstRowId: rows.length > 0 ? (rows[0]!.rowId as number) : null,
    },
  } as unknown as ConversationSnapshot;
}

function wireFrame(
  subscriptionId: string,
  ordinal: number,
  snapshot: ConversationSnapshot,
  deliveryKind: "initial" | "online" = "online",
): Record<string, unknown> {
  return {
    wireVersion: 3,
    kind: "complete",
    deliveryKind,
    logicalFrameId: `frame-${ordinal}`,
    logicalFrameOrdinal: ordinal,
    topic: `conversation/${SESSION_ID}`,
    subscriptionId,
    frame: {
      topic: `conversation/${SESSION_ID}`,
      subscriptionId,
      fromSeq: 0,
      toSeq: ordinal,
      sentAt: Date.now(),
      payload: { kind: "snapshot", snapshot },
    },
  };
}

async function waitFor(condition: () => boolean, attempts = 100): Promise<void> {
  for (let index = 0; index < attempts; index += 1) {
    if (condition()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.fail("condition not met within attempts");
}

test("codex mode streams legacy session events from v4 frames (bot reply source)", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "codez-codex-stream-"));
  setDataBaseDir(dir);
  const previousRuntime = process.env.CODEZ_DESKTOP_RUNTIME;
  const previousCommand = process.env.CODEZ_AGENT_SERVER_COMMAND;
  process.env.CODEZ_DESKTOP_RUNTIME = "codex";
  delete process.env.CODEZ_AGENT_SERVER_COMMAND;
  t.after(() => {
    if (previousRuntime === undefined) delete process.env.CODEZ_DESKTOP_RUNTIME;
    else process.env.CODEZ_DESKTOP_RUNTIME = previousRuntime;
    if (previousCommand !== undefined) process.env.CODEZ_AGENT_SERVER_COMMAND = previousCommand;
  });

  const sent: Array<{ method: string; params: unknown }> = [];
  let notify: ((message: CodezProtocolMessage) => void) | undefined;
  t.mock.method(CodezAgentProcessManager.prototype, "getClient", async () => {
    const messages = new Emitter<CodezProtocolMessage>();
    const closes = new Emitter<{ reason?: string }>();
    notify = (message) => messages.fire(message);
    return new CodezProtocolClient({
      kind: "memory",
      onMessage: messages.event,
      onClose: closes.event,
      async send(message) {
        if (!("id" in message && "method" in message)) return;
        sent.push({ method: message.method, params: message.params });
        if (message.method === "v4/conversation/subscribe") {
          messages.fire({
            id: message.id,
            result: {
              ack: { subscriptionId: "sub-1", mode: "snapshot", logEpoch: "e1" },
            },
          });
          return;
        }
        if (message.method === "v4/conversation/unsubscribe") {
          messages.fire({ id: message.id, result: {} });
          return;
        }
        // 启动期其它 RPC（若有）一律空结果放行。
        messages.fire({ id: message.id, result: {} });
      },
      dispose() {
        messages.dispose();
        closes.dispose();
      },
    });
  });

  const service = createCodezAgentService({
    presentationSurface: "desktop",
    modelSelectionReadinessSource: {
      async getView() {
        throw new Error("legacy provider unavailable");
      },
    },
    accountProviderConfigSource: {
      async read() {
        throw new Error("legacy account unavailable");
      },
      onDidChange() {
        return () => {};
      },
    },
  });

  const events: CodezAgentServiceEvent[] = [];
  const workspace = { workspacePath: dir, workspaceIdentity: "remote-a" };
  try {
    const subscription = service.onDynamicSessionEvent({
      ...workspace,
      sessionId: SESSION_ID,
      deliveryKind: "desktop-continuous",
    })((event) => events.push(event));

    // codex 分支必须发起 v4 conversation 订阅，而不是 legacy session/subscribe。
    await waitFor(() => sent.some((message) => message.method === "v4/conversation/subscribe"));
    assert.ok(!sent.some((message) => message.method === "session/subscribe"));

    const rows = [
      {
        rowId: 1,
        turnId: "t1",
        createdAt: 1700000000,
        createdAtSeq: 1,
        kind: "userInput",
        text: "你好",
        origin: "realUser",
      },
      {
        rowId: 2,
        turnId: "t1",
        createdAt: 1700000000,
        createdAtSeq: 2,
        kind: "turnHeader",
        origin: "userInput",
        state: "running",
        startedAt: 1700000000,
      },
      {
        rowId: 3,
        turnId: "t1",
        entityId: "m1",
        createdAt: 1700000000,
        createdAtSeq: 3,
        kind: "assistantText",
        text: "你",
        state: "streaming",
      },
    ];
    notify!({
      method: "v4/conversation/frame",
      params: wireFrame("sub-1", 1, makeSnapshot(rows, "running"), "initial"),
    } as CodezProtocolMessage);
    await waitFor(() => events.length >= 2);

    const sessionEventAt = (index: number) => {
      const event = events[index];
      assert.ok(event && event.type === "session.event");
      return event.event;
    };
    assert.equal(sessionEventAt(0).type, "turn.started");
    assert.equal(sessionEventAt(0).turnId, "t1");
    assert.equal(sessionEventAt(1).type, "model.streaming");
    const firstChunk = sessionEventAt(1).payload as { kind: string; delta: string };
    assert.equal(firstChunk.kind, "text_delta");
    assert.equal(firstChunk.delta, "你");

    // 文本增长 + 回合完成：chunk 增量与 turn.completed 携带全量 response。
    const grownRows = [
      rows[0]!,
      { ...(rows[1] as object), state: "completedSuccess" },
      { ...(rows[2] as object), text: "你好，世界", state: "complete" },
    ];
    notify!({
      method: "v4/conversation/frame",
      params: wireFrame("sub-1", 2, makeSnapshot(grownRows, "completedSuccess")),
    } as CodezProtocolMessage);
    await waitFor(() => events.length >= 4);
    const laterEventAt = (offset: number) => sessionEventAt(2 + offset);
    assert.equal(laterEventAt(0).type, "model.streaming");
    assert.equal((laterEventAt(0).payload as { delta: string }).delta, "好，世界");
    assert.equal(laterEventAt(1).type, "turn.completed");
    const completion = laterEventAt(1).payload as { response: string; resultType: string };
    assert.equal(completion.response, "你好，世界");
    assert.equal(completion.resultType, "success");

    // 最后一个订阅者 dispose 后必须退订 v4 订阅，不留悬挂路由。
    subscription.dispose();
    await waitFor(() => sent.some((message) => message.method === "v4/conversation/unsubscribe"));
    const observations = await service.getCodexUsageObservations(workspace);
    assert.equal(observations.workspaceKey, "remote-a");
    assert.deepEqual(
      observations.threads.find((entry) => entry.threadId === SESSION_ID)?.observation.payload,
      {
        inputTokens: 10,
        outputTokens: 5,
      },
    );
  } finally {
    await service.disposeAllAndWait();
    await rm(dir, { recursive: true, force: true });
  }
  assert.ok(resolveWorkspaceKey(workspace).length > 0);
});
