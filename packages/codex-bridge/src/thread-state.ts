import { randomUUID } from "node:crypto";
import type { CodexNotification, CodexRpcPort } from "./contract.js";
import { array, object, string, type JsonObject } from "./json.js";
import { decorateNativeThread } from "./command-input.js";
import {
  canonicalExecutionPath,
  normalizeExecutionSpelling,
  sameExecutionPath,
} from "./execution-path.js";
import { mergeNativeTurn } from "./merge-turn.js";
import { canonicalNativeThreads } from "./projection.js";

export class DeletedThreadError extends Error {
  constructor() {
    super("Thread was deleted; refresh the session list");
  }
}

export interface ThreadProjectionState {
  thread: JsonObject;
  queue: unknown[];
  revision: number;
  seq: number;
  epoch: string;
}

/** A disposable projection cache. All durable facts and queue admission belong to Codex. */
export class ThreadStateStore {
  private readonly states = new Map<string, ThreadProjectionState>();
  private readonly listeners = new Set<(threadId: string) => void>();
  private readonly loads = new Map<string, Promise<ThreadProjectionState>>();
  private readonly loaded = new Set<string>();
  private readonly deleted = new Set<string>();
  private readonly completedItems = new Set<string>();
  /** 同步通知路径无法 await，只能比对已解析出的工作区拼写集合。 */
  private readonly workspaceSpellings = new Set<string>();
  private canonicalCwd?: Promise<string>;

  constructor(
    private readonly rpc: CodexRpcPort,
    readonly cwd: string,
  ) {
    this.workspaceSpellings.add(normalizeExecutionSpelling(cwd));
    // 规范化解析不会 reject（失败退回原拼写）；提前解析让别名拼写的实时事件也能归属。
    void this.executionCwd();
  }

  private executionCwd(): Promise<string> {
    this.canonicalCwd ??= canonicalExecutionPath(this.cwd).then((canonical) => {
      this.workspaceSpellings.add(canonical);
      return canonical;
    });
    return this.canonicalCwd;
  }

  private inWorkspace(value: unknown): boolean {
    return (
      typeof value === "string" && this.workspaceSpellings.has(normalizeExecutionSpelling(value))
    );
  }

