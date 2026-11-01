// 会话整树枚举与活跃预检（specs/codex-session-data-purge.md）。
//
// 原生 thread/delete 自带 spawn 子树级联（thread_delete.rs:39-62），所以 bridge 不需要自己删子树；
// 但「删之前必须证明整树空闲」和「字节必须覆盖整树」都要求 bridge 自己枚举出同一个集合。
// 三个来源取并集，保证「原生会删的 ⊆ 我们预检并计量过的」：
//   1. state db `thread_spawn_edges` 递归闭包 —— 与原生 list_thread_spawn_descendants 同源；
//   2. 原生 `thread/list{ancestorThreadId}`（archived 两趟、sourceKinds 显式全集）；
//   3. `thread/loaded/list` 的活跃线程，按 parentThreadId 有界 BFS 回连到根。
// 任何一步读不到都 fail-closed，绝不把「查不到后代」当成「没有后代」。
import { codexThreadSchema, type CodexThread } from "./codex-types.js";
import { decorateNativeThread } from "./command-input.js";
import type { CodexRpcPort } from "./contract.js";
import { array, object, type JsonObject } from "./json.js";
import { paginateNativeRows } from "./native-paging.js";
import { CodexRpcError } from "./rpc-errors.js";
import { isThreadId } from "./session-data-files.js";
import {
  SessionDataFault,
  readQueuedThreadIds,
  readSpawnDescendants,
} from "./session-data-native-db.js";
import { SUBAGENT_THREAD_SOURCE_KINDS } from "./subagent-projection.js";

/**
 * 原生 ThreadSourceKind 全集（pinned ref schema/typescript/v2/ThreadSourceKind.ts）。
 * thread/list 的 sourceKinds 省略或给空数组都会退回「只列交互来源」
 * （app-server-protocol/src/protocol/v2/thread.rs:1424-1431），子线程会被静默过滤掉：
 * 那样后代既不计字节，也躲过活跃预检，是最危险的 fail-open，因此必须显式给全集。
 */
const ALL_THREAD_SOURCE_KINDS = [
  "cli",
  "vscode",
  "exec",
  "appServer",
  ...SUBAGENT_THREAD_SOURCE_KINDS,
  "unknown",
];

const DEFAULT_MAX_MEMBERS = 1024;
/**
 * 活跃线程回连 BFS 的 thread/read 预算；用尽而前沿非空 = 无法证明整树，fail-closed。
 * 预算要高于「一个 bridge 进程可能同时加载的线程数」，否则打开很多会话的正常工作区
 * 会因为无关的已加载线程被判成无法证明；桌面侧线程会空闲卸载，256 已经很宽。
 */
const DEFAULT_MAX_LIVE_READS = 256;
const DEFAULT_MAX_QUEUE_CHECKS = 64;
const MAX_PARENT_HOPS = 32;

export type TreeActivity = "running" | "idle" | "unknown";

export interface TreeMember {
  id: string;
  root: boolean;
  activity: TreeActivity;
  /** 另一个进程/连接持有写权（bridge 只读降级条目）：破坏性删除必须保留并报失败。 */
  writerConflict: boolean;
  /** 原生 metadata 与 state db 都没有该线程：没有可删的持久事实。 */
  absent: boolean;
  /** 原生 metadata.cwd；只用于校验删除原语与审计，绝不作为过滤条件。 */
  cwd?: string;
}

export interface SessionTree {
  rootId: string;
  members: TreeMember[];
  threadIds: string[];
  rootCwd?: string;
  /** 根本身是子线程：Host 的树记账会错位，purge 拒绝。 */
  rootIsChild: boolean;
  rootAbsent: boolean;
}

export interface SessionTreeStore {
  get(id: string): { thread?: JsonObject; readOnly?: string | null } | undefined;
  observedThreadActive(id: string): boolean | undefined;
}

export interface SessionTreeDeps {
  rpc: CodexRpcPort;
  codexHome: string;
  store: SessionTreeStore;
  limits?: { maxMembers?: number; maxLiveReads?: number; maxQueueChecks?: number };
}

/** 原生对「线程不存在」的三种拼写：未加载、解析不到 rollout、store 里没有行。 */
export function isMissingNativeThreadError(error: unknown): boolean {
  if (!(error instanceof CodexRpcError) || error.code !== -32600) return false;
  return (
    error.message.includes("thread not loaded") ||
    error.message.includes("no rollout found") ||
    error.message.includes("thread not found")
  );
}

function parseThread(value: unknown, origin: string): CodexThread {
  const parsed = codexThreadSchema.safeParse(value);
  if (!parsed.success)
    throw new SessionDataFault(
      "native-metadata-invalid",
      `unreadable native thread from ${origin}`,
    );
  return parsed.data;
}

function activeFromThread(thread: {
  status: { type: string };
  turns: Array<{ status?: unknown }>;
}) {
  if (thread.status.type === "active") return "running" as const;
  return thread.turns.some((turn) => turn?.status === "inProgress")
    ? ("running" as const)
    : undefined;
}

