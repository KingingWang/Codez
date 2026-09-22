import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  encodeTopicWireFrames,
  measureTopicNotificationEnvelopeBytes,
  PROTOCOL_V4_LIMITS,
  routedTopicFrameSchema,
  routedTopicWireFrameSchema,
  V4_NOTIFICATIONS,
  v4ConversationSubscribeParamsSchema,
  v4ConversationSubscribeResultSchema,
  v4ConversationResyncParamsSchema,
  v4ConversationResyncResultSchema,
  v4ConversationUnsubscribeParamsSchema,
  v4ConnectionFlowParamsSchema,
  v4ConnectionFlowResultSchema,
  type RoutedTopicWireFrame,
  type V4ConversationSubscribeParams,
} from "@zcode/shared/zcode-protocol-v4";

export interface BridgeSubscriptionsOptions {
  workspaceId: string;
  /** Must authorize conversation ownership in this workspace before returning its snapshot. */
  snapshot(topic: string): Promise<{ snapshot: unknown; seq: number; logEpoch: string }>;
  /** Resolves after the notification is written; rejects on transport failure. */
  notify(method: string, params: unknown): Promise<void>;
}
export interface BridgeSubscriptionResponse {
  result: unknown;
  afterResponse: () => Promise<void>;
}
export const MAX_BRIDGE_SUBSCRIPTIONS = 32;
type Mode = V4ConversationSubscribeParams["clientMode"];
type Batch = { frames: RoutedTopicWireFrame[]; bytes: number; seq: number; logEpoch: string };
interface Route {
  id: string;
  key: string;
  topic: string;
  connectionId: string;
  clientMode: Mode;
  version: number;
  ordinal: number;
  blocked: boolean;
  dirty: boolean;
  pending?: Batch;
  running?: Promise<void>;
  last?: { seq: number; logEpoch: string };
}
const id = z.string().trim().min(1).max(1024);
const subscribeSchema = v4ConversationSubscribeParamsSchema
  .extend({
    connectionId: id,
    topic: z.string().trim().min(1).max(2048),
    base: z
      .object({ logEpoch: id, seq: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER) })
      .strict()
      .optional(),
  })
  .strict();
const snapshotSchema = z.object({
  snapshot: z.unknown(),
  seq: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  logEpoch: id,
});
function fail(code: number, reason: string): never {
  throw Object.assign(new Error(reason), { code, data: { reason } });
}
function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) fail(-32602, "Invalid subscription parameters");
  return result.data;
}

/** Connection-local transport only; snapshots and authorization remain resolver-owned.
 * subscribe/resync → reserve version → snapshot → ACK → afterResponse → initial/recovery.
 * desktop-continuous and web-remote-replayable retain distinct trusted connection modes,
 * but both use snapshot recovery: this publisher has no durable delta/replay log.
 * A saturated route stores one dirty bit, never an event queue. Replacement/close invalidate
 * awaited reads and callbacks; same-sub resync preserves the monotonic physical ordinal.
 */
export class BridgeSubscriptions {
  private readonly routes = new Map<string, Route>();
  private readonly connections = new Map<string, { mode?: Mode; saturated: boolean }>();
  private stagedBytes = 0;
  private closed = false;

  constructor(private readonly options: BridgeSubscriptionsOptions) {
    id.parse(options.workspaceId);
  }

  async subscribe(params: unknown): Promise<BridgeSubscriptionResponse> {
    if (this.closed) fail(-32004, "Subscription publisher is closed");
    const p = parse(subscribeSchema, params);
    this.validateTopic(p.topic);
    if (
      p.workspace &&
      (p.workspace.workspaceIdentity?.trim() || p.workspace.workspacePath) !==
        this.options.workspaceId
    )
      fail(-32602, "Workspace identity does not match this attachment");
    const connection = this.connections.get(p.connectionId);
    if (connection?.mode && connection.mode !== p.clientMode)
      fail(-32602, "Connection clientMode cannot change");
    const key = JSON.stringify([p.connectionId, p.topic]);
    const previous = this.routes.get(key);
    if (!previous && this.routes.size >= MAX_BRIDGE_SUBSCRIPTIONS)
      fail(-32000, "Subscription route limit exceeded");
    if (!connection && this.connections.size >= MAX_BRIDGE_SUBSCRIPTIONS)
      fail(-32000, "Subscription connection limit exceeded");
    if (previous) this.remove(previous);
    this.connections.set(p.connectionId, {
      mode: p.clientMode,
      saturated: connection?.saturated ?? false,
    });
    const route: Route = {
      id: randomUUID(),
      key,
      topic: p.topic,
      connectionId: p.connectionId,
      clientMode: p.clientMode,
      version: 0,
      ordinal: 0,
      blocked: true,
      dirty: false,
    };
    this.routes.set(key, route);
    return this.prepare(route, "initial");
  }

