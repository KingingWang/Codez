import assert from "node:assert/strict";
import test from "node:test";
import {
  PROTOCOL_V4_LIMITS,
  routedTopicFrameSchema,
  routedTopicWireFrameSchema,
  TopicWireFrameAssembler,
  measureTopicNotificationEnvelopeBytes,
  v4ConversationSubscribeResultSchema,
  v4ConversationResyncResultSchema,
  type RoutedTopicWireFrame,
} from "@codez/shared/codez-protocol-v4";
import { BridgeSubscriptions, MAX_BRIDGE_SUBSCRIPTIONS } from "../src/subscriptions.js";
import { projectThread } from "../src/projection.js";
import { threadFixture } from "./projection-fixtures.test.js";

// Executable spec for adapter cases 7/9: ACK gates delivery, connection/topic owns a
// route, and both profiles recover from authority without pretending to retain a log.
const topic = "conversation/thread-1";
const params = { topic, connectionId: "connection-1", clientMode: "desktop-continuous" };
const deferred = <T = void>() => Promise.withResolvers<T>();
function fixture() {
  const frames: RoutedTopicWireFrame[] = [];
  const state = { seq: 1, epoch: "epoch-1", reads: 0, padding: "" };
  const options = {
    workspaceId: "workspace-1",
    async snapshot(key: string) {
      state.reads++;
      const snapshot = key.startsWith("conversation/")
        ? projectThread(
            { ...threadFixture(), id: key.slice(13), name: state.padding || "Title" },
            {
              workspacePath: "/workspace",
              logEpoch: state.epoch,
              seq: state.seq,
              revision: state.seq,
            },
          )
        : key.startsWith("sessions-index/")
          ? { protocolVersion: 1, workspaceId: "workspace-1", logEpoch: state.epoch, sessions: [] }
          : {
              protocolVersion: 1,
              workspaceId: "workspace-1",
              logEpoch: state.epoch,
              config: { configOptions: [], slashCommands: [] },
            };
      return { snapshot, seq: state.seq, logEpoch: state.epoch };
    },
    async notify(method: string, value: unknown) {
      assert.equal(method, "v4/conversation/frame");
      const frame = routedTopicWireFrameSchema.parse(value);
      assert.ok(
        measureTopicNotificationEnvelopeBytes(frame).maxBytes <= PROTOCOL_V4_LIMITS.maxFrameBytes,
      );
      frames.push(frame);
    },
  };
  const bridge = new BridgeSubscriptions(options);
  return { bridge, options, state, frames };
}
function ack(result: unknown) {
  return v4ConversationSubscribeResultSchema.parse(result).ack;
}
function owner(subscriptionId: string) {
  return { topic, connectionId: params.connectionId, subscriptionId };
}

test("ACK-only result precedes initial notification, callback is idempotent", async () => {
  const { bridge, frames } = fixture();
  const response = await bridge.subscribe(params);
  assert.deepEqual(Object.keys(response.result as object), ["ack"]);
  assert.equal(ack(response.result).mode, "snapshot");
  assert.equal(frames.length, 0);
  await response.afterResponse();
  assert.equal(frames.length, 1);
  assert.equal(frames[0]?.deliveryKind, "initial");
  assert.equal(frames[0]?.logicalFrameOrdinal, 1);
  await response.afterResponse();
  assert.equal(frames.length, 1);
});

test("changes before ACK are gated, then flushed at increasing ordinals", async () => {
  const { bridge, frames, state } = fixture();
  const response = await bridge.subscribe(params);
  state.seq = 2;
  await bridge.changed(topic);
  assert.equal(frames.length, 0);
  await response.afterResponse();
  assert.equal(frames.at(-1)?.logicalFrameOrdinal, 2);
  const latest = frames.at(-1)!;
  assert.equal(latest.deliveryKind, "recovery");
  assert.equal(latest.kind === "complete" && latest.frame.toSeq, 2);
});

test("all topics and both client modes use snapshot fallback even with a matching base", async () => {
  for (const clientMode of ["desktop-continuous", "web-remote-replayable"]) {
    const { bridge, frames } = fixture();
    for (const key of [topic, "sessions-index/workspace-1", "workspace-config/workspace-1"]) {
      const response = await bridge.subscribe({
        ...params,
        topic: key,
        clientMode,
        base: { seq: 1, logEpoch: "epoch-1" },
      });
      assert.equal(ack(response.result).mode, "snapshot");
      await response.afterResponse();
    }
    assert.equal(frames.length, 3);
  }
});

test("replacement invalidates old callbacks and stale resync, not other connections", async () => {
  const { bridge, frames } = fixture();
  const old = await bridge.subscribe(params);
  const replacement = await bridge.subscribe(params);
  const other = await bridge.subscribe({ ...params, connectionId: "other" });
  await old.afterResponse();
  assert.equal(frames.length, 0);
  await assert.rejects(bridge.resync({ ...owner(ack(old.result).subscriptionId), base: null }), {
    code: -32004,
  });
  await replacement.afterResponse();
  await other.afterResponse();
  assert.equal(new Set(frames.map((frame) => frame.subscriptionId)).size, 2);
});

