import type { CodexRpcPort } from "./contract.js";
import { object, type JsonObject } from "./json.js";
import type { CodexThread } from "./codex-types.js";
import { childThreadListBackoff, listChildThreads } from "./child-thread-list.js";

/**
 * 子线程活性跟踪（specs/codex-desktop-subagent-drilldown.md「running 收敛」）。
 *
 * 为什么需要它：snapshot.subagents.running 的父侧事实经常永远等不到终态——
 * v1 只在 wait/send_input 碰巧观测到终态时才写 agentsStates，v2 只在 Completed 时写
 * subAgentActivity（实测 rollout 中多数 child 没有任何父侧终态）。没有旁路时，状态面板的
 * 计时器在子代理任务结束后一直走。子线程创建时原生会为已初始化连接自动挂 listener，
 * turn/started、turn/completed、thread/status/changed 无需打开子面板即可到达，是权威的
 * 活性事实；连接建立前已存在的旧子线程由一次性 thread/list 种子补齐。
 *
 * 单一所有者：活性观测与父子登记只在本类里；ThreadStateStore 通过委托方法暴露，
 * 事件到达时按反向索引 touch 父会话触发重投影，而不是等下一次父线程事件。
 */
export class SubagentActivityTracker {
  /** 所有线程最近一次原生 turn/status 事件观测到的活性（不限于已加载线程）。 */
  private readonly threadActivity = new Map<string, boolean>();
  private readonly childrenByParent = new Map<string, Set<string>>();
  private readonly parentsByChild = new Map<string, Set<string>>();

  /** 最近一次观测到的线程活性；无观测返回 undefined（不覆盖父侧事实）。 */
  observedActive(id: string): boolean | undefined {
    return this.threadActivity.get(id);
  }

  /** 记录活性观测（事件旁路与一次性种子共用写入路径）。 */
  noteActivity(id: string, active: boolean): void {
    this.threadActivity.set(id, active);
  }

  /**
   * 父会话每次快照构建后用投影出的 childSessionIds 登记父子关系。
   * 观测先落账、关系后登记也能收敛：apply 对未登记线程同样记录活性。
   */
  noteChildren(parentId: string, childIds: readonly string[]): void {
    const previous = this.childrenByParent.get(parentId) ?? new Set<string>();
    const next = new Set(childIds);
    for (const childId of previous) {
      if (next.has(childId)) continue;
      const parents = this.parentsByChild.get(childId);
      parents?.delete(parentId);
      if (parents && parents.size === 0) {
        this.parentsByChild.delete(childId);
        this.threadActivity.delete(childId);
      }
    }
    for (const childId of next) {
      if (previous.has(childId)) continue;
      const parents = this.parentsByChild.get(childId) ?? new Set<string>();
      parents.add(parentId);
      this.parentsByChild.set(childId, parents);
    }
    if (next.size === 0) this.childrenByParent.delete(parentId);
    else this.childrenByParent.set(parentId, next);
  }

  /**
   * turn/started、turn/completed、thread/status/changed 携带线程活性事实。
   * 返回需要重投影的父会话 id（仅当该线程是已登记的子线程）。
   */
  observeLifecycle(method: string, id: string, params: JsonObject): string[] {
    if (method === "turn/started") this.noteActivity(id, true);
    else if (method === "turn/completed") this.noteActivity(id, false);
    else if (method === "thread/status/changed") {
      const type = object(params.status).type;
      if (type === "active") this.noteActivity(id, true);
      else if (type === "idle" || type === "systemError" || type === "notLoaded")
        this.noteActivity(id, false);
      else return [];
    } else return [];
    return [...(this.parentsByChild.get(id) ?? [])];
  }

