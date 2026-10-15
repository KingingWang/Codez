import { randomUUID } from "node:crypto";
import type { CodexNotification, CodexRpcPort } from "./contract.js";
import { accumulateNativeTurnUsage } from "./bridge-snapshot-usage.js";
import { array, object, string, type JsonObject } from "./json.js";
import { rememberThreadMode } from "./command-input.js";
import { sameExecutionPath } from "./execution-path.js";
import { mergeNativeTurn } from "./merge-turn.js";
import { paginateNativeRows } from "./native-paging.js";
import { canonicalNativeThreads } from "./projection.js";
import { applyNativeRetry } from "./native-retry-status.js";
import { resolveSelectionSideChatBoundary } from "./selection-side-chat.js";
import {
  attachThreadForLoad,
  parentThreadIdOf,
  parentThreadOwnedByWorkspace,
} from "./thread-load.js";
import { DeletedThreadError, type ThreadProjectionState } from "./thread-state-types.js";
import { upsertTurnPlanUpdate } from "./turn-plan-update.js";

// 本文件仍是 store 词汇表的对外入口（与 projection.ts 的 facade 惯例一致）：
// 定义移到 thread-state-types.ts 只是为了把 store 主体压回 400 行上限内。
export { DeletedThreadError } from "./thread-state-types.js";
export type { ThreadProjectionState } from "./thread-state-types.js";

/** A disposable projection cache. All durable facts and queue admission belong to Codex. */
export class ThreadStateStore {
  private readonly states = new Map<string, ThreadProjectionState>();
  private readonly listeners = new Set<(threadId: string) => void>();
  private readonly loads = new Map<string, Promise<ThreadProjectionState>>();
  private readonly loaded = new Set<string>();
  private readonly deleted = new Set<string>();
  private readonly completedItems = new Set<string>();

  constructor(
    private readonly rpc: CodexRpcPort,
    readonly cwd: string,
  ) {}

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

  /** 只读降级条目是可恢复的：subscribe/resync 前失效它，下一次 ensure 重新 load 并重试 resume。
   * 子代理线程同理——原生未加载（notLoaded）时 bridge 故意不 resume（见 thread-load.ts），
   * 下一次订阅要重新判定它是否已被父线程加载进本进程；已 attach 的条目保持缓存，
   * 否则每次 resync 都要重放整段子线程历史。 */
  invalidate(id: string): void {
    const state = this.states.get(id);
    const recoverable =
      state?.readOnly === "writer-conflict" ||
      (state?.readOnly === "subagent-child" && state.attached !== true);
    if (!recoverable) return;
    this.states.delete(id);
    this.loaded.delete(id);
  }

  /** 子线程原生状态（未加载则 undefined）：只用于把已停止的 child 从 running 里去掉。 */
  nativeThreadStatus(id: string): JsonObject | undefined {
    const thread = this.states.get(id)?.thread;
    return thread ? object(thread.status) : undefined;
  }

  /** subagents 投影 revision 记账：空目录恒 0，非空至少 1，仅语义变化时递增（renderer CAS）。 */
  rememberSubagents(id: string, semantic: string, childCount: number): number {
    const previous = this.states.get(id)?.subagents;
    const revision =
      childCount === 0
        ? 0
        : previous && previous.semantic === semantic
          ? Math.max(1, previous.revision)
          : Math.max(1, (previous?.revision ?? 0) + 1);
    const state = this.states.get(id);
    if (state) state.subagents = { revision, semantic };
    return revision;
  }

  private assertAvailable(id: string): void {
    if (this.deleted.has(id)) throw new DeletedThreadError();
  }

