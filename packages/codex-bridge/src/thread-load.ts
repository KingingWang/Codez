import type { CodexRpcPort } from "./contract.js";
import { decorateNativeThread } from "./command-input.js";
import { sameExecutionPath } from "./execution-path.js";
import { object, type JsonObject } from "./json.js";
import { isWriterConflictError, type ThreadProjectionState } from "./thread-state-types.js";
import { isAbsolute } from "node:path";

/** 原生子线程身份只来自 parentThreadId；空串按无父线程处理，不能凭 thread id 猜测放权。 */
export function parentThreadIdOf(metadata: JsonObject): string | undefined {
  return typeof metadata.parentThreadId === "string" && metadata.parentThreadId.length > 0
    ? metadata.parentThreadId
    : undefined;
}

/** 原生 ThreadStatus（app-server-protocol v2/thread.rs）：本进程尚未把该线程加载进内存。 */
const NOT_LOADED_STATUS = "notLoaded";

/** 父线程归属：已加载用其事实，否则一次 lock-free thread/read；任何失败都不放宽边界。 */
export async function parentThreadOwnedByWorkspace(
  rpc: CodexRpcPort,
  cachedParent: JsonObject | undefined,
  cwd: string,
  parentThreadId: string,
): Promise<boolean> {
  try {
    const metadata = cachedParent
      ? object(cachedParent)
      : object(object(await rpc.request("thread/read", { threadId: parentThreadId })).thread);
    return await sameExecutionPath(metadata.cwd, cwd);
  } catch {
    return false;
  }
}

export interface ThreadLoadAccess {
  thread: Record<string, unknown>;
  readOnly?: ThreadProjectionState["readOnly"];
  /** resume 是否成功 attach：只有 attach 才有实时 item 流，未 attach 的只读条目可被 invalidate 重试。 */
  attached: boolean;
}

/**
 * load 期的 attach 与写权限判定，三条原生路径合并在这里：
 * 1. resume 成功 → attach，但仍按 parentThreadId 决定是否只读；
 * 2. 另一 writer（CLI/另一窗口）持有写锁时 resume 以 InvalidRequest 拒绝，但历史仍可读：
 *    用 lock-free 的 thread/read envelope（与 resume 响应同构，同过 decorateNativeThread）
 *    投影并标记 writer-conflict；签名不匹配的错误照旧抛出，不能把普通失败误判成冲突；
 * 3. 子代理线程另有一条原生拒绝路径：父线程未加载时 resume 直接 invalid_request
 *    （"cannot resume an unloaded multi-agent v2 sub-agent ...; use thread/read to inspect it"），
 *    不是写锁冲突，但同样只能只读投影——冷启下钻不应该整页失败。
 * attach 成功也不放开写：原生 V2 子线程由父 driver 拥有，客户端只是订阅者。
 */
export async function attachThreadForLoad(input: {
  rpc: CodexRpcPort;
  id: string;
  read: JsonObject;
  parentThreadId: string | undefined;
  additionalDirectories?: string[];
  assertAvailable: () => void;
}): Promise<ThreadLoadAccess> {
  const { rpc, id, read, parentThreadId, additionalDirectories, assertAvailable } = input;
  // 子线程只在原生已把它加载进本进程时才 resume：resume 已加载线程是「回放历史 + 原子订阅」
  // （codex-rs app-server/src/thread_state.rs），不改盘；resume 未加载线程会把 rollout 从磁盘
  // 重新加载，实测（codex-cli 0.160.1）这一步会改写子线程 rollout 并把 thread.updatedAt 顶到
  // 当前时间，于是「已结束」目录里的 endedAt 变成打开时刻、排序也被打乱。
  // 已结束的子代理只需要历史，而 thread/read + thread/turns/list 都是免锁只读，所以跳过 resume。
  // 父线程之后若再驱动它，原生会把它加载进本进程；未 attach 的条目在 subscribe/resync 时被
  // invalidate 重载，那时状态已是 idle/active，再走 resume 订阅即可（自愈路径）。
  const status = object(read.thread).status as { type?: unknown } | null | undefined;
  if (parentThreadId !== undefined && status?.type === NOT_LOADED_STATUS) {
    assertAvailable();
    return { thread: decorateNativeThread(read), readOnly: "subagent-child", attached: false };
  }
  let attached = false;
  let readOnly: ThreadProjectionState["readOnly"];
  let thread: Record<string, unknown>;
  try {
    // 原因：单目录视图打开未归类的外部多目录线程时，Host 的 [] 不是缩权命令；
    // 只为明确归属的线程发送覆盖数组。已加载线程由上层 ensure 直接返回，不刷新实例。
    const runtimeWorkspaceRoots =
      additionalDirectories !== undefined && !parentThreadId
        ? [...new Set([String(object(read.thread).cwd), ...additionalDirectories])]
        : undefined;
    if (runtimeWorkspaceRoots?.some((path) => !isAbsolute(path)))
      throw new Error("Native workspace roots must be absolute");
    const resumed = object(
      await rpc.request("thread/resume", {
        threadId: id,
        ...(runtimeWorkspaceRoots ? { runtimeWorkspaceRoots } : {}),
      }),
    );
    assertAvailable();
    thread = decorateNativeThread(resumed);
    attached = true;
  } catch (error) {
    if (!parentThreadId && !isWriterConflictError(error)) throw error;
    assertAvailable();
    thread = decorateNativeThread(read);
    readOnly = parentThreadId ? "subagent-child" : "writer-conflict";
  }
  if (parentThreadId) readOnly = "subagent-child";
  return { thread, readOnly, attached };
}
