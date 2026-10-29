import { randomUUID } from "node:crypto";
import type { CodexNotification, CodexRpcPort } from "./contract.js";
import {
  applyNativeAutoApprovalReview,
  settleTurnAutoApprovalReviews,
} from "./auto-approval-review.js";
import { accumulateNativeTurnUsage } from "./bridge-snapshot-usage.js";
import { array, object, string, type JsonObject } from "./json.js";
import { rememberThreadMode } from "./command-input.js";
import { sameExecutionPath } from "./execution-path.js";
import { mergeNativeTurn } from "./merge-turn.js";
import {
  applyNativeItemDelta,
  applyNativeItemLifecycle,
  findNativeTurn,
} from "./native-item-delta.js";
import { hydrateNativeTurnItems, paginateNativeRows } from "./native-paging.js";
import { applyNativeRetry } from "./native-retry-status.js";
import { resolveSelectionSideChatBoundary } from "./selection-side-chat.js";
import {
  findLastTurnWithStatus,
  findTurnEntry,
  invalidateTurnItems,
  lastTurn,
  noteTurnAppended,
  noteTurnReplaced,
} from "./thread-index.js";
import {
  attachThreadForLoad,
  parentThreadIdOf,
  parentThreadOwnedByWorkspace,
} from "./thread-load.js";
import { DeletedThreadError, type ThreadProjectionState } from "./thread-state-types.js";
import { listNativeQueue, listWorkspaceThreads } from "./thread-queries.js";
import { upsertTurnPlanUpdate } from "./turn-plan-update.js";
import { SubagentActivityTracker } from "./subagent-activity.js";
import {
  nativeActivityBaseline,
  nativeHistoryActivity,
  nativeLiveActivity,
  readRecentNativeActivity,
  type ThreadActivityClock,
} from "./thread-activity.js";

// 本文件仍是 store 词汇表的对外入口（与 projection.ts 的 facade 惯例一致）：
// 定义移到 thread-state-types.ts 只是为了把 store 主体压回 400 行上限内。
export { DeletedThreadError } from "./thread-state-types.js";
export type { ThreadProjectionState } from "./thread-state-types.js";

/** A disposable projection cache. All durable facts and queue admission belong to Codex. */
export class ThreadStateStore {
  private readonly states = new Map<string, ThreadProjectionState>();
  private readonly listeners = new Set<(threadId: string) => void>();
  private readonly loads = new Map<string, Promise<ThreadProjectionState>>();
  private readonly authorizations = new Map<string, Promise<void>>();
  private listInFlight: Promise<unknown[]> | undefined;
  private stagedDiscoveredList: Promise<unknown[]> | undefined;
  private clearStagedTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly loaded = new Set<string>();
  private readonly deleted = new Set<string>();
  /** 冷 attach 前固定，invalidate/reload 不丢失；原生 metadata 不是第二个时间写者。 */
  private readonly activityTimes = new Map<string, ThreadActivityClock>();
  private readonly activityReads = new Map<
    string,
    { metadataAt: number; promise: Promise<void> }
  >();
  private readonly completedItems = new Set<string>();
  /** 子线程活性与父子登记的单一所有者（见 subagent-activity.ts 头部说明）。 */
  private readonly subagentActivity = new SubagentActivityTracker();

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

  isDeleted(id: string): boolean {
    return this.deleted.has(id);
  }

