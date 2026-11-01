import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { randomUUID } from "node:crypto";
import {
  conversationTelemetryFactSchema,
  LOCAL_TTFT_TTL_MS,
  type CommandEnvelope,
  type ConversationTelemetryFact,
} from "@codez/shared/codez-protocol-v4";
import { BridgeConversationObservations } from "../src/conversation-observations.js";
import { accumulateNativeTurnUsage } from "../src/bridge-snapshot-usage.js";
import { ThreadStateStore } from "../src/thread-state.js";
import { InteractionBroker } from "../src/interactions.js";
import { formatBridgeStateDiagnostic, type BridgeStateDiagnostic } from "../src/diagnostics.js";
import type { CodexNotification } from "../src/contract.js";
import { threadFixture } from "./projection-fixtures.test.js";
import { MockRpc, setup } from "./fixtures/commands-fixture.js";

function harness(t: TestContext, sink?: (fact: ConversationTelemetryFact) => Promise<void>) {
  let now = 1000;
  const rpc = new MockRpc();
  const store = new ThreadStateStore(rpc, "/workspace");
  const state = store.markStarted(threadFixture());
  const facts: ConversationTelemetryFact[] = [];
  const diagnostics: BridgeStateDiagnostic[] = [];
  const observations = new BridgeConversationObservations({
    instanceId: "instance-1",
    state: (id) => store.get(id),
    now: () => now,
    notify:
      sink ??
      (async (fact) => {
        facts.push(conversationTelemetryFactSchema.parse(fact));
      }),
    diagnostic: (value) => diagnostics.push(value),
  });
  t.after(() => observations.close());
  const command = (id = "command-1", sessionId: string | null = "thread-1"): CommandEnvelope => ({
    commandId: id,
    sessionId,
    clientId: "desktop-1",
    type: "sendText",
    issuedAt: 0,
    inputOrigin: "desktop",
    payload: { text: "private fixture input" },
    ttft: { version: 1, observationId: randomUUID(), localOnly: true },
  });
  const event = (method: string, params: unknown, at = now, emittedAtMs?: number) => {
    const native: CodexNotification = {
      method,
      params,
      ...(emittedAtMs !== undefined ? { emittedAtMs } : {}),
    };
    observations.observe(native, at);
  };
  const start = (id = "turn-live") =>
    event("turn/started", {
      threadId: "thread-1",
      turn: { id, status: "inProgress", startedAt: 1 },
    });
  const bind = (input: CommandEnvelope, id = "turn-live") => {
    observations.received(input, now);
    observations.beginTurn(input, "thread-1", true);
    observations.acceptTurn(input, "thread-1", { turn: { id } });
  };
  return {
    observations,
    rpc,
    store,
    state,
    facts,
    diagnostics,
    command,
    event,
    start,
    bind,
    time: (at: number) => {
      now = at;
    },
  };
}

test("native facts before ACK bind by returned turn, and first output retains arrival time", async (t) => {
  const h = harness(t);
  const input = h.command();
  h.observations.received(input, 1000);
  h.observations.beginTurn(input, "thread-1", true);
  h.start();
  h.event(
    "item/started",
    {
      threadId: "thread-1",
      turnId: "turn-live",
      item: { id: "reason-1", type: "reasoning", summary: [], content: [] },
    },
    1100,
  );
  assert.equal(h.diagnostics.length, 0, "empty item start is not effective output");
  h.event(
    "item/reasoning/summaryTextDelta",
    {
      threadId: "thread-1",
      turnId: "turn-live",
      itemId: "reason-1",
      summaryIndex: 0,
      delta: "思考",
    },
    1250,
  );
  assert.equal(h.facts.length, 0, "unbound notifications cannot borrow the latest command");
  h.time(1300);
  h.observations.acceptTurn(input, "thread-1", { turn: { id: "turn-live" } });
  await h.observations.settled();
  assert.deepEqual(
    h.facts.map((fact) => fact.kind),
    ["turn.started", "stream.chunk"],
  );
  assert.ok(h.facts.every((fact) => fact.sourceCommandId === input.commandId));
  assert.deepEqual(h.diagnostics[0], {
    kind: "nativeFirstOutput",
    instanceId: "instance-1",
    observationId: input.ttft!.observationId,
    commandId: input.commandId,
    sessionId: "thread-1",
    turnId: "turn-live",
    outcome: "success",
    reason: undefined,
    durationMs: 250,
    outputKind: "reasoning",
  });
  h.event(
    "item/agentMessage/delta",
    {
      threadId: "thread-1",
      turnId: "turn-live",
      itemId: "answer-1",
      delta: "answer",
    },
    1400,
  );
  h.event(
    "turn/completed",
    {
      threadId: "thread-1",
      turn: { id: "turn-live", status: "failed", durationMs: 400 },
    },
    1500,
  );
  await h.observations.settled();
  assert.equal(h.diagnostics.length, 1, "a later failure cannot reverse first output");
  assert.equal(JSON.stringify(h.facts).includes("思考"), false);
});

