import type { CodexRpcPort } from "./contract.js";
import { codexThreadSchema, type CodexThread } from "./codex-types.js";
import { array, object } from "./json.js";
import { SUBAGENT_THREAD_SOURCE_KINDS } from "./subagent-projection.js";

const MAX_LIST_PAGES = 20;

/**
 * 交互式 sourceKinds 不含子线程，必须显式给出 subAgent* 来源；不带 cwd 过滤，
 * 否则跑在隔离 worktree 里的子代理会被原生按精确路径排除。归属由父线程校验保证。
 */
export async function listChildThreads(
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