/**
 * 单个线程的活跃判定。事实源优先级：bridge 投影（含 inProgress turn）→ 观测到的活跃 →
 * 原生 metadata.status。ThreadStatus 是闭合的四值枚举（v2/ThreadStatus.ts），
 * zod 判别联合遇到未知取值会解析失败并 fail-closed，不会把新状态误判成空闲。
 */
function classifyActivity(
  id: string,
  native: CodexThread | undefined,
  store: SessionTreeStore,
): TreeActivity {
  const state = store.get(id);
  if (state?.thread) {
    const projected = activeFromThread({
      status: object(object(state.thread).status) as { type: string },
      turns: array(state.thread.turns).map((turn) => object(turn)),
    });
    if (projected) return projected;
  }
  if (store.observedThreadActive(id) === true) return "running";
  if (!native) return "unknown";
  // ThreadStatus 是闭合四值枚举，active 已在上面判掉；其余（idle/notLoaded/systemError）都不在跑。
  return activeFromThread(native) ?? "idle";
}

async function readThreadFact(
  deps: SessionTreeDeps,
  id: string,
): Promise<{ thread?: CodexThread; absent: boolean }> {
  const cached = deps.store.get(id);
  if (cached?.thread && cached.readOnly !== "writer-conflict") {
    const parsed = codexThreadSchema.safeParse(cached.thread);
    // 投影缓存形状不符时不回退成「没有事实」，改为读原生：宁可多一次只读往返也不猜。
    if (parsed.success) return { thread: parsed.data, absent: false };
  }
  try {
    const metadata = decorateNativeThread(await deps.rpc.request("thread/read", { threadId: id }));
    return { thread: parseThread(metadata, "thread/read"), absent: false };
  } catch (error) {
    if (isMissingNativeThreadError(error)) return { absent: true };
    throw new SessionDataFault("native-read-failed", `thread/read failed for ${id}`);
  }
}

/** 原生 `thread/list{ancestorThreadId}`：任意深度后代，不含自身；归档线程要另起一趟。 */
async function listNativeDescendants(
  rpc: CodexRpcPort,
  rootId: string,
): Promise<Map<string, CodexThread>> {
  const threads = new Map<string, CodexThread>();
  for (const archived of [false, true]) {
    let rows: unknown[];
    try {
      rows = await paginateNativeRows(
        rpc,
        "thread/list",
        {
          ancestorThreadId: rootId,
          sourceKinds: [...ALL_THREAD_SOURCE_KINDS],
          modelProviders: [],
          archived,
        },
        "thread",
      );
    } catch (error) {
      if (error instanceof SessionDataFault) throw error;
      throw new SessionDataFault("native-list-failed", `thread/list failed for ${rootId}`);
    }
    for (const row of rows) {
      const thread = parseThread(row, "thread/list");
      threads.set(thread.id, thread);
    }
  }
  return threads;
}

async function listLoadedThreadIds(rpc: CodexRpcPort): Promise<Set<string>> {
  let rows: unknown[];
  try {
    rows = await paginateNativeRows(rpc, "thread/loaded/list", {}, "thread");
  } catch (error) {
    if (error instanceof SessionDataFault) throw error;
    throw new SessionDataFault("native-list-failed", "thread/loaded/list failed");
  }
  // ThreadLoadedListResponse.data 是线程 id 字符串数组（v2/ThreadLoadedListResponse.ts）。
  return new Set(rows.map((row) => (typeof row === "string" ? row : "")).filter(Boolean));
}

/**
 * 活跃线程回连：原生子树 = state db 闭包 ∪ 运行时活跃子树（thread_manager.rs:1056-1091），
 * 后者可能还没有落库的 spawn 边。这里从 loaded 集合里按 parentThreadId 有界 BFS 回连到根，
 * 预算用尽而前沿非空说明无法证明整树 → fail-closed。
 */
async function collectLiveDescendants(
  deps: SessionTreeDeps,
  rootId: string,
  known: Map<string, CodexThread>,
  budget: number,
): Promise<Map<string, CodexThread>> {
  const loaded = await listLoadedThreadIds(deps.rpc);
  const parentOf = new Map<string, string>();
  for (const [id, thread] of known) {
    if (thread.parentThreadId) parentOf.set(id, thread.parentThreadId);
  }
  const discovered = new Map<string, CodexThread>();
  let frontier = [...loaded].filter((id) => !known.has(id) && id !== rootId);
  let reads = 0;
  for (let hop = 0; hop < MAX_PARENT_HOPS && frontier.length > 0; hop += 1) {
    const next: string[] = [];
    for (const id of frontier) {
      if (reads >= budget)
        throw new SessionDataFault(
          "tree-too-large",
          "live descendant closure exceeded read budget",
        );
      reads += 1;
      const fact = await readThreadFact(deps, id);
      if (!fact.thread) continue;
      const parent = fact.thread.parentThreadId;
      if (!parent) continue;
      parentOf.set(id, parent);
      if (parent === rootId || known.has(parent) || discovered.has(parent)) {
        discovered.set(id, fact.thread);
        continue;
      }
      if (loaded.has(parent)) next.push(parent);
    }
    frontier = [...new Set(next)].filter((id) => !discovered.has(id));
  }
  if (frontier.length > 0)
    throw new SessionDataFault("tree-too-large", "live descendant closure did not converge");
  return discovered;
}