test("resync keeps subscription identity, gates frames and supersedes stale callbacks", async () => {
  const { bridge, frames, state } = fixture();
  const initial = await bridge.subscribe(params);
  await initial.afterResponse();
  const subscriptionId = ack(initial.result).subscriptionId;
  state.seq = 2;
  const first = await bridge.resync({
    ...owner(subscriptionId),
    base: { seq: 999, logEpoch: "old" },
  });
  state.seq = 3;
  const latest = await bridge.resync({ ...owner(subscriptionId), base: null, forceSnapshot: true });
  assert.equal(
    v4ConversationResyncResultSchema.parse(latest.result).ack.subscriptionId,
    subscriptionId,
  );
  await first.afterResponse();
  assert.equal(frames.length, 1);
  await latest.afterResponse();
  assert.equal(frames.at(-1)?.deliveryKind, "recovery");
  assert.ok(frames.at(-1)!.logicalFrameOrdinal > frames[0]!.logicalFrameOrdinal);
});

test("saturation coalesces without reading snapshots; drained sends one fresh recovery", async () => {
  const { bridge, state, frames } = fixture();
  const initial = await bridge.subscribe(params);
  await initial.afterResponse();
  await bridge.flow({ connectionId: params.connectionId, state: "saturated" });
  for (let i = 2; i < 1002; i++) {
    state.seq = i;
    await bridge.changed(topic);
  }
  assert.equal(state.reads, 1);
  assert.equal(frames.length, 1);
  await bridge.flow({ connectionId: params.connectionId, state: "drained" });
  assert.equal(state.reads, 2);
  assert.equal(frames.length, 2);
  assert.equal(frames[1]?.kind === "complete" && frames[1].frame.toSeq, 1001);
  assert.equal(frames[1]?.deliveryKind, "recovery");
});

test("oversized snapshots split into bounded physical frames and reassemble", async () => {
  const { bridge, state, frames } = fixture();
  state.padding = "汉🙂".repeat(160_000);
  const response = await bridge.subscribe(params);
  assert.equal(frames.length, 0);
  await response.afterResponse();
  assert.ok(frames.length > 1);
  assert.ok(frames.every((frame) => frame.kind === "fragment" && frame.logicalFrameOrdinal === 1));
  const assembler = new TopicWireFrameAssembler(routedTopicFrameSchema);
  const events = frames.flatMap((frame) => assembler.accept(frame));
  assert.equal(events.length, 1);
  assert.equal(events[0]?.kind, "complete");
});

test("scope mismatches and invalid requests fail before snapshot access", async () => {
  const { bridge, state } = fixture();
  for (const bad of [
    { ...params, topic: "sessions-index/other" },
    { ...params, topic: "workspace-config/other" },
    { ...params, topic: "unknown/value" },
    { ...params, connectionId: "" },
    {
      ...params,
      workspace: { workspacePath: "/workspace", workspaceKey: "other", workspaceIdentity: "other" },
    },
  ])
    await assert.rejects(bridge.subscribe(bad));
  assert.equal(state.reads, 0);
  const initial = await bridge.subscribe(params);
  const subscriptionId = ack(initial.result).subscriptionId;
  await assert.rejects(
    bridge.resync({ ...owner(subscriptionId), connectionId: "other", base: null }),
    { code: -32004 },
  );
  await assert.rejects(
    Promise.resolve().then(() =>
      bridge.unsubscribe({ ...owner(subscriptionId), topic: "conversation/other" }),
    ),
    { code: -32004 },
  );
  await assert.rejects(
    bridge.subscribe({
      ...params,
      topic: "conversation/other",
      clientMode: "web-remote-replayable",
    }),
  );
});

test("unsubscribe, connection close and close discard pending callbacks", async () => {
  const { bridge, frames } = fixture();
  const first = await bridge.subscribe(params);
  await bridge.unsubscribe(owner(ack(first.result).subscriptionId));
  await first.afterResponse();
  const second = await bridge.subscribe(params);
  await bridge.flow({ connectionId: params.connectionId, state: "closed" });
  await second.afterResponse();
  const third = await bridge.subscribe(params);
  bridge.close();
  bridge.close();
  await third.afterResponse();
  await bridge.changed(topic);
  assert.equal(frames.length, 0);
  await assert.rejects(bridge.subscribe(params));
});

test("route limit includes pending reservations; replacement does not consume capacity", async () => {
  const { bridge } = fixture();
  for (let i = 0; i < MAX_BRIDGE_SUBSCRIPTIONS; i++)
    await bridge.subscribe({ ...params, topic: `conversation/${i}` });
  await assert.rejects(bridge.subscribe({ ...params, topic: "conversation/overflow" }), {
    code: -32000,
  });
  const replacement = await bridge.subscribe({ ...params, topic: "conversation/0" });
  await bridge.unsubscribe({
    ...owner(ack(replacement.result).subscriptionId),
    topic: "conversation/0",
  });
  await bridge.subscribe({ ...params, topic: "conversation/overflow" });
});