  remove(id: string): void {
    this.deleted.add(id);
    this.states.delete(id);
    this.activityTimes.delete(id);
    this.loaded.delete(id);
    this.clearStagedDiscoveredList();
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

  /** 最近一次原生 turn/status 事件观测到的线程活性；无观测返回 undefined（不覆盖父侧事实）。 */
  observedThreadActive(id: string): boolean | undefined {
    return this.subagentActivity.observedActive(id);
  }

  /** 一次性种子写入活性观测（事件旁路的写入在 apply 内）。 */
  noteThreadActivity(id: string, active: boolean): void {
    this.subagentActivity.noteActivity(id, active);
  }

  /** 父会话快照构建后登记父子关系；子线程生命周期事件据此触发父会话重投影。 */
  noteSubagentChildren(parentId: string, childIds: readonly string[]): void {
    this.subagentActivity.noteChildren(parentId, childIds);
  }

  /** 子代理种子调度器读取跟踪器（种子模块与 store 的边界：tracker 归 store 所有）。 */
  subagentActivityTracker(): SubagentActivityTracker {
    return this.subagentActivity;
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

  /** 只覆盖活动字段；查询扫描结束后调用，保留原生集合/title/cwd 并读取最新 live 时钟。 */
  activityThread(value: unknown, includeHistory = false): JsonObject {
    const thread = object(value);
    const id = string(thread.id);
    const metadataAt = nativeActivityBaseline(thread);
    const clock = this.activityTimes.get(id) ?? {
      at: metadataAt,
      metadataAt,
      frozen: false,
    };
    if (includeHistory) {
      clock.at = Math.max(clock.at, nativeHistoryActivity(thread) ?? 0);
      // 裸 full item 不含 envelope 时间；冻结 attach 基线不等于确认外部 writer 的最新活动指纹。
      // 只有有界 turn/item 补读完整成功才消费较新指纹，否则 running turn 的后续 item 会被漏掉。
      clock.frozen = true;
    }
    if (!this.deleted.has(id)) this.activityTimes.set(id, clock);
    // 原生-shaped schema 要求整数秒；毫秒只留在唯一 clock owner 内，不让投影校验 fatal。
    return { ...thread, updatedAt: Math.floor(clock.at / 1000) };
  }

  async refreshActivityThread(value: unknown): Promise<JsonObject> {
    const thread = object(value);
    const id = string(thread.id);
    const clock = this.activityTimes.get(id);
    const metadataAt = nativeActivityBaseline(thread);
    const state = this.states.get(id);
    const external =
      !clock?.frozen ||
      !state ||
      state.readOnly === "writer-conflict" ||
      (state.readOnly === "subagent-child" && state.attached !== true);
    if (
      !clock ||
      metadataAt <= clock.metadataAt ||
      !external ||
      this.loads.has(id) ||
      this.deleted.has(id)
    )
      return this.activityThread(thread);
    const inFlight = this.activityReads.get(id);
    if (inFlight) {
      await inFlight.promise;
      return metadataAt > inFlight.metadataAt
        ? this.refreshActivityThread(thread)
        : this.activityThread(thread);
    }
    // 发现不是 attach：外部 CLI 的真实追加必须刷新，但 raw updatedAt 的设置追加不能造活动。
    const pending = readRecentNativeActivity(this.rpc, id)
      .then((evidence) => {
        if (this.deleted.has(id) || this.activityTimes.get(id) !== clock) return;
        clock.at = Math.max(clock.at, evidence.at ?? 0);
        if (evidence.complete) clock.metadataAt = Math.max(clock.metadataAt, metadataAt);
        const current = this.states.get(id);
        const seconds = Math.floor(clock.at / 1000);
        if (current && current.thread.updatedAt !== seconds) {
          current.thread.updatedAt = seconds;
          this.touch(id);
        }
      })
      .catch(() => {
        // 可选活动证据失败只能保留已知值；不信任 metadata，也不消费指纹，后续显式扫描可重读。
      })
      .finally(() => {
        if (this.activityReads.get(id)?.promise === pending) this.activityReads.delete(id);
      });
    this.activityReads.set(id, { metadataAt, promise: pending });
    await pending;
    return this.activityThread(thread);
  }

  put(value: unknown): ThreadProjectionState {
    const thread = this.activityThread(value, true);
    const id = string(thread.id);
    this.assertAvailable(id);
    this.clearStagedDiscoveredList();
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

  async ensure(id: string, additionalDirectories?: string[]): Promise<ThreadProjectionState> {
    this.assertAvailable(id);
    const existing = this.states.get(id);
    if (existing && this.loaded.has(id)) return existing;
    const loading = this.loads.get(id);
    if (loading) return loading;
    const authorization = Promise.withResolvers<void>();
    let provisional: ThreadProjectionState | undefined;
    this.authorizations.set(id, authorization.promise);
    const pending = this.load(id, additionalDirectories, authorization.resolve, (state) => {
      provisional = state;
    })
      .catch((error: unknown) => {
        // 修复依据：冷恢复失败不能留下可被命令路径误认作已授权运行态的半成品。
        // 只撤销本次新建且仍由本次 load 持有的临时状态，不覆盖已有热状态或删除 tombstone。
        if (provisional && this.states.get(id) === provisional) {
          this.states.delete(id);
          this.loaded.delete(id);
        }
        throw error;
      })
      .finally(() => {
        authorization.resolve();
        this.authorizations.delete(id);
        this.loads.delete(id);
      });
    this.loads.set(id, pending);
    return pending;
  }

  private async load(
    id: string,
    additionalDirectories: string[] | undefined,
    authorize: () => void,
    onProvisional: (state: ThreadProjectionState) => void,
  ): Promise<ThreadProjectionState> {
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
    // 修复原因：原生冷 resume 可在回包后、历史分页前发出新 goal 轮；以前此时 states 尚不存在，
    // apply 会丢弃轮次通知，而分页又可能只返回旧历史，之后 ensure 永远命中缺轮次的缓存。
    // 修复依据：先验证工作区归属，再为历史加载建立同一个临时投影；授权前的通知仅等待这道门禁，
    // 不等待漫长的整段分页，也不对未授权的原生线程创建状态。
    // 修复依据：resume 会追加 settings/goal/token 等非对话记录并提升 raw updatedAt；
    // 授权 read 在 resume 之前固定时钟，后续 metadata 只能覆盖其他字段。
    this.activityThread(metadata, true);
    if (!this.states.has(id)) onProvisional(this.put({ ...object(read.thread), turns: [] }));
    authorize();
    // attach 与只读降级的分流规则集中在 thread-load.ts（含子代理冷启拒绝路径）。
    const { thread, readOnly, attached } = await attachThreadForLoad({
      rpc: this.rpc,
      id,
      read,
      parentThreadId,
      additionalDirectories,
      assertAvailable: () => this.assertAvailable(id),
    });
    const turns = await paginateNativeRows(
      this.rpc,
      "thread/turns/list",
      { threadId: id, sortDirection: "asc", itemsView: "full" },
      "history",
    );
    const merged = new Map(turns.map((turn) => [string(object(turn).id), turn]));
    const hydratedLive = new Map<string, unknown[]>();
    while (true) {
      const incomplete = array(this.states.get(id)?.thread.turns)
        .map(object)
        .find((turn) => {
          const key = string(turn.id);
          return (
            (turn.itemsView === "summary" || turn.itemsView === "notLoaded") &&
            object(merged.get(key)).itemsView !== "full" &&
            !hydratedLive.has(key)
          );
        });
      if (incomplete) {
        const key = string(incomplete.id);
        hydratedLive.set(key, await hydrateNativeTurnItems(this.rpc, id, key));
        this.assertAvailable(id);
        continue;
      }
      // 修复依据：任何网络 await 之后都重新读取最新 live turns；最后一次读取、按 turn/item
      // 身份合并及 put 之间没有 await，分页/补全期新到的事件不会被旧页覆盖。
      for (const value of array(this.states.get(id)?.thread.turns)) {
        const live = object(value);
        const key = string(live.id);
        const old = merged.get(key);
        const items = hydratedLive.get(key);
        const resolved = items
          ? mergeNativeTurn({ ...live, itemsView: "full", items }, live)
          : live;
        merged.set(key, old ? mergeNativeTurn(object(old), resolved) : resolved);
      }
      break;
    }
    thread.turns = [...merged.values()];

    this.assertAvailable(id);
    const state = this.put(thread);
    // 辅助对话 child 重建继承裁剪边界；父读取失败 fail-open 不裁剪（spec: codex-selection-side-chat）。
    const cachedParentId =
      typeof thread.forkedFromId === "string" ? thread.forkedFromId : undefined;
    const cachedParent =
      cachedParentId && this.loaded.has(cachedParentId)
        ? this.states.get(cachedParentId)?.thread
        : undefined;
    state.sideChat = await resolveSelectionSideChatBoundary(
      this.rpc,
      thread,
      cachedParent && Array.isArray(cachedParent.turns) ? cachedParent.turns : undefined,
    );
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
    const existing = state && findNativeTurn(state.thread, turn.id);
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
      state.autoApprovalReviews = undefined;
      // 修复原因：这里清了 turns 与 autoApprovalReviews，却漏了同为「轮次作用域瞬时观测」的 apiRetry。
      // 于是从清空到 ensure() 重新载入之间有一段（一次 thread/read + resume 的往返，几十到几百毫秒）
      // 「turns 为空 + apiRetry 仍在」的状态；并发快照构建会在 bridge-snapshots.ts:341 抛错并 fatal。
      // 更糟的是它可能闩住：ensure() 失败时该状态不会被覆盖，之后每次快照构建都抛错。
      // 修复依据：apiRetry 只归属某个 native turn（见 native-retry-status.ts 头部注释），历史被整体
      // 替换后旧观测必然失效；与 autoApprovalReviews 同样在此清除，语义一致。
      state.apiRetry = null;
    }
    this.loaded.delete(id);
    return this.ensure(id);
  }

  async refreshQueue(id: string): Promise<void> {
    const state = this.states.get(id);
    if (!state) return;
    state.queue = await listNativeQueue(this.rpc, id);
    this.touch(id);
  }

  /** 归属判定需要解析物理路径，所以事件投影是异步的；调用方必须保持事件串行。 */
  async apply(event: CodexNotification): Promise<string | undefined> {
    const receivedAt = Date.now();
    const params = object(event.params ?? {});
    if (
      [
        "thread/started",
        "thread/archived",
        "thread/deleted",
        "thread/name/updated",
        "turn/started",
        "turn/completed",
        "item/completed",
      ].includes(event.method)
    ) {
      this.clearStagedDiscoveredList();
    }
    if (event.method === "thread/deleted") {
      const deletedId = string(params.threadId);
      // 先取父会话再失效登记（顺序不可换）：子线程删除同样终结子代理运行态，
      // 父会话立即重投影，状态面板停止计时。
      const subagentParents = this.subagentActivity.untrack(deletedId);
      this.remove(deletedId);
      for (const parentId of subagentParents) this.touch(parentId);
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
    // read/归属校验先于临时状态建立；同一个加载中的线程的通知必须等待授权后落账。
    // await 只覆盖首次只读校验，不堵住整个历史分页或其他线程的常规流式事件。
    const authorization = id && !this.states.has(id) ? this.authorizations.get(id) : undefined;
    if (authorization) await authorization;
    const state = id ? this.states.get(id) : undefined;
    if (!state || !id) {
      // 未加载的子线程没有投影条目，但它的 turn/status 事件仍是子代理运行态的权威事实
      // （子线程创建时原生会为已初始化连接自动挂 listener，事件无需打开子面板即可到达）。
      // 观测先落账再 touch 父会话；父子关系未登记时（首个父快照尚未构建）观测也已留存，
      // 不会丢失。
      if (id)
        for (const parentId of this.subagentActivity.observeLifecycle(event.method, id, params))
          this.touch(parentId);
      return;
    }
    if (event.method === "error") {
      const { retry, changed } = applyNativeRetry(state.thread, state.apiRetry, params);
      state.apiRetry = retry;
      if (changed) this.touch(id);
      return id;
    }
    if (event.method === "thread/status/changed") state.thread.status = params.status;
    else if (event.method === "thread/name/updated") state.thread.name = params.threadName;
    else if (event.method === "thread/goal/updated") state.goal = object(params.goal);
    else if (event.method === "thread/goal/cleared") state.goal = null;
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
      // 原因：旧实现每条 tokenUsage 事件都要 `array(turns).map(object)` 复制整份历史再 findLast，
      // 长会话下这条事件的开销随历史线性增长；倒序查找命中末尾活动轮即返回，语义与
      // `findLast(inProgress)?.id ?? at(-1)?.id` 完全一致（找不到活动轮时才回退到最后一轮）。
      const fallbackTurn =
        findLastTurnWithStatus(state.thread, "inProgress") ?? lastTurn(state.thread);
      const targetTurnId = typeof params.turnId === "string" ? params.turnId : fallbackTurn?.id;
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
      // 增量索引定位替代 findIndex 的全历史线性扫描（thread-index.ts）。
      const existingEntry = findTurnEntry(state.thread, turn.id);
      // 已终结轮的迟到 started 不是新活动；merge 虽会保留终态，但不能因此推进接收时钟。
      if (
        event.method === "turn/started" &&
        existingEntry &&
        existingEntry.turn.status !== "inProgress"
      )
        return;
      // 原生生命周期通知仅携 turn 摘要；当前连接已按 item 事件收齐的内容不能被 summary 清空。
      if (!existingEntry) {
        const turnId = string(turn.id);
        let hydratedItems = array(turn.items);
        let itemsView =
          event.method === "turn/started" || turn.itemsView === undefined ? "full" : turn.itemsView;
        // 修复原因：当 `turn/completed(summary)` 在缺少本地 `turn/started` 时到达（如刚 attach/重连边界
        // 或外部触发轮次收尾），直接 push `itemsView: "summary"` 会让下次快照投影因
        // `turn.itemsView !== "full"` 崩溃并断开会话订阅。
        // 修复依据：在更新 revision / 发布快照前通过只读 `thread/items/list` 补全该轮 items；
        // 若补全等待期间 `load()` 已把同一轮写入 `state.thread.turns`，则走原位合并避免重复 turnId。
        if (itemsView !== "full") {
          const fetched = await hydrateNativeTurnItems(this.rpc, id, turnId);
          const mergedItems = new Map(hydratedItems.map((item) => [string(object(item).id), item]));
          for (const item of fetched) mergedItems.set(string(object(item).id), item);
          hydratedItems = [...mergedItems.values()];
          itemsView = "full";
        }
        if (this.deleted.has(id) || this.states.get(id) !== state) return;
        const currentEntry = findTurnEntry(state.thread, turnId);
        const currentTurns = array(state.thread.turns);
        const created = {
          ...turn,
          items: hydratedItems,
          itemsView,
        };
        if (currentEntry) {
          const merged = mergeNativeTurn(object(currentEntry.turn), created);
          currentTurns[currentEntry.index] = merged;
          state.thread.turns = currentTurns;
          noteTurnReplaced(state.thread, currentEntry.index, merged);
        } else {
          currentTurns.push(created);
          state.thread.turns = currentTurns;
          noteTurnAppended(state.thread, created);
        }
      } else {
        let merged = mergeNativeTurn(object(existingEntry.turn), turn);
        if (merged.itemsView === "summary" || merged.itemsView === "notLoaded") {
          const turnId = string(turn.id);
          const fetched = await hydrateNativeTurnItems(this.rpc, id, turnId);
          if (this.deleted.has(id) || this.states.get(id) !== state) return;
          merged = mergeNativeTurn({ ...merged, itemsView: "full", items: fetched }, merged);
        }
        turns[existingEntry.index] = merged;
        state.thread.turns = turns;
        noteTurnReplaced(state.thread, existingEntry.index, merged);
      }
      if (event.method === "turn/completed") {
        settleTurnAutoApprovalReviews(state, turn.id, turn.status);
      }
    } else if (event.method === "item/started" || event.method === "item/completed") {
      if (!applyNativeItemLifecycle(state, id, event.method, params, this.completedItems)) return;
    } else if (
      event.method === "item/autoApprovalReview/started" ||
      event.method === "item/autoApprovalReview/completed" ||
      event.method === "autoApprovalReview/strictReviewRequired"
    ) {
      if (!applyNativeAutoApprovalReview(state, event.method, params)) return;
    } else if (event.method === "turn/plan/updated") {
      const turnEntry = findTurnEntry(state.thread, params.turnId);
      if (!turnEntry) return;
      upsertTurnPlanUpdate(turnEntry.turn, params);
      // upsertTurnPlanUpdate 可能原位替换已存在的 plan item（数组长度与引用都不变），
      // 索引无法自行发现，必须显式失效该轮的 item 索引，避免后续 delta 命中过期条目。
      invalidateTurnItems(turnEntry);
    } else if (event.method.endsWith("/delta") || event.method.endsWith("Delta")) {
      if (!applyNativeItemDelta(state, event.method, params, this.completedItems)) return;
    } else return;
    // 修复原因：旧统一收尾把 settings/goal/token/name/status 全当活动，打开历史就改变排序。
    // 只在有效 turn/item 或成功 delta 后推进；历史/metadata 写入通过同一单调 owner 清洗。
    const activity = nativeLiveActivity(event.method, params, receivedAt);
    if (activity !== undefined) {
      this.clearStagedDiscoveredList();
      const clock = this.activityTimes.get(id)!;
      clock.at = Math.max(clock.at, activity);
      state.thread.updatedAt = Math.floor(clock.at / 1000);
    }
    this.touch(id);
    // 已加载子线程的生命周期事件同样要让父会话重投影；否则父侧 subagents.running
    // 要等下一次父线程事件才收敛，状态面板在子代理结束后继续计时。
    for (const parentId of this.subagentActivity.observeLifecycle(event.method, id, params))
      this.touch(parentId);
    return id;
  }

  private clearStagedDiscoveredList(): void {
    this.stagedDiscoveredList = undefined;
    if (this.clearStagedTimer) {
      clearTimeout(this.clearStagedTimer);
      this.clearStagedTimer = undefined;
    }
  }

  /**
   * 供 session/list 发现请求与紧随其后的 afterResponse(`sessions-index` 刷新) 共享同一次扫描结果。
   * 同一轮微任务/宏任务内的多个 sessions-index 订阅者可共享该快照，宏任务结束后或任何线程变更事件到达时立即清空，
   * 保证普通的显式 `store.list()` 调用绝不读到过期缓存。
   */
  async listAndStageForIndexRefresh(): Promise<unknown[]> {
    const rows = await this.list();
    this.clearStagedDiscoveredList();
    const staged = Promise.resolve(rows);
    this.stagedDiscoveredList = staged;
    this.clearStagedTimer = setTimeout(() => {
      if (this.stagedDiscoveredList === staged) {
        this.stagedDiscoveredList = undefined;
      }
      this.clearStagedTimer = undefined;
    }, 0);
    this.clearStagedTimer.unref?.();
    return rows;
  }

  async consumeDiscoveredListOrScan(): Promise<unknown[]> {
    const staged = this.stagedDiscoveredList;
    if (staged !== undefined) {
      return staged;
    }
    return this.list();
  }

  async list(): Promise<unknown[]> {
    this.clearStagedDiscoveredList();
    // 修复原因：项目激活/回焦时 session/list 发现与多个 sessions-index 订阅者（taskIndexSyncer、
    // windowHostObserver、renderer store）会同时触发 list()，导致同一原生 app-server 上并发跑
    // 3~4 套全量 thread/list 分页扫描，阻塞后续打开会话的 thread/read / resume / turns/list 并触发
    // 30s RPC 超时。这里仅合并同一时刻在途的扫描；完成后立即清空，不保留过期列表缓存。
    if (this.listInFlight) return this.listInFlight;
    const pending = listWorkspaceThreads(this.rpc, this.cwd)
      .then(async (rows) => {
        await Promise.all(rows.map((row) => this.refreshActivityThread(row)));
        // 各行可先完成补读；统一等待后无 await 覆盖最新 clock，避免其他行等待期的新活动被旧值遮盖。
        return rows.map((row) => this.activityThread(row));
      })
      .finally(() => {
        if (this.listInFlight === pending) this.listInFlight = undefined;
      });
    this.listInFlight = pending;
    return pending;
  }
}