/** 排队输入等价 legacy residency 的 hasQueuedCommands → busy；已加载线程再补一次原生队列读。 */
async function applyQueueFacts(
  deps: SessionTreeDeps,
  members: TreeMember[],
  queuedIds: ReadonlySet<string>,
  natives: Map<string, CodexThread>,
): Promise<void> {
  for (const member of members) if (queuedIds.has(member.id)) member.activity = "running";
  const loadedIdle = members.filter(
    (member) => member.activity === "idle" && natives.get(member.id)?.status.type === "idle",
  );
  const maxQueueChecks = deps.limits?.maxQueueChecks ?? DEFAULT_MAX_QUEUE_CHECKS;
  for (const member of loadedIdle.slice(0, maxQueueChecks)) {
    let page: JsonObject;
    try {
      page = object(await deps.rpc.request("thread/queue/list", { threadId: member.id, limit: 1 }));
    } catch (error) {
      if (isMissingNativeThreadError(error)) continue;
      throw new SessionDataFault("native-queue-check-failed", `queue read failed for ${member.id}`);
    }
    if (array(page.data).length > 0) member.activity = "running";
  }
}

/**
 * 枚举一个根会话的整棵树并完成活跃预检。
 * 抛出 SessionDataFault 表示「无法证明可以安全删除」，调用方必须按失败保留，不得降级成只删根。
 */
export async function resolveSessionTree(
  rootId: string,
  deps: SessionTreeDeps,
): Promise<SessionTree> {
  if (!isThreadId(rootId))
    throw new SessionDataFault("invalid-session-id", "session id is not a native thread id");
  // 规范化成小写：原生 ThreadId 输出小写 UUID，而 SQLite 的 TEXT 比较是二进制的。
  // 若调用方传大写拼写，spawn 边查询会查不到后代（静默漏删），附件归属也会对不上。
  const canonicalRootId = rootId.toLowerCase();
  const maxMembers = deps.limits?.maxMembers ?? DEFAULT_MAX_MEMBERS;
  const rootFact = await readThreadFact(deps, canonicalRootId);
  const rootThread = rootFact.thread;
  if (rootThread && typeof rootThread.cwd !== "string")
    throw new SessionDataFault("invalid-thread-metadata", "native thread has no cwd");
  const natives = new Map<string, CodexThread>();
  if (rootThread) natives.set(canonicalRootId, rootThread);

  const dbDescendants = (await readSpawnDescendants(deps.codexHome, [canonicalRootId])).get(
    canonicalRootId,
  );
  const listed = await listNativeDescendants(deps.rpc, canonicalRootId);
  for (const [id, thread] of listed) natives.set(id, thread);
  const live = await collectLiveDescendants(
    deps,
    canonicalRootId,
    natives,
    deps.limits?.maxLiveReads ?? DEFAULT_MAX_LIVE_READS,
  );
  for (const [id, thread] of live) natives.set(id, thread);

  const ids = new Set<string>([canonicalRootId]);
  for (const id of dbDescendants ?? []) ids.add(id);
  for (const id of natives.keys()) ids.add(id);
  if (ids.size > maxMembers)
    throw new SessionDataFault("tree-too-large", `session tree exceeds ${maxMembers} threads`);

  const members: TreeMember[] = [];
  for (const id of ids) {
    const native = natives.get(id);
    const state = deps.store.get(id);
    // 只有 db spawn 边、原生 list 与 loaded 都查不到的成员：一次免锁 thread/read 定性，
    // 读不到就是「没有持久事实」，读得到就按它的原生 status 判定。
    let resolved = native;
    let absent = !native;
    if (!native && id !== canonicalRootId) {
      const fact = await readThreadFact(deps, id);
      resolved = fact.thread;
      absent = fact.absent;
      if (resolved) natives.set(id, resolved);
    }
    if (id === canonicalRootId) absent = rootFact.absent;
    members.push({
      id,
      root: id === canonicalRootId,
      activity: absent ? "idle" : classifyActivity(id, resolved, deps.store),
      writerConflict: state?.readOnly === "writer-conflict",
      absent,
      ...(resolved?.cwd ? { cwd: resolved.cwd } : {}),
    });
  }
  // 排队输入等价 legacy residency 的 hasQueuedCommands → busy：整树 id 集确定后一次读完。
  const queuedIds = await readQueuedThreadIds(deps.codexHome, [...ids]);
  await applyQueueFacts(deps, members, queuedIds, natives);

  const rootMember = members.find((member) => member.root)!;
  return {
    rootId: canonicalRootId,
    members,
    threadIds: members.map((member) => member.id),
    ...(rootThread?.cwd ? { rootCwd: rootThread.cwd } : {}),
    rootIsChild: Boolean(rootThread?.parentThreadId),
    rootAbsent: rootMember.absent,
  };
}