test("six fact kinds are emitted without inventing request, workflow or child lifecycle", async (t) => {
  const h = harness(t);
  h.bind(h.command());
  h.start();
  h.event("item/agentMessage/delta", {
    threadId: "thread-1",
    turnId: "turn-live",
    itemId: "message-1",
    delta: "private reply",
  });
  h.event("item/started", {
    threadId: "thread-1",
    turnId: "turn-live",
    startedAtMs: 100,
    item: {
      id: "tool-1",
      type: "commandExecution",
      command: "private command",
      status: "inProgress",
    },
  });
  h.observations.permission(
    {
      id: 1,
      method: "item/commandExecution/requestApproval",
      params: { threadId: "thread-1", turnId: "turn-live", itemId: "tool-1" },
    },
    "requested",
  );
  const usage = {
    total: nativeUsage(100),
    last: nativeUsage(10),
  };
  h.state.turnTokenUsage = { "turn-live": accumulateNativeTurnUsage(undefined, usage)! };
  h.event("thread/tokenUsage/updated", {
    threadId: "thread-1",
    turnId: "turn-live",
    tokenUsage: usage,
  });
  h.event("turn/completed", {
    threadId: "thread-1",
    turn: { id: "turn-live", status: "completed", durationMs: 500 },
  });
  await h.observations.settled();
  assert.deepEqual(
    [...new Set(h.facts.map((fact) => fact.kind))],
    [
      "turn.started",
      "stream.chunk",
      "tool.lifecycle",
      "permission.lifecycle",
      "usage.delta",
      "turn.terminal",
    ],
  );
  assert.equal(JSON.stringify(h.facts).includes("private"), false);
  assert.ok(h.facts.every((fact, index) => fact.eventSeq > (h.facts[index - 1]?.eventSeq ?? 0)));
});

test("tool timestamps are native milliseconds, missing starts are not fabricated", async (t) => {
  const h = harness(t);
  h.bind(h.command());
  h.start();
  const params = {
    threadId: "thread-1",
    turnId: "turn-live",
    item: { id: "tool-1", type: "commandExecution", command: "not logged", status: "inProgress" },
  };
  h.event("item/started", { ...params, startedAtMs: 10 });
  h.event("item/started", { ...params, startedAtMs: 10 });
  h.event("item/completed", {
    ...params,
    completedAtMs: 35,
    item: { ...params.item, status: "completed" },
  });
  h.event("item/completed", {
    ...params,
    completedAtMs: 35,
    item: { ...params.item, status: "completed" },
  });
  h.event("item/completed", {
    threadId: "thread-1",
    turnId: "turn-live",
    completedAtMs: 90,
    item: {
      id: "tool-2",
      type: "mcpToolCall",
      tool: "test.tool",
      status: "completed",
      durationMs: 8,
    },
  });
  h.event("item/completed", {
    threadId: "thread-1",
    turnId: "turn-live",
    completedAtMs: 90,
    item: { id: "tool-3", type: "fileChange", status: "completed" },
  });
  await h.observations.settled();
  const tools = h.facts.filter((fact) => fact.kind === "tool.lifecycle");
  assert.deepEqual(
    tools.map((fact) => [fact.toolCallId, fact.phase, fact.durationMs]),
    [
      ["tool-1", "started", undefined],
      ["tool-1", "completed", 25],
      ["tool-2", "completed", 8],
      ["tool-3", "completed", undefined],
    ],
  );
});

function nativeUsage(multiplier: number) {
  return {
    inputTokens: multiplier * 3,
    outputTokens: multiplier,
    totalTokens: multiplier * 4,
    reasoningOutputTokens: multiplier,
    cachedInputTokens: multiplier,
    cacheWriteInputTokens: 0,
  };
}