  /**
   * thread/deleted：失效登记，返回需要重投影的父会话 id。
   * 观测保留 false 墓碑而不是删除：已删除的子线程不可能仍在运行，清掉观测会让
   * 父侧 running 事实重新生效、状态面板继续计时；墓碑同时阻止种子调度重查。
   */
  untrack(id: string): string[] {
    this.threadActivity.set(id, false);
    const parentsToTouch = [...(this.parentsByChild.get(id) ?? [])];
    for (const parentId of parentsToTouch) {
      const children = this.childrenByParent.get(parentId);
      children?.delete(id);
      if (children && children.size === 0) this.childrenByParent.delete(parentId);
    }
    this.parentsByChild.delete(id);
    const children = this.childrenByParent.get(id);
    if (children) {
      for (const childId of children) {
        const parents = this.parentsByChild.get(childId);
        parents?.delete(id);
        if (parents && parents.size === 0) {
          this.parentsByChild.delete(childId);
          this.threadActivity.delete(childId);
        }
      }
      this.childrenByParent.delete(id);
    }
    return parentsToTouch;
  }
}

/**
 * 一次性种子查询的活性分类：active→运行中；systemError/notLoaded→已结束；idle 且
 * 从没跑过 turn → 还在排队/初始化，不判死（无观测，保持父侧 running 事实）；idle 且
 * 有 turn 且无 inProgress → 已结束。
 */
export function classifySeededChildActivity(child: CodexThread): boolean | undefined {
  if (child.status.type === "active") return true;
  if (child.status.type === "systemError" || child.status.type === "notLoaded") return false;
  if (child.turns.length === 0) return undefined;
  return child.turns.some((turn) => turn.status === "inProgress") ? true : false;
}

export interface SubagentActivitySeedDeps {
  rpc: CodexRpcPort;
  /** 已加载线程的原生 status（优先于活性观测）。 */
  nativeThreadStatus: (id: string) => JsonObject | undefined;
  tracker: SubagentActivityTracker;
  /** 活性收敛后触发父会话重投影。 */
  touchParent: (parentId: string) => void;
}

/**
 * 对「父侧事实 running、但 bridge 没有任何子线程活性观测」的 child 补一次性
 * `thread/list` 种子：覆盖 bridge 连接前已 spawn 的旧子线程（它们没有挂 listener，
 * 不会有 turn/status 事件）。进行中按父会话去重，已种子按子线程记账（失败回滚以便
 * 下一次父快照构建重试）。种子往返期间到达的事件观测更新鲜，一律不被种子覆盖。
 */
export class SubagentActivitySeedScheduler {
  private readonly attempts = new Map<string, Promise<void>>();
  private readonly seeded = new Set<string>();

  constructor(private readonly deps: SubagentActivitySeedDeps) {}

  schedule(parentId: string, running: readonly { childSessionId: string }[]): void {
    const { tracker } = this.deps;
    const pending = running
      .map((item) => item.childSessionId)
      .filter(
        (childId) =>
          this.deps.nativeThreadStatus(childId) === undefined &&
          tracker.observedActive(childId) === undefined &&
          !this.seeded.has(childId),
      );
    if (pending.length === 0 || this.attempts.has(parentId)) return;
    // 失败退避：thread/list 连续失败时冷却窗口内不再重发种子查询（账本见 child-thread-list.ts）。
    // 原因：父快照每次构建都会调度一次种子，原生持续报错时会变成每帧一轮分页扫描的失败风暴。
    // 冷却期内 pending 的 child 保持「未种子」，冷却过期后的下一次父快照构建自然恢复重试。
    if (childThreadListBackoff(this.deps.rpc, parentId)) return;
    const attempt = (async () => {
      try {
        const children = await listChildThreads(this.deps.rpc, parentId);
        // 成功列出后即记账，即使原生列表缺某个 child（已删除/归属异常），
        // 也不能让每次父快照构建都重查一次。
        for (const childId of pending) this.seeded.add(childId);
        let changed = false;
        for (const child of children) {
          this.seeded.add(child.id);
          const active = classifySeededChildActivity(child);
          if (active === undefined) continue;
          if (tracker.observedActive(child.id) !== undefined) continue;
          tracker.noteActivity(child.id, active);
          changed = true;
        }
        if (changed) this.deps.touchParent(parentId);
      } catch {
        for (const childId of pending) this.seeded.delete(childId);
      } finally {
        this.attempts.delete(parentId);
      }
    })();
    this.attempts.set(parentId, attempt);
  }

  /** 测试与诊断用：等待所有进行中的种子完成。 */
  async whenSettled(): Promise<void> {
    await Promise.all(this.attempts.values());
  }
}