test("replacement while snapshot is pending cannot revive a stale reservation", async () => {
  const { bridge, options, frames } = fixture();
  const original = options.snapshot;
  const gate = deferred();
  let first = true;
  options.snapshot = async (key) => {
    if (first) {
      first = false;
      await gate.promise;
    }
    return original(key);
  };
  const stale = bridge.subscribe(params);
  const rejected = assert.rejects(stale, { code: -32004 });
  const current = await bridge.subscribe(params);
  gate.resolve();
  await rejected;
  await current.afterResponse();
  assert.equal(frames.length, 1);
  assert.equal(frames[0]?.subscriptionId, ack(current.result).subscriptionId);
});

test("saturation before initial release discards stale initial and recovers after ACK", async () => {
  const { bridge, frames, state } = fixture();
  await bridge.flow({ connectionId: params.connectionId, state: "saturated" });
  const initial = await bridge.subscribe(params);
  await initial.afterResponse();
  state.seq = 8;
  await bridge.changed(topic);
  assert.equal(frames.length, 0);
  await bridge.flow({ connectionId: params.connectionId, state: "drained" });
  assert.equal(frames.length, 1);
  assert.equal(frames[0]?.deliveryKind, "recovery");
  assert.equal(frames[0]?.kind === "complete" && frames[0].frame.toSeq, 8);
});

test("resync behind an in-flight notify resolves only after its gated recovery flush", async () => {
  const { bridge, options, frames, state } = fixture();
  const gate = deferred();
  const started = deferred();
  const notify = options.notify;
  options.notify = async (method, value) => {
    if (!frames.length) {
      started.resolve();
      await gate.promise;
    }
    await notify(method, value);
  };
  const initial = await bridge.subscribe(params);
  const flushing = initial.afterResponse();
  await started.promise;
  state.seq = 3;
  const recovery = await bridge.resync({
    ...owner(ack(initial.result).subscriptionId),
    base: null,
  });
  const recovered = recovery.afterResponse();
  gate.resolve();
  await recovered;
  const latest = frames.at(-1);
  assert.equal(latest?.kind === "complete" && latest.frame.toSeq, 3);
  await flushing;
});

test("notify failures release staging and recover on drain without automatic write retries", async () => {
  const { bridge, options, frames } = fixture();
  const notify = options.notify;
  let calls = 0;
  options.notify = async () => {
    calls++;
    throw new Error("disconnected");
  };
  const initial = await bridge.subscribe(params);
  await assert.rejects(initial.afterResponse(), /disconnected/);
  assert.equal(calls, 1);
  options.notify = notify;
  await bridge.flow({ connectionId: params.connectionId, state: "drained" });
  assert.equal(frames[0]?.deliveryKind, "recovery");
  assert.equal(frames[0]?.logicalFrameOrdinal, 2);
});

test("resolver identity/watermark mismatches reject before ACK; same-epoch regression fails", async () => {
  const { bridge, options, frames, state } = fixture();
  const original = options.snapshot;
  options.snapshot = async (key) => ({ ...(await original(key)), logEpoch: "wrong" });
  await assert.rejects(bridge.subscribe(params), { code: -32000 });
  assert.equal(frames.length, 0);
  options.snapshot = original;
  const initial = await bridge.subscribe(params);
  await initial.afterResponse();
  state.seq = 0;
  await assert.rejects(bridge.changed(topic), { code: -32000 });
  state.epoch = "new-epoch";
  await bridge.changed(topic);
  const latest = frames.at(-1);
  assert.equal(latest?.kind === "complete" && latest.frame.toSeq, 0);
});

test("saturation between fragments resumes with a higher-ordinal atomic recovery", async () => {
  const { bridge, options, frames, state } = fixture();
  state.padding = "x".repeat(1_100_000);
  const notify = options.notify;
  options.notify = async (method, value) => {
    await notify(method, value);
    if (frames.length === 1)
      await bridge.flow({ connectionId: params.connectionId, state: "saturated" });
  };
  const response = await bridge.subscribe(params);
  await response.afterResponse();
  assert.equal(frames.length, 1);
  assert.equal(frames[0]?.kind, "fragment");
  state.padding = "";
  state.seq = 2;
  await bridge.flow({ connectionId: params.connectionId, state: "drained" });
  const assembler = new TopicWireFrameAssembler(routedTopicFrameSchema);
  const events = frames.flatMap((frame) => assembler.accept(frame));
  assert.equal(events.length, 1);
  assert.equal(events[0]?.kind, "complete");
  assert.equal(frames.at(-1)?.deliveryKind, "recovery");
  assert.ok(frames.at(-1)!.logicalFrameOrdinal > frames[0]!.logicalFrameOrdinal);
});

test("close between encoding and ACK reservation cannot publish a stale ACK", async () => {
  const { bridge, options, frames } = fixture();
  const original = options.snapshot;
  options.snapshot = async (key) => {
    const result = await original(key);
    queueMicrotask(() => queueMicrotask(() => bridge.close()));
    return result;
  };
  await assert.rejects(bridge.subscribe(params), { code: -32004 });
  assert.equal(frames.length, 0);
});
