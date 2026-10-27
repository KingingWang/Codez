import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  encodeTopicWireFramesWithBytes,
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
} from "@codez/shared/codez-protocol-v4";

export interface BridgeSubscriptionsOptions {
  workspaceId: string;
  /** Must authorize conversation ownership in this workspace before returning its snapshot. */
  snapshot(
    topic: string,
    additionalDirectories?: string[],
  ): Promise<{ snapshot: unknown; seq: number; logEpoch: string }>;
  /** Resolves after the notification is written; rejects on transport failure. */
  notify(method: string, params: unknown): Promise<void>;
  /**
   * 判定「确定性且可恢复的投影故障」（当前只有行预算超限）。由 BridgeRuntime 注入，
   * publisher 保持纯传输层，不依赖投影实现里的具体错误类型。
   */
  recoverableProjectionFault?(error: unknown): boolean;
}
export interface BridgeSubscriptionResponse {
  result: unknown;
  afterResponse: () => Promise<void>;
}
export const MAX_BRIDGE_SUBSCRIPTIONS = 32;
type Mode = V4ConversationSubscribeParams["clientMode"];
type Batch = { frames: RoutedTopicWireFrame[]; bytes: number; seq: number; logEpoch: string };
type SnapshotRead = { snapshot: unknown; seq: number; logEpoch: string };
/** 单轮 changed(topic) 扇出内的 resolver 读取合并表；不跨调用复用。 */
type SharedReads = Map<string, Promise<SnapshotRead>>;
/**
 * 会话状态版本，与 BridgeSnapshots 的 in-flight key（epoch/revision/seq）同口径。
 * 由 BridgeRuntime 从 ThreadStateStore 读出后随 changed() 传入，作为粘性故障的重新武装条件。
 */