  async resync(params: unknown): Promise<BridgeSubscriptionResponse> {
    const p = parse(v4ConversationResyncParamsSchema, params);
    const route = this.owned(p);
    return this.prepare(route, "recovery");
  }

  unsubscribe(params: unknown): Record<string, never> {
    this.remove(this.owned(parse(v4ConversationUnsubscribeParamsSchema, params)));
    return {};
  }

  async flow(params: unknown): Promise<Record<string, never>> {
    const p = parse(v4ConnectionFlowParamsSchema, params);
    parse(id, p.connectionId);
    if (this.closed) return v4ConnectionFlowResultSchema.parse({});
    const routes = [...this.routes.values()].filter(
      (route) => route.connectionId === p.connectionId,
    );
    if (p.state === "closed") {
      for (const route of routes) this.remove(route);
      this.connections.delete(p.connectionId);
    } else if (p.state === "saturated") {
      if (
        !this.connections.has(p.connectionId) &&
        this.connections.size >= MAX_BRIDGE_SUBSCRIPTIONS
      )
        fail(-32000, "Subscription connection limit exceeded");
      this.connections.set(p.connectionId, {
        ...this.connections.get(p.connectionId),
        saturated: true,
      });
      for (const route of routes) {
        this.releasePending(route);
        route.dirty = true;
      }
    } else {
      const connection = this.connections.get(p.connectionId);
      if (connection) connection.saturated = false;
      await Promise.all(routes.map((route) => this.flush(route)));
    }
    return v4ConnectionFlowResultSchema.parse({});
  }

  async changed(topic: string): Promise<void> {
    if (this.closed) return;
    this.validateTopic(topic);
    const routes = [...this.routes.values()].filter((route) => route.topic === topic);
    for (const route of routes) route.dirty = true;
    await Promise.all(routes.map((route) => this.flush(route)));
  }

  close(): void {
    this.closed = true;
    for (const route of this.routes.values()) this.remove(route);
    this.connections.clear();
  }

  private validateTopic(topic: string): void {
    if (topic.startsWith("conversation/") && topic.slice(13).trim()) return;
    if (
      topic === `sessions-index/${this.options.workspaceId}` ||
      topic === `workspace-config/${this.options.workspaceId}`
    )
      return;
    fail(-32602, "Unsupported topic or workspace scope");
  }

  private owned(p: { topic: string; connectionId: string; subscriptionId: string }): Route {
    const route = this.routes.get(JSON.stringify([p.connectionId, p.topic]));
    if (!route || route.id !== p.subscriptionId || this.closed)
      fail(-32004, "Stale or unowned subscription");
    return route;
  }

  private active(route: Route, version = route.version): boolean {
    return !this.closed && this.routes.get(route.key) === route && route.version === version;
  }

  private writable(route: Route): boolean {
    return (
      this.active(route) && !route.blocked && !this.connections.get(route.connectionId)?.saturated
    );
  }

  private releasePending(route: Route): void {
    if (route.pending) this.stagedBytes -= route.pending.bytes;
    route.pending = undefined;
  }

  private remove(route: Route): void {
    this.releasePending(route);
    if (this.routes.get(route.key) !== route) return;
    this.routes.delete(route.key);
    if (![...this.routes.values()].some((entry) => entry.connectionId === route.connectionId))
      this.connections.delete(route.connectionId);
  }

  private async prepare(
    route: Route,
    kind: "initial" | "recovery",
  ): Promise<BridgeSubscriptionResponse> {
    const version = ++route.version;
    route.blocked = true;
    route.dirty = false;
    this.releasePending(route);
    try {
      const batch = await this.encode(route, kind, version);
      // encode 完成到本 continuation 之间仍可能 close/replace；提交 ACK 前再次核验所有权。
      if (!batch || !this.active(route, version)) {
        if (batch) this.stagedBytes -= batch.bytes;
        fail(-32004, "Subscription reservation was superseded");
      }
      route.pending = batch;
      const schema =
        kind === "initial" ? v4ConversationSubscribeResultSchema : v4ConversationResyncResultSchema;
      const result = schema.parse({
        ack: { subscriptionId: route.id, mode: "snapshot", logEpoch: batch.logEpoch },
      });
      let released = false;
      return {
        result,
        afterResponse: async () => {
          if (released || !this.active(route, version)) return;
          released = true;
          route.blocked = false;
          if (this.connections.get(route.connectionId)?.saturated) {
            this.releasePending(route);
            route.dirty = true;
          }
          await this.flush(route);
        },
      };
    } catch (error) {
      if (this.active(route, version)) this.remove(route);
      throw error;
    }
  }