  put(value: unknown): ThreadProjectionState {
    const thread = object(value);
    const id = string(thread.id);
    this.assertAvailable(id);
    const previous = this.states.get(id);
    const state = previous ?? {
      thread,
      queue: [],
      revision: 0,
      seq: 0,
      epoch: randomUUID(),
      apiRetry: null,
    };
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
    // 子代理线程身份来自原生 parentThreadId；child id 只由父线程 item 产出，但订阅入口在
    // renderer，所以不能凭 id 放权：cwd 不一致时必须先证明父线程属于本工作区。
    const parentThreadId = parentThreadIdOf(metadata);
    // 路径不是远端身份，但本进程只能操作其 Host 已授权工作区中的线程。
    // 原生 thread/read 返回物理路径；Host 可能传入符号链接或 Windows 短名拼写，
    // 字符串相等会把同一目录的会话误判成别的工作区，导致恢复历史失败。
    // 子代理可能跑在隔离 worktree 里（cwd 与父不同）；只读下钻按父归属放行。
    const ownedByWorkspace = await sameExecutionPath(metadata.cwd, this.cwd);
    const ownedByParent =
      !ownedByWorkspace &&
      parentThreadId !== undefined &&
      (await parentThreadOwnedByWorkspace(
        this.rpc,
        this.states.get(parentThreadId)?.thread,
        this.cwd,
        parentThreadId,
      ));
    if (!ownedByWorkspace && !ownedByParent)
      throw new Error("Thread belongs to a different workspace");
    // attach 与只读降级的分流规则集中在 thread-load.ts（含子代理冷启拒绝路径）。
    const { thread, readOnly, attached } = await attachThreadForLoad({
      rpc: this.rpc,
      id,
      read,
      parentThreadId,
      assertAvailable: () => this.assertAvailable(id),
    });
    const turns = await paginateNativeRows(
      this.rpc,
      "thread/turns/list",
      { threadId: id, sortDirection: "asc", itemsView: "full" },
      "history",
    );
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
    // 辅助对话 child 重建继承裁剪边界；父读取失败 fail-open 不裁剪（spec: codex-selection-side-chat）。
    state.sideChat = await resolveSelectionSideChatBoundary(this.rpc, thread);
    if (readOnly) state.readOnly = readOnly;
    if (parentThreadId) state.attached = attached;
    this.loaded.add(id);
    // 原生 queue/list 不属于已验证的免锁读集合；只读降级跳过队列读取（队列变更命令
    // 已被 deny guard 拦截），避免可选数据让整次只读加载失败。
    if (!readOnly) await this.refreshQueue(id);
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
    void this.apply({ method: "turn/started", params: { threadId: id, turn } });
  }

  applySettings(id: string, settings: JsonObject): void {
    const state = this.states.get(id);
    if (!state) return;
    for (const key of [
      "model",
      "modelProvider",
      "approvalPolicy",
      "approvalsReviewer",
      "sandboxPolicy",
      "collaborationMode",
    ]) {
      if (settings[key] !== undefined) state.thread[key] = settings[key];
    }
    if (settings.effort !== undefined) state.thread.reasoningEffort = settings.effort;
    this.touch(id);
  }

  /** 记住用户显式选择的权限档位（bridge 进程内事实，投影与 queue 守卫共用）。 */
  rememberMode(id: string, mode: string | undefined): void {
    const state = this.states.get(id);
    if (!state) return;
    rememberThreadMode(state.thread, mode);
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
    state.queue = await paginateNativeRows(
      this.rpc,
      "thread/queue/list",
      { threadId: id },
      "queue",
    );
    this.touch(id);
  }