test("usage reads the existing owner accumulator and reports only unseen complete deltas", async (t) => {
  const h = harness(t);
  h.bind(h.command());
  h.start();
  const update = (total: number, last: number) => {
    const raw = { total: nativeUsage(total), last: nativeUsage(last) };
    h.state.turnTokenUsage = {
      "turn-live": accumulateNativeTurnUsage(h.state.turnTokenUsage?.["turn-live"], raw)!,
    };
    h.event("thread/tokenUsage/updated", {
      threadId: "thread-1",
      turnId: "turn-live",
      tokenUsage: raw,
    });
  };
  update(100, 10);
  update(120, 20);
  update(120, 20);
  update(110, 1);
  update(130, 20);
  await h.observations.settled();
  const facts = h.facts.filter((fact) => fact.kind === "usage.delta");
  assert.deepEqual(
    facts.map((fact) => fact.totalTokens),
    [40, 80],
  );
  assert.ok(facts.every((fact) => fact.cacheWriteTokens === 0));
});

test("sparse native usage is not filled with zeros or promoted to a valid terminal token count", async (t) => {
  const h = harness(t);
  h.bind(h.command());
  h.start();
  const raw = { total: { inputTokens: 12 }, last: { inputTokens: 2 } };
  h.state.turnTokenUsage = { "turn-live": accumulateNativeTurnUsage(undefined, raw)! };
  h.event("thread/tokenUsage/updated", {
    threadId: "thread-1",
    turnId: "turn-live",
    tokenUsage: raw,
  });
  h.event("turn/completed", {
    threadId: "thread-1",
    turn: { id: "turn-live", status: "completed" },
  });
  await h.observations.settled();
  assert.equal(
    h.facts.some((fact) => fact.kind === "usage.delta"),
    false,
  );
  const terminal = h.facts.find((fact) => fact.kind === "turn.terminal");
  assert.ok(terminal?.kind === "turn.terminal");
  assert.equal(terminal.tokenCount, undefined);
});

test("queued/guide user rows cannot replace the live turn's original command", async (t) => {
  const h = harness(t);
  const initial = h.command();
  h.bind(initial);
  h.start();
  const guided = h.command("guide-1");
  h.observations.received(guided, 1100);
  h.observations.decided(guided, {
    commandId: guided.commandId,
    status: "accepted",
    revisionAtDecision: 0,
  });
  h.event("item/completed", {
    threadId: "thread-1",
    turnId: "turn-live",
    item: { type: "userMessage", id: "guide-user", clientId: guided.commandId },
  });
  h.event(
    "item/agentMessage/delta",
    {
      threadId: "thread-1",
      turnId: "turn-live",
      itemId: "answer-1",
      delta: "text",
    },
    1200,
  );
  await h.observations.settled();
  assert.ok(h.facts.every((fact) => fact.sourceCommandId === initial.commandId));
  const excluded = h.diagnostics.find(
    (value) => value.kind === "nativeFirstOutput" && value.commandId === guided.commandId,
  );
  assert.ok(excluded?.kind === "nativeFirstOutput");
  assert.equal(excluded.outcome, "excluded");
  h.start("queued-turn");
  h.event("item/completed", {
    threadId: "thread-1",
    turnId: "queued-turn",
    item: { type: "userMessage", id: "queued-user", clientId: "queued-command" },
  });
  await h.observations.settled();
  assert.equal(h.facts.at(-1)?.sourceCommandId, "queued-command");
});

test("history items without a real turn-start and unowned/child threads emit no facts", async (t) => {
  const h = harness(t);
  h.event("item/completed", {
    threadId: "thread-1",
    turnId: "historical",
    item: { type: "userMessage", id: "user-1", clientId: "old-command" },
  });
  h.event("item/completed", {
    threadId: "thread-1",
    turnId: "historical",
    item: { type: "agentMessage", id: "reply-1", text: "history" },
  });
  h.event("turn/started", { threadId: "not-owned", turn: { id: "other-turn" } });
  h.state.readOnly = "subagent-child";
  h.start();
  await h.observations.settled();
  assert.equal(h.facts.length, 0);
  assert.equal(h.diagnostics.length, 0);
});