  private async encode(
    route: Route,
    deliveryKind: "initial" | "recovery",
    version: number,
  ): Promise<Batch | undefined> {
    const raw = await this.options.snapshot(route.topic);
    if (!this.active(route, version)) return;
    const value = snapshotSchema.safeParse(raw);
    if (!value.success) fail(-32000, "Invalid snapshot resolver result");
    const { snapshot, seq, logEpoch } = value.data;
    const parsed = routedTopicFrameSchema.safeParse({
      topic: route.topic,
      subscriptionId: route.id,
      fromSeq: 0,
      toSeq: seq,
      sentAt: Date.now(),
      payload: { kind: "snapshot", snapshot },
    });
    if (!parsed.success || parsed.data.payload.kind !== "snapshot")
      fail(-32000, "Invalid topic snapshot");
    const payload = parsed.data.payload.snapshot;
    if (payload.logEpoch !== logEpoch) fail(-32000, "Snapshot logEpoch mismatch");
    if ("sessionId" in payload) {
      if (route.topic !== `conversation/${payload.sessionId}` || payload.seq !== seq)
        fail(-32000, "Snapshot session or sequence mismatch");
    } else if (payload.workspaceId !== this.options.workspaceId)
      fail(-32000, "Snapshot workspace mismatch");
    if (route.last?.logEpoch === logEpoch && seq < route.last.seq)
      fail(-32000, "Snapshot sequence regressed");
    if (route.ordinal >= Number.MAX_SAFE_INTEGER) fail(-32000, "Subscription ordinal exhausted");
    const frames = encodeTopicWireFrames(parsed.data, {
      deliveryKind,
      topic: route.topic,
      subscriptionId: route.id,
      logicalFrameId: randomUUID(),
      logicalFrameOrdinal: ++route.ordinal,
      measurePhysicalFrameBytes: (frame) => measureTopicNotificationEnvelopeBytes(frame).maxBytes,
    }).map((frame) => routedTopicWireFrameSchema.parse(frame));
    const bytes = frames.reduce(
      (sum, frame) => sum + measureTopicNotificationEnvelopeBytes(frame).maxBytes,
      0,
    );
    if (this.stagedBytes + bytes > PROTOCOL_V4_LIMITS.logicalFrameAssemblyMaxStagedBytes)
      fail(-32000, "Subscription staged byte limit exceeded");
    this.stagedBytes += bytes;
    return { frames, bytes, seq, logEpoch };
  }

  private flush(route: Route): Promise<void> {
    if (route.running) return route.running;
    if (!this.writable(route)) return Promise.resolve();
    // 合并并发 changed，不为每个事件挂一个待发送任务；只允许一个有界在途帧。
    const running = Promise.resolve().then(() => this.drain(route));
    const completed = running.then(
      () => {
        route.running = undefined;
        if (this.writable(route) && (route.pending || route.dirty)) return this.flush(route);
      },
      (error: unknown) => {
        route.running = undefined;
        if (this.active(route)) route.dirty = true;
        throw error;
      },
    );
    route.running = completed;
    return completed;
  }

  private async drain(route: Route): Promise<void> {
    while (this.writable(route) && (route.pending || route.dirty)) {
      const version = route.version;
      let batch = route.pending;
      route.pending = undefined;
      if (!batch) {
        route.dirty = false;
        batch = await this.encode(route, "recovery", version);
      }
      if (!batch) return;
      try {
        for (const frame of batch.frames) {
          // 分片发送之间也检查代际/背压；半帧由更高 ordinal 的 recovery 原子替换。
          if (!this.active(route, version) || !this.writable(route)) {
            if (this.active(route, version)) route.dirty = true;
            return;
          }
          await this.options.notify(V4_NOTIFICATIONS.conversationFrame, frame);
        }
        if (this.active(route, version)) route.last = { seq: batch.seq, logEpoch: batch.logEpoch };
      } finally {
        this.stagedBytes -= batch.bytes;
      }
    }
  }
}