  /** 归属判定需要解析物理路径，所以事件投影是异步的；调用方必须保持事件串行。 */
  async apply(event: CodexNotification): Promise<string | undefined> {
    const params = object(event.params ?? {});
    if (event.method === "thread/deleted") {
      this.remove(string(params.threadId));
      return;
    }
    if (event.method === "thread/started") {
      const thread = object(params.thread);
      // 原生可能回传与 Host 不同的别名拼写（macOS /var、Windows 8.3 短名）；
      // 只有解析物理路径才能判定归属，同步字符串集合会漏掉实时事件。
      if (!(await sameExecutionPath(thread.cwd, this.cwd)) || this.deleted.has(string(thread.id)))
        return;
      this.put(thread);
      return string(thread.id);
    }
    const id = typeof params.threadId === "string" ? params.threadId : undefined;
    const state = id ? this.states.get(id) : undefined;
    if (!state || !id) return;
    if (event.method === "error") {
      const { retry, changed } = applyNativeRetry(state.thread, state.apiRetry, params);
      state.apiRetry = retry;
      if (changed) this.touch(id);
      return id;
    }
    if (event.method === "thread/status/changed") state.thread.status = params.status;
    else if (event.method === "thread/name/updated") state.thread.name = params.threadName;
    else if (event.method === "thread/settings/updated") {
      const settings = object(params.threadSettings);
      state.thread.model = settings.model;
      // 原生报告的 modelProvider 是线程创建期固定身份，不随 catalog per-model
      // 路由更新；bridge 以选择派生的 provider 记录为准（specs/codex-model-provider-grouping.md）。
      state.thread.reasoningEffort = settings.effort;
      state.thread.sandboxPolicy = settings.sandboxPolicy;
      state.thread.approvalPolicy = settings.approvalPolicy;
      // 原生 v2 ThreadSettings 必带 approvalsReviewer；外部（CLI/另一窗口）切 auto_review 需同步投影。
      if (typeof settings.approvalsReviewer === "string")
        state.thread.approvalsReviewer = settings.approvalsReviewer;
      state.thread.collaborationMode = settings.collaborationMode;
    } else if (event.method === "thread/tokenUsage/updated") {
      state.thread.tokenUsage = params.tokenUsage;
      const turns = array(state.thread.turns).map(object);
      const targetTurnId =
        typeof params.turnId === "string"
          ? params.turnId
          : (turns.findLast((candidate) => candidate.status === "inProgress")?.id ??
            turns.at(-1)?.id);
      if (typeof targetTurnId === "string" && targetTurnId.length > 0) {
        const accumulated = accumulateNativeTurnUsage(
          state.turnTokenUsage?.[targetTurnId],
          params.tokenUsage,
        );
        if (accumulated) {
          state.turnTokenUsage = { ...state.turnTokenUsage, [targetTurnId]: accumulated };
        }
      }
    } else if (event.method === "turn/started" || event.method === "turn/completed") {
      const turn = object(params.turn);
      if (
        state.apiRetry &&
        (event.method === "turn/completed"
          ? state.apiRetry.turnId === turn.id
          : state.apiRetry.turnId !== turn.id)
      ) {
        state.apiRetry = null;
      }
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
      if (state.apiRetry?.turnId === params.turnId) state.apiRetry = null;
      const items = array(turn.items);
      const item = object(params.item);
      const itemKey = JSON.stringify([id, params.turnId, item.id]);
      if (event.method === "item/started" && this.completedItems.has(itemKey)) return;
      if (event.method === "item/completed") this.completedItems.add(itemKey);
      const index = items.findIndex((value) => object(value).id === item.id);
      if (index < 0) items.push(item);
      else items[index] = item;
      turn.items = items;
    } else if (event.method === "turn/plan/updated") {
      const turn = this.turn(state, params.turnId);
      if (!turn) return;
      upsertTurnPlanUpdate(turn, params);
    } else if (event.method.endsWith("/delta") || event.method.endsWith("Delta")) {
      if (this.completedItems.has(JSON.stringify([id, params.turnId, params.itemId]))) return;
      const turn = this.turn(state, params.turnId);
      const item = array(turn?.items)
        .map(object)
        .find((value) => value.id === params.itemId);
      if (!item || typeof params.delta !== "string") return;
      if (state.apiRetry?.turnId === params.turnId) state.apiRetry = null;
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
    const rows = await paginateNativeRows(
      this.rpc,
      "thread/list",
      {
        cwd: this.cwd,
        // 原生默认只列当前 provider 的交互来源；项目历史应包含 CLI/exec 与桌面
        // 创建的会话，切换 provider 也不能让旧记录消失。空数组显式取消 provider 过滤。
        modelProviders: [],
        sourceKinds: ["cli", "vscode", "exec", "appServer"],
        archived: false,
      },
      "thread",
    );
    // CLI/exec 落盘的是规范化物理路径；按物理目录过滤，别名拼写才不会把列表判空。
    const owned = await Promise.all(
      rows.map((row) => sameExecutionPath(object(row).cwd, this.cwd)),
    );
    // 分页只收集原始事实；完整校验与同 ID rollout 选择由投影单一 owner 处理。
    return canonicalNativeThreads(rows.filter((_, index) => owned[index]));
  }
}