test("permissions report only successfully accepted native replies and tolerate observer failure", async (t) => {
  const h = harness(t);
  h.bind(h.command());
  h.start();
  const broker = new InteractionBroker(
    h.rpc,
    () => {},
    (request, phase, decision) => h.observations.permission(request, phase, decision),
  );
  const request = {
    id: 7,
    method: "item/commandExecution/requestApproval",
    params: {
      threadId: "thread-1",
      turnId: "turn-live",
      itemId: "tool-1",
      availableDecisions: ["accept", "decline"],
      command: "private command",
    },
  };
  await broker.accept(request);
  const interaction = broker.list("thread-1")[0]!;
  await assert.rejects(broker.resolve("thread-1", interaction.interactionId, { optionId: "fake" }));
  h.rpc.onRespond = async () => {
    throw new Error("transport failed after write");
  };
  await assert.rejects(
    broker.resolve("thread-1", interaction.interactionId, { optionId: "accept" }),
  );
  await h.observations.settled();
  assert.deepEqual(
    h.facts.filter((fact) => fact.kind === "permission.lifecycle").map((fact) => fact.phase),
    ["requested"],
  );
  h.rpc.onRespond = async () => {};
  await broker.accept({ ...request, id: 8 });
  await broker.resolve("thread-1", broker.list("thread-1").at(-1)!.interactionId, {
    optionId: "accept",
  });
  await broker.accept({ ...request, id: 9 });
  await broker.resolve("thread-1", broker.list("thread-1").at(-1)!.interactionId, {
    optionId: "decline",
  });
  await h.observations.settled();
  assert.deepEqual(
    h.facts
      .filter((fact) => fact.kind === "permission.lifecycle")
      .map((fact) => [fact.phase, fact.decision]),
    [
      ["requested", undefined],
      ["requested", undefined],
      ["resolved", "allow"],
      ["requested", undefined],
      ["denied", "deny"],
    ],
  );
  const nonfatal = new InteractionBroker(
    new MockRpc(),
    () => {},
    () => {
      throw new Error("diagnostic IO failed");
    },
  );
  await nonfatal.accept(request);
  await nonfatal.resolve("thread-1", nonfatal.list("thread-1")[0]!.interactionId, {
    optionId: "decline",
  });
  assert.equal(nonfatal.list("thread-1").length, 0);
});

test("failure, unclosed expiry, backwards clock and sink failure stay diagnostic-only", async (t) => {
  const h = harness(t, async () => {
    throw new Error("offline telemetry");
  });
  h.bind(h.command());
  h.start();
  h.event(
    "item/agentMessage/delta",
    {
      threadId: "thread-1",
      turnId: "turn-live",
      itemId: "answer",
      delta: "text",
    },
    900,
  );
  await h.observations.settled();
  assert.ok(
    h.diagnostics.some(
      (value) =>
        value.kind === "nativeFirstOutput" &&
        value.outcome === "excluded" &&
        value.reason === "clock-invalid",
    ),
  );
  assert.ok(
    h.diagnostics.some(
      (value) => value.kind === "conversationTelemetryDropped" && value.reason === "transport",
    ),
  );
  const pending = h.command("pending");
  h.observations.received(pending, 1000);
  h.observations.beginTurn(pending, "thread-1", true);
  h.time(1000 + LOCAL_TTFT_TTL_MS);
  h.observations.expire();
  assert.ok(
    h.diagnostics.some(
      (value) =>
        value.kind === "nativeFirstOutput" &&
        value.commandId === "pending" &&
        value.outcome === "unclosed",
    ),
  );
});

test("capacity and diagnostics are bounded, and production formatting excludes arbitrary content", async (t) => {
  const h = harness(t);
  for (let index = 0; index < 129; index++)
    h.observations.received(h.command(`cmd-${index}`), 1000);
  assert.ok(
    h.diagnostics.some(
      (value) => value.kind === "nativeFirstOutput" && value.reason === "capacity",
    ),
  );
  const line = formatBridgeStateDiagnostic({
    kind: "nativeFirstOutput",
    instanceId: "instance-1",
    observationId: randomUUID(),
    commandId: "/private/credential",
    sessionId: "/private/workspace",
    turnId: "turn-1",
    outcome: "success",
    durationMs: 1.25,
    outputKind: "tool",
  });
  assert.equal(line.includes("/private"), false);
  assert.match(line, /commandId=none; sessionId=none;/);
});

test("CommandRouter hooks preserve native calls and idempotent ACK replay", async (t) => {
  const h = await setup(t);
  const calls: string[] = [];
  h.context.observations = {
    received: () => {
      calls.push("received");
    },
    beginTurn: (_, id, eligible) => {
      calls.push(`begin:${id}:${eligible}`);
    },
    acceptTurn: () => {
      calls.push("bound");
    },
    decided: () => {
      calls.push("ack");
    },
  };
  const input = h.command("sendText", { text: "fixture text" });
  const ack = await h.execute(input);
  assert.equal(ack.status, "accepted");
  assert.deepEqual(calls, ["received", "begin:thread-1:true", "bound", "ack"]);
  assert.deepEqual(await h.execute(input), ack);
  assert.equal(calls.length, 4);
  assert.deepEqual(h.rpc.methods(), ["turn/start"]);
});

