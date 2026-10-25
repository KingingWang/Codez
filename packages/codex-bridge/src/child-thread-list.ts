import type { CodexRpcPort } from "./contract.js";
import { codexThreadSchema, type CodexThread } from "./codex-types.js";
import { array, object } from "./json.js";
import { SUBAGENT_THREAD_SOURCE_KINDS } from "./subagent-projection.js";

const MAX_LIST_PAGES = 20;
/** 连续失败的退避基线与上限：thread/list 抖动时不能每次父快照都重发一轮分页扫描。 */
const BACKOFF_BASE_MS = 500;
const BACKOFF_MAX_MS = 30_000;

export interface ChildThreadListOptions {
  /** 判定退避冷却用的当前时间；缺省 Date.now()，测试可注入以跨过/停留在冷却窗口。 */
  now?: number;
}

interface ChildThreadListFailure {
  failures: number;
  retryAfterMs: number;
  retryAt: number;
  lastError: unknown;
}

/**
 * 同一 (rpc, parentThreadId) 的在途合并与失败退避账本（specs/codex-desktop-subagent-drilldown.md）。
 * 原因：`session/subagents` 目录查询与子线程活性种子会并发列同一父线程，且原生 `thread/list`
 * 失败时每次父快照构建都会立刻重发，在远端 app-server 忙于历史扫描时形成失败风暴并触发
 * RPC 超时。这里只合并在途 Promise（settled 即清除，不留过期列表），并按连续失败次数指数退避；
 * 一次成功立即清零，退避不会掩盖恢复。
 */
const inFlightByRpc = new WeakMap<CodexRpcPort, Map<string, Promise<CodexThread[]>>>();
const failuresByRpc = new WeakMap<CodexRpcPort, Map<string, ChildThreadListFailure>>();

function inFlightOf(rpc: CodexRpcPort): Map<string, Promise<CodexThread[]>> {
  let inFlight = inFlightByRpc.get(rpc);
  if (!inFlight) {
    inFlight = new Map();
    inFlightByRpc.set(rpc, inFlight);
  }
  return inFlight;
}

function failuresOf(rpc: CodexRpcPort): Map<string, ChildThreadListFailure> {
  let failures = failuresByRpc.get(rpc);
  if (!failures) {
    failures = new Map();
    failuresByRpc.set(rpc, failures);
  }
  return failures;
}

/**
 * 冷却中的失败账本；不在冷却窗口内（含从未失败与冷却已过期）返回 undefined。
 * 种子调度据此跳过重试，避免在退避窗口内继续敲原生。
 */
export function childThreadListBackoff(
  rpc: CodexRpcPort,
  parentThreadId: string,
  now: number = Date.now(),
): ChildThreadListFailure | undefined {
  const failure = failuresByRpc.get(rpc)?.get(parentThreadId);
  return failure && now < failure.retryAt ? failure : undefined;
}

function rememberFailure(
  rpc: CodexRpcPort,
  parentThreadId: string,
  error: unknown,
  now: number,
): void {
  const failures = failuresOf(rpc);
  const count = (failures.get(parentThreadId)?.failures ?? 0) + 1;
  const retryAfterMs = Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** (count - 1));
  failures.set(parentThreadId, {
    failures: count,
    retryAfterMs,
    retryAt: now + retryAfterMs,
    lastError: error,
  });
}

/**
 * 交互式 sourceKinds 不含子线程，必须显式给出 subAgent* 来源；不带 cwd 过滤，
 * 否则跑在隔离 worktree 里的子代理会被原生按精确路径排除。归属由父线程校验保证。
 */
export async function listChildThreads(
  rpc: CodexRpcPort,
  parentThreadId: string,
  options: ChildThreadListOptions = {},
): Promise<CodexThread[]> {
  const now = options.now ?? Date.now();
  const inFlight = inFlightOf(rpc);
  const joined = inFlight.get(parentThreadId);
  // 在途合并：并发查询共享同一轮分页扫描（含失败结果），语义与单独请求一致。
  if (joined) return joined;
  // 冷却窗口内不再发 RPC，直接复述上次失败：调用方仍看到错误，但不会被拖着一起重试风暴。
  const cooling = childThreadListBackoff(rpc, parentThreadId, now);
  if (cooling) throw cooling.lastError;
  const attempt = listChildThreadPages(rpc, parentThreadId).then(
    (threads) => {
      failuresOf(rpc).delete(parentThreadId);
      return threads;
    },
    (error: unknown) => {
      rememberFailure(rpc, parentThreadId, error, now);
      throw error;
    },
  );
  const pending = attempt.finally(() => {
    if (inFlight.get(parentThreadId) === pending) inFlight.delete(parentThreadId);
  });
  inFlight.set(parentThreadId, pending);
  return pending;
}

async function listChildThreadPages(
  rpc: CodexRpcPort,
  parentThreadId: string,
): Promise<CodexThread[]> {
  const threads: CodexThread[] = [];
  const seenIds = new Set<string>();
  const seenCursors = new Set<string>();
  let cursor: string | undefined;
  for (let page = 0; page < MAX_LIST_PAGES; page += 1) {
    const result = object(
      await rpc.request("thread/list", {
        parentThreadId,
        sourceKinds: [...SUBAGENT_THREAD_SOURCE_KINDS],
        modelProviders: [],
        archived: false,
        limit: 100,
        ...(cursor ? { cursor } : {}),
      }),
    );
    for (const row of array(result.data)) {
      const thread = codexThreadSchema.parse(row);
      if (seenIds.has(thread.id)) continue;
      seenIds.add(thread.id);
      threads.push(thread);
    }
    const next = typeof result.nextCursor === "string" ? result.nextCursor : undefined;
    if (!next || seenCursors.has(next)) break;
    seenCursors.add(next);
    cursor = next;
  }
  return threads;
}