  onChange(listener: (threadId: string) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  get(id: string): ThreadProjectionState | undefined {
    return this.states.get(id);
  }

  remove(id: string): void {
    this.deleted.add(id);
    this.states.delete(id);
    this.loaded.delete(id);
  }

  private assertAvailable(id: string): void {
    if (this.deleted.has(id)) throw new DeletedThreadError();
  }

  put(value: unknown): ThreadProjectionState {
    const thread = object(value);
    const id = string(thread.id);
    this.assertAvailable(id);
    const previous = this.states.get(id);
    const state = previous ?? { thread, queue: [], revision: 0, seq: 0, epoch: randomUUID() };
    state.thread = { ...previous?.thread, ...thread };
    this.states.set(id, state);
    this.touch(id);
    return state;
  }

  touch(id: string): void {
    const state = this.states.get(id);
    if (!state) return;
    state.revision += 1;
    state.seq += 1;
    for (const listener of this.listeners) listener(id);
  }

  async ensure(id: string): Promise<ThreadProjectionState> {
    this.assertAvailable(id);
    const existing = this.states.get(id);
    if (existing && this.loaded.has(id)) return existing;
    const loading = this.loads.get(id);
    if (loading) return loading;
    const pending = this.load(id).finally(() => this.loads.delete(id));
    this.loads.set(id, pending);
    return pending;
  }

  private async load(id: string): Promise<ThreadProjectionState> {
    const read = object(await this.rpc.request("thread/read", { threadId: id }));
    this.assertAvailable(id);
    const metadata = object(read.thread);
    // 路径不是远端身份，但本进程只能操作其 Host 已授权工作区中的线程。
    // 原生 thread/read 返回物理路径；Host 可能传入符号链接或 Windows 短名拼写，
    // 字符串相等会把同一目录的会话误判成别的工作区，导致恢复历史失败。
    if (!(await sameExecutionPath(metadata.cwd, this.cwd)))
      throw new Error("Thread belongs to a different workspace");
    const resumed = object(await this.rpc.request("thread/resume", { threadId: id }));
    this.assertAvailable(id);
    const thread = decorateNativeThread(resumed);
    const turns: unknown[] = [];
    let cursor: string | undefined;
    const seen = new Set<string>();
    do {
      const page = object(
        await this.rpc.request("thread/turns/list", {
          threadId: id,
          cursor,
          limit: 100,
          sortDirection: "asc",
          itemsView: "full",
        }),
      );
      turns.push(...array(page.data));
      cursor = typeof page.nextCursor === "string" ? page.nextCursor : undefined;
      if (cursor && seen.has(cursor)) throw new Error("Repeated native history cursor");
      if (cursor) seen.add(cursor);
    } while (cursor);
    // resume 到分页读取期间的通知不能被旧历史覆盖；同 id 的 live turn 优先。
    const live = array(this.states.get(id)?.thread.turns);
    const merged = new Map(turns.map((turn) => [string(object(turn).id), turn]));
    for (const turn of live) {
      const key = string(object(turn).id);
      const old = merged.get(key);
      merged.set(key, old ? mergeNativeTurn(object(old), object(turn)) : turn);
    }
    thread.turns = [...merged.values()];
    const state = this.put(thread);
    this.loaded.add(id);
    await this.refreshQueue(id);
    this.assertAvailable(id);
    return state;
  }

  markStarted(thread: unknown): ThreadProjectionState {
    const state = this.put(thread);
    this.loaded.add(string(state.thread.id));
    return state;
  }

  acceptTurnResponse(id: string, response: unknown): void {
    const turn = object(object(response).turn);
    const state = this.states.get(id);
    const existing = state && this.turn(state, turn.id);
    // 请求响应可能晚于终态通知；同 id 的终态不能被较旧 admission 响应覆盖。
    if (existing && existing.status !== "inProgress") return;
    this.apply({ method: "turn/started", params: { threadId: id, turn } });
  }

  applySettings(id: string, settings: JsonObject): void {
    const state = this.states.get(id);
    if (!state) return;
    for (const key of ["model", "approvalPolicy", "sandboxPolicy", "collaborationMode"]) {
      if (settings[key] !== undefined) state.thread[key] = settings[key];
    }
    if (settings.effort !== undefined) state.thread.reasoningEffort = settings.effort;
    this.touch(id);
  }

  async reloadAfterHistoryChange(id: string): Promise<ThreadProjectionState> {
    const state = this.states.get(id);
    if (state) {
      state.epoch = randomUUID();
      state.thread.turns = [];
    }
    this.loaded.delete(id);
    return this.ensure(id);
  }

  async refreshQueue(id: string): Promise<void> {
    const state = this.states.get(id);
    if (!state) return;
    const values: unknown[] = [];
    let cursor: string | undefined;
    const seen = new Set<string>();
    do {
      const page = object(
        await this.rpc.request("thread/queue/list", { threadId: id, cursor, limit: 100 }),
      );
      values.push(...array(page.data));
      cursor = typeof page.nextCursor === "string" ? page.nextCursor : undefined;
      if (cursor && seen.has(cursor)) throw new Error("Repeated native queue cursor");
      if (cursor) seen.add(cursor);
    } while (cursor);
    state.queue = values;
    this.touch(id);
  }

  apply(event: CodexNotification): string | undefined {
    const params = object(event.params ?? {});
    if (event.method === "thread/deleted") {
      this.remove(string(params.threadId));
      return;
    }
    if (event.method === "thread/started") {
      const thread = object(params.thread);
      if (!this.inWorkspace(thread.cwd) || this.deleted.has(string(thread.id))) return;
      this.put(thread);
      return string(thread.id);
    }
    const id = typeof params.threadId === "string" ? params.threadId : undefined;
    const state = id ? this.states.get(id) : undefined;
    if (!state || !id) return;
    if (event.method === "thread/status/changed") state.thread.status = params.status;
    else if (event.method === "thread/name/updated") state.thread.name = params.threadName;
    else if (event.method === "thread/settings/updated") {
      const settings = object(params.threadSettings);
      state.thread.model = settings.model;
      state.thread.modelProvider = settings.modelProvider;
      state.thread.reasoningEffort = settings.effort;
      state.thread.sandboxPolicy = settings.sandboxPolicy;
      state.thread.approvalPolicy = settings.approvalPolicy;
      state.thread.collaborationMode = settings.collaborationMode;
    } else if (event.method === "thread/tokenUsage/updated")
      state.thread.tokenUsage = params.tokenUsage;
    else if (event.method === "turn/started" || event.method === "turn/completed") {
      const turn = object(params.turn);
      const turns = array(state.thread.turns);
      const index = turns.findIndex((value) => object(value).id === turn.id);
      // 原生生命周期通知仅携 turn 摘要；当前连接已按 item 事件收齐的内容不能被 summary 清空。
      if (index < 0)
        turns.push({
          ...turn,
          items: array(turn.items),
          itemsView: event.method === "turn/started" ? "full" : turn.itemsView,
        });
      else turns[index] = mergeNativeTurn(object(turns[index]), turn);
      state.thread.turns = turns;
    } else if (event.method === "item/started" || event.method === "item/completed") {
      const turn = this.turn(state, params.turnId);
      if (!turn) return;
      const items = array(turn.items);
      const item = object(params.item);
      const itemKey = JSON.stringify([id, params.turnId, item.id]);
      if (event.method === "item/started" && this.completedItems.has(itemKey)) return;
      if (event.method === "item/completed") this.completedItems.add(itemKey);
      const index = items.findIndex((value) => object(value).id === item.id);
      if (index < 0) items.push(item);
      else items[index] = item;
      turn.items = items;
    } else if (event.method.endsWith("/delta") || event.method.endsWith("Delta")) {
      if (this.completedItems.has(JSON.stringify([id, params.turnId, params.itemId]))) return;
      const turn = this.turn(state, params.turnId);
      const item = array(turn?.items)
        .map(object)
        .find((value) => value.id === params.itemId);
      if (!item || typeof params.delta !== "string") return;
      if (event.method === "item/agentMessage/delta" || event.method === "item/plan/delta") {
        item.text = String(item.text ?? "") + params.delta;
      } else if (event.method === "item/commandExecution/outputDelta") {
        item.aggregatedOutput = String(item.aggregatedOutput ?? "") + params.delta;
      } else if (event.method === "item/reasoning/summaryTextDelta") {
        const summary = array(item.summary);
        const index = typeof params.summaryIndex === "number" ? params.summaryIndex : 0;
        summary[index] = String(summary[index] ?? "") + params.delta;
        item.summary = summary;
      } else return;
    } else return;
    state.thread.updatedAt = Math.floor(Date.now() / 1000);
    this.touch(id);
    return id;
  }

  private turn(state: ThreadProjectionState, id: unknown): JsonObject | undefined {
    return array(state.thread.turns)
      .map(object)
      .find((turn) => turn.id === id);
  }

  async list(): Promise<unknown[]> {
    const threads: unknown[] = [];
    let cursor: string | undefined;
    const seen = new Set<string>();
    do {
      const page = object(
        await this.rpc.request("thread/list", {
          cwd: this.cwd,
          cursor,
          limit: 100,
          // 原生默认只列当前 provider 的交互来源；项目历史应包含 CLI/exec 与桌面
          // 创建的会话，切换 provider 也不能让旧记录消失。空数组显式取消 provider 过滤。
          modelProviders: [],
          sourceKinds: ["cli", "vscode", "exec", "appServer"],
          archived: false,
        }),
      );
      const rows = array(page.data);
      // CLI/exec 落盘的是规范化物理路径；按物理目录过滤，别名拼写才不会把列表判空。
      const owned = await Promise.all(
        rows.map((row) => sameExecutionPath(object(row).cwd, this.cwd)),
      );
      threads.push(...rows.filter((_, index) => owned[index]));
      cursor = typeof page.nextCursor === "string" ? page.nextCursor : undefined;
      if (cursor && seen.has(cursor)) throw new Error("Repeated native thread cursor");
      if (cursor) seen.add(cursor);
    } while (cursor);
    // 分页只收集原始事实；完整校验与同 ID rollout 选择由投影单一 owner 处理。
    return canonicalNativeThreads(threads);
  }
}