test("late turn-start is emitted before buffered output and terminal facts", async (t) => {
  const h = harness(t);
  const input = h.command();
  h.observations.received(input, 1000);
  h.observations.beginTurn(input, "thread-1", true);
  h.event(
    "item/agentMessage/delta",
    {
      threadId: "thread-1",
      turnId: "turn-live",
      itemId: "answer",
      delta: "text",
    },
    1100,
  );
  h.start();
  h.event("turn/completed", {
    threadId: "thread-1",
    turn: { id: "turn-live", status: "completed" },
  });
  h.observations.acceptTurn(input, "thread-1", { turn: { id: "turn-live" } });
  await h.observations.settled();
  assert.deepEqual(
    h.facts.map((fact) => fact.kind),
    ["turn.started", "stream.chunk", "turn.terminal"],
  );
  assert.equal(h.diagnostics[0]?.kind, "nativeFirstOutput");
  const terminal = h.facts.at(-1);
  assert.ok(terminal?.kind === "turn.terminal");
  assert.equal(
    terminal.toolCallCount,
    undefined,
    "missing tool notifications cannot prove a zero count",
  );
});

test("stale and rejected inputs are excluded, not native execution failures", (t) => {
  const h = harness(t);
  for (const status of ["stale", "rejected"] as const) {
    const input = h.command(status);
    h.observations.received(input, 1000);
    h.observations.decided(input, { commandId: input.commandId, status, revisionAtDecision: 0 });
  }
  assert.ok(
    h.diagnostics.every(
      (value) => value.kind === "nativeFirstOutput" && value.outcome === "excluded",
    ),
  );
});

test("a blocked fact sink has bounded capacity and does not block observing native output", async (t) => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let delivered = 0;
  const h = harness(t, async () => {
    delivered++;
    await gate;
  });
  h.bind(h.command());
  h.start();
  for (let index = 0; index < 700; index++)
    h.event(
      "item/agentMessage/delta",
      {
        threadId: "thread-1",
        turnId: "turn-live",
        itemId: "answer",
        delta: "x",
      },
      1100 + index,
    );
  assert.equal(delivered, 1);
  assert.ok(
    h.diagnostics.some(
      (value) => value.kind === "nativeFirstOutput" && value.outcome === "success",
    ),
  );
  assert.ok(
    h.diagnostics.some(
      (value) => value.kind === "conversationTelemetryDropped" && value.reason === "capacity",
    ),
  );
  release();
  await h.observations.settled();
  assert.equal(delivered, 513);
});

test("same turn IDs stay isolated by session and event IDs stay isolated by instance", async (t) => {
  const h = harness(t);
  h.store.markStarted({ ...threadFixture(), id: "thread-2" });
  for (const sessionId of ["thread-1", "thread-2"]) {
    const input = h.command(`command-${sessionId}`, sessionId);
    h.observations.received(input, 1000);
    h.observations.beginTurn(input, sessionId, true);
    h.observations.acceptTurn(input, sessionId, { turn: { id: "shared-turn" } });
    h.event("turn/started", { threadId: sessionId, turn: { id: "shared-turn" } });
    h.event(
      "item/agentMessage/delta",
      { threadId: sessionId, turnId: "shared-turn", itemId: "answer", delta: "x" },
      1100,
    );
  }
  await h.observations.settled();
  assert.ok(h.facts.every((fact) => fact.sourceCommandId === `command-${fact.sessionId}`));
  const restarted: ConversationTelemetryFact[] = [];
  const observer = new BridgeConversationObservations({
    instanceId: "instance-2",
    state: (id) => h.store.get(id),
    notify: async (fact) => {
      restarted.push(fact);
    },
  });
  t.after(() => observer.close());
  const input = h.command("restart");
  observer.received(input, 1000);
  observer.beginTurn(input, "thread-1", true);
  observer.acceptTurn(input, "thread-1", { turn: { id: "shared-turn" } });
  observer.observe(
    { method: "turn/started", params: { threadId: "thread-1", turn: { id: "shared-turn" } } },
    1000,
  );
  await observer.settled();
  assert.ok(restarted.every((fact) => !h.facts.some((old) => old.eventId === fact.eventId)));
});

test("observation port exceptions cannot fail admitted commands or ledger replay", async (t) => {
  const h = await setup(t);
  const fail = () => {
    throw new Error("observation only");
  };
  h.context.observations = { received: fail, beginTurn: fail, acceptTurn: fail, decided: fail };
  const input = h.command("sendText", { text: "fixture" });
  const ack = await h.execute(input);
  assert.equal(ack.status, "accepted");
  assert.deepEqual(await h.execute(input), ack);
  assert.deepEqual(h.rpc.methods(), ["turn/start"]);
});