export interface ConversationStateVersion {
  epoch: string;
  revision: number;
  seq: number;
}
interface Route {
  id: string;
  key: string;
  topic: string;
  additionalDirectories?: string[];
  connectionId: string;
  clientMode: Mode;
  version: number;
  ordinal: number;
  blocked: boolean;
  dirty: boolean;
  pending?: Batch;
  running?: Promise<void>;
  last?: { seq: number; logEpoch: string };
  /**
   * 粘性投影故障：同一 state 版本内只投影并投递一次，之后 flush 直接短路，
   * 直到 changed() 观察到版本前进（或路由被 prepare/remove 重建）。
   */
  fault?: { error: unknown; version: ConversationStateVersion };
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

/** 缺版本（无法证明状态未变）时一律视为不同版本，宁可重投影也不能把会话永久粘死。 */
function sameStateVersion(
  recorded: ConversationStateVersion,
  next: ConversationStateVersion | undefined,
): boolean {
  return (
    next !== undefined &&
    recorded.epoch === next.epoch &&
    recorded.revision === next.revision &&
    recorded.seq === next.seq
  );
}

/**
 * 共享读取的合并键：同一 topic 但 additionalDirectories 不同的 route 必须各自读取，
 * 因为 resolver 会用它们加载不同的 workspace roots。规范化（去重 + 排序）后比较，
 * 与 BridgeSnapshots 的 in-flight key 口径一致。
 */
function snapshotReadKey(topic: string, additionalDirectories?: readonly string[]): string {
  if (!additionalDirectories || additionalDirectories.length === 0) return topic;
  return `${topic}\u0000${[...new Set(additionalDirectories)].sort().join("\u0001")}`;
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
      additionalDirectories: p.additionalDirectories,
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

  async changed(topic: string, stateVersion?: ConversationStateVersion): Promise<void> {
    if (this.closed) return;
    this.validateTopic(topic);
    const routes = [...this.routes.values()].filter((route) => route.topic === topic);
    for (const route of routes) {
      // 修复原因：确定性投影故障（行预算超限）在同一 state 版本内重跑必然再次失败，而超限
      // item 已经持久化在原生 rollout 里；过去每条事件都无条件置 dirty，于是每条后续事件都会
      // 重放一次全史投影并重复投递同一个故障。
      // 修复依据：specs/codex-desktop-adapter.md:364-367 要求可恢复故障不终止 bridge，
      // :392-393 又要求它仍然显式失败、不得静默截断。因此按 state 版本粘住：版本未前进就既不
      // 置 dirty 也不重投影（故障已在首次投递时交给调用方），版本前进或无法证明版本相同则立即
      // 重新武装，保证历史真的变化后（例如超限 item 被原生裁剪）会话能自愈。
      if (route.fault && sameStateVersion(route.fault.version, stateVersion)) continue;
      route.fault = undefined;
      route.dirty = true;
    }
    // 一次 changed 扇出里，相同 (topic, additionalDirectories) 的多条 route 共享一次
    // resolver 读取：32 个订阅者同时刷新同一会话时逻辑投影仍然只跑一次。
    // 合并表是本轮局部的——新的 changed 或 state 变化后的重刷一定重新读取，
    // 独立的 subscribe()/resync() 也绝不挂到这里（见 prepare/encode 不传 sharedReads）。
    const sharedReads: SharedReads = new Map();
    await Promise.all(routes.map((route) => this.flush(route, sharedReads, stateVersion)));
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
    // 路由被替换/关闭时粘性故障随路由一起消失：新路由必须重新尝试投影并显式失败。
    route.fault = undefined;
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
    // subscribe/resync 是显式读取入口，必须真实尝试一次投影：粘性故障只约束 changed() 推送
    // 路径，否则客户端永远拿不到「该会话当前不可投影」的显式拒绝。
    route.fault = undefined;
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
    sharedReads?: SharedReads,
  ): Promise<Batch | undefined> {
    const raw = await this.readSnapshot(route, sharedReads);
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
    // 编码时已经按真实 envelope 测过每个物理帧，直接复用计量结果；
    // 以前这里对同一批帧再跑一遍 JSON.stringify + TextEncoder（最大的那段 snapshot 序列化两次）。
    const encoded = encodeTopicWireFramesWithBytes(parsed.data, {
      deliveryKind,
      topic: route.topic,
      subscriptionId: route.id,
      logicalFrameId: randomUUID(),
      logicalFrameOrdinal: ++route.ordinal,
      measurePhysicalFrameBytes: (frame) => measureTopicNotificationEnvelopeBytes(frame).maxBytes,
    });
    const frames = encoded.frames.map((frame) => routedTopicWireFrameSchema.parse(frame));
    const bytes = encoded.totalBytes;
    if (this.stagedBytes + bytes > PROTOCOL_V4_LIMITS.logicalFrameAssemblyMaxStagedBytes)
      fail(-32000, "Subscription staged byte limit exceeded");
    this.stagedBytes += bytes;
    return { frames, bytes, seq, logEpoch };
  }

  /**
   * resolver 读取：changed 扇出内按 (topic, additionalDirectories) 合并，其余入口直连。
   * route 在 await 期间被 replace/close 只影响它自己（encode 随后按 version 复核），
   * 共享同一次读取的其他活跃 route 不受影响。
   */
  private readSnapshot(route: Route, sharedReads?: SharedReads): Promise<SnapshotRead> {
    if (!sharedReads) return this.options.snapshot(route.topic, route.additionalDirectories);
    const key = snapshotReadKey(route.topic, route.additionalDirectories);
    const existing = sharedReads.get(key);
    if (existing) return existing;
    // async IIFE：resolver 同步抛错也转成 rejection，保证登记进合并表的 promise 一定有人处理。
    const pending = (async () => this.options.snapshot(route.topic, route.additionalDirectories))();
    sharedReads.set(key, pending);
    return pending;
  }

  private flush(
    route: Route,
    sharedReads?: SharedReads,
    stateVersion?: ConversationStateVersion,
  ): Promise<void> {
    // 粘性故障短路：不重投影，也不重复投递；changed() 在 state 版本前进时清除它。
    if (route.fault) return Promise.resolve();
    if (route.running) return route.running;
    if (!this.writable(route)) return Promise.resolve();
    // 合并并发 changed，不为每个事件挂一个待发送任务；只允许一个有界在途帧。
    const running = Promise.resolve().then(() => this.drain(route, sharedReads));
    const completed = running.then(
      () => {
        route.running = undefined;
        // 续跑属于新的一轮：不再复用上一次扇出的共享读取。
        if (this.writable(route) && (route.pending || route.dirty)) return this.flush(route);
      },
      (error: unknown) => {
        route.running = undefined;
        if (this.active(route)) {
          // 可恢复投影故障按 state 版本粘住（见 changed() 的原因/依据）；其余错误保持原有
          // 语义：置 dirty 让下一轮重投，并把拒绝原样冒泡给调用方（native-event /
          // sessions-index / workspace-config 的 fatal 判定不受影响）。
          if (stateVersion && this.options.recoverableProjectionFault?.(error))
            route.fault = { error, version: stateVersion };
          else route.dirty = true;
        }
        throw error;
      },
    );
    route.running = completed;
    return completed;
  }

  private async drain(route: Route, sharedReads?: SharedReads): Promise<void> {
    let reads = sharedReads;
    while (this.writable(route) && (route.pending || route.dirty)) {
      const version = route.version;
      let batch = route.pending;
      route.pending = undefined;
      if (!batch) {
        route.dirty = false;
        batch = await this.encode(route, "recovery", version, reads);
      }
      // 共享读取只代表本轮扇出时刻的 state；同一 drain 的后续迭代必须读最新值。
      reads = undefined;
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
