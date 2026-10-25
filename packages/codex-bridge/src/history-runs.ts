import {
  codexConversationHistoryRunsResultSchema,
  codexHistoryRunSchema,
  type CodexHistoryRun,
  type CodexHistoryRunStatus,
  type CodexConversationHistoryRunsParams,
} from "@codez/shared/codez-protocol-v4";
import {
  codexThreadSchema,
  isCodexKnownItem,
  type CodexThread,
  type CodexTurn,
} from "./codex-types.js";
import { parseCodexThreadIncremental } from "./projection.js";

function addTiming(run: CodexHistoryRun, turn: CodexTurn): void {
  if (turn.startedAt !== undefined && turn.startedAt !== null)
    run.startedAtMs = turn.startedAt * 1000;
  if (turn.completedAt !== undefined && turn.completedAt !== null)
    run.completedAtMs = turn.completedAt * 1000;
  if (turn.durationMs !== undefined && turn.durationMs !== null) run.durationMs = turn.durationMs;
}

interface FileChangeFacts {
  paths: string[];
  additions: number;
  deletions: number;
}

function fileChangeFacts(turn: CodexTurn): FileChangeFacts {
  const paths = new Set<string>();
  let additions = 0;
  let deletions = 0;
  for (const item of turn.items) {
    if (!isCodexKnownItem(item) || item.type !== "fileChange" || item.status !== "completed")
      continue;
    for (const change of item.changes) {
      paths.add(change.path);
      for (const line of change.diff.split("\n")) {
        if (line.startsWith("+")) additions += 1;
        else if (line.startsWith("-")) deletions += 1;
      }
    }
  }
  return { paths: [...paths], additions, deletions };
}

function projectedStatus(turn: CodexTurn): CodexHistoryRunStatus {
  if (turn.status === "inProgress") return "running";
  if (turn.status === "completed") return "completed";
  if (turn.status === "failed") return "failed";
  if (turn.status === "interrupted") return "interrupted";
  return "unknown";
}

/**
 * settled turn 的投影缓存（specs/codex-desktop-workflow-history.md）。
 * 原因：historyRuns 是只读分页接口，向上翻页会把同一批历史 turn 反复投影；每次都重跑
 * Zod 校验、toolChain flatMap 与逐行 diff 统计，会让「翻一页」的成本正比于整段历史。
 * 只缓存终态 turn（status !== "inProgress"）：原生事件流会原地改写 inProgress turn 的
 * items，缓存它们会投影出过期状态；命中前再核对 itemsRef/itemsLength，保证同一 turn
 * 追加 item 后不会读到旧投影（与 projection-rows / file-changes 同一套不变量）。
 */
const settledTurnProjectionCache = new WeakMap<
  CodexTurn,
  {
    threadId: string;
    itemsRef: CodexTurn["items"];
    itemsLength: number;
    fileChangeSummary: FileChangeFacts;
    run: CodexHistoryRun;
  }
>();

const DEFAULT_PAGE_LIMIT = 50;
/** 分页索引的有界 LRU 上限：覆盖同时在翻的会话数，超出即淘汰最久未用的一条。 */
const PAGE_INDEX_CACHE_LIMIT = 32;

interface HistoryPageIndex {
  threadId: string;
  logEpoch: string;
  revision: number;
  /** 原始 turns 数组的形状签名：命中时不再 parse，只核对长度与首尾 turn 引用。 */
  rawTurnsLength: number;
  rawFirstTurn: unknown;
  rawLastTurn: unknown;
  turns: CodexTurn[];
  turnIndexById: Map<string, number>;
}

/** 插入序即访问序的有界 LRU；键为 (threadId, logEpoch, revision)。 */
const historyPageIndexCache = new Map<string, HistoryPageIndex>();

function pageIndexKey(threadId: string, logEpoch: string, revision: number): string {
  return `${threadId}\u0000${logEpoch}\u0000${revision}`;
}

function buildPageIndex(
  source: CodexThread,
  input: { logEpoch: string; revision: number },
  rawTurns: readonly unknown[] | undefined,
): HistoryPageIndex {
  const turnIndexById = new Map<string, number>();
  source.turns.forEach((turn, index) => {
    // 与旧的 findIndex 语义一致：重复 turn id 只认第一次出现的位置。
    if (!turnIndexById.has(turn.id)) turnIndexById.set(turn.id, index);
  });
  return {
    threadId: source.id,
    logEpoch: input.logEpoch,
    revision: input.revision,
    rawTurnsLength: rawTurns ? rawTurns.length : source.turns.length,
    rawFirstTurn: rawTurns ? rawTurns[0] : undefined,
    rawLastTurn: rawTurns ? rawTurns[rawTurns.length - 1] : undefined,
    turns: source.turns,
    turnIndexById,
  };
}

function rememberPageIndex(key: string, entry: HistoryPageIndex): void {
  historyPageIndexCache.delete(key);
  historyPageIndexCache.set(key, entry);
  while (historyPageIndexCache.size > PAGE_INDEX_CACHE_LIMIT) {
    const oldest = historyPageIndexCache.keys().next();
    if (oldest.done) break;
    historyPageIndexCache.delete(oldest.value);
  }
}

/**
 * 分页索引：同一 (threadId, logEpoch, revision) 复用已校验的 turns 与 id→下标映射。
 * revision/epoch 是失效权威——ThreadStateStore 每次原生事件都 touch（revision+1），
 * 重连/重放历史则换 epoch；因此命中时不必再 parse 整棵线程。额外核对 turns.length 与
 * 首尾 turn 引用，防止同一 revision 下被整体替换过的历史（例如直接改 fixture）读到旧索引。
 */
function historyPageIndex(input: {
  thread: unknown;
  logEpoch: string;
  revision: number;
}): HistoryPageIndex {
  const raw =
    input.thread && typeof input.thread === "object" && !Array.isArray(input.thread)
      ? (input.thread as { id?: unknown; turns?: unknown })
      : undefined;
  const rawTurns = Array.isArray(raw?.turns) ? raw.turns : undefined;
  const rawId = raw?.id;
  if (!rawTurns || typeof rawId !== "string" || rawId.length === 0) {
    // 畸形输入仍走 schema 权威抛错，且不进缓存（没有可核对的身份与水位）。
    return buildPageIndex(codexThreadSchema.parse(input.thread), input, undefined);
  }
  const key = pageIndexKey(rawId, input.logEpoch, input.revision);
  const cached = historyPageIndexCache.get(key);
  if (
    cached &&
    // 水位随条目一起核对：键是拼接字符串，条目自带身份才能杜绝任何形式的键碰撞。
    cached.threadId === rawId &&
    cached.logEpoch === input.logEpoch &&
    cached.revision === input.revision &&
    cached.rawTurnsLength === rawTurns.length &&
    cached.rawFirstTurn === rawTurns[0] &&
    cached.rawLastTurn === rawTurns[rawTurns.length - 1]
  ) {
    historyPageIndexCache.delete(key);
    historyPageIndexCache.set(key, cached);
    return cached;
  }
  // 增量校验：settled turn 复用 parseCodexTurnCached 的 WeakMap，流式期间不必全史重跑 Zod。
  const entry = buildPageIndex(parseCodexThreadIncremental(input.thread), input, rawTurns);
  rememberPageIndex(pageIndexKey(entry.threadId, input.logEpoch, input.revision), entry);
  return entry;
}

/** turn 级投影缓存：run 与它同源的 fileChangeSummary 一起记账，命中即跳过 diff 行统计。 */
function projectRunCached(threadId: string, turn: CodexTurn): CodexHistoryRun {
  const settled = turn.status !== "inProgress";
  const cached = settled ? settledTurnProjectionCache.get(turn) : undefined;
  const reusable =
    cached && cached.itemsRef === turn.items && cached.itemsLength === turn.items.length
      ? cached
      : undefined;
  if (reusable?.threadId === threadId) return reusable.run;
  // threadId 不同（理论上只在跨线程复用同一 turn 对象时发生）时 run 必须重建，
  // 但 diff 统计与线程无关，仍可复用已算好的 fileChangeSummary。
  const changes = reusable ? reusable.fileChangeSummary : fileChangeFacts(turn);
  const run = projectRun(threadId, turn, changes);
  if (settled)
    settledTurnProjectionCache.set(turn, {
      threadId,
      itemsRef: turn.items,
      itemsLength: turn.items.length,
      fileChangeSummary: changes,
      run,
    });
  return run;
}

function projectRun(threadId: string, turn: CodexTurn, changes: FileChangeFacts): CodexHistoryRun {
  const run = codexHistoryRunSchema.parse({
    runId: `codex-turn:${threadId}:${turn.id}`,
    threadId,
    turnId: turn.id,
    status: projectedStatus(turn),
    toolChain: turn.items.flatMap((item): CodexHistoryRun["toolChain"] => {
      const base = { itemId: item.id } as const;
      if (isCodexKnownItem(item) && item.type === "commandExecution")
        return [
          {
            ...base,
            kind: "command" as const,
            label: item.command.slice(0, 240) || item.id,
            status: item.status,
            detail: item.cwd,
          },
        ];
      if (isCodexKnownItem(item) && item.type === "mcpToolCall")
        return [
          {
            ...base,
            kind: "mcpToolCall" as const,
            label: `${item.server}/${item.tool}`.slice(0, 240),
            status: item.status,
          },
        ];
      if (isCodexKnownItem(item) && item.type === "fileChange")
        return [
          {
            ...base,
            kind: "fileChange" as const,
            label: item.changes[0]?.path?.slice(0, 240) || item.id,
            status: item.status,
            detail: item.changes
              .map((change) => change.path)
              .join(", ")
              .slice(0, 1024),
          },
        ];
      if (isCodexKnownItem(item)) return [];
      return [
        {
          ...base,
          kind: "unknown" as const,
          label: item.type,
          status: "unknown" as const,
        },
      ];
    }),
  });
  addTiming(run, turn);
  if (changes.paths.length > 0)
    run.fileChangeSummary = {
      files: changes.paths.length,
      additions: changes.additions,
      deletions: changes.deletions,
      paths: changes.paths.slice(0, 512),
    };
  const result = turn.items.findLast(
    (item): item is Extract<(typeof turn.items)[number], { type: "agentMessage" }> =>
      isCodexKnownItem(item) && item.type === "agentMessage" && item.phase === "final_answer",
  );
  if (result && result.text.trim()) run.result = result.text.slice(0, 16384);
  if (turn.status === "failed" && turn.error) {
    run.failure = {
      code: "codex.turn.failed",
      message: turn.error.message.slice(0, 2048),
      ...(turn.error.additionalDetails
        ? { detail: turn.error.additionalDetails.slice(0, 4096) }
        : {}),
    };
  }
  if (changes.paths.length > 0)
    run.artifacts = changes.paths.slice(0, 512).map((path) => ({ kind: "fileChange", path }));
  return run;
}

export function projectCodexHistoryRuns(input: {
  thread: unknown;
  params: CodexConversationHistoryRunsParams;
  seq: number;
  revision: number;
  logEpoch: string;
}): ReturnType<typeof codexConversationHistoryRunsResultSchema.parse> {
  const { threadId, turns, turnIndexById } = historyPageIndex(input);
  const limit = input.params.limit ?? DEFAULT_PAGE_LIMIT;
  let before = turns.length;
  if (input.params.beforeTurnId) {
    // 游标经 id→下标映射 O(1) 定位；不存在时仍按合同显式失败，客户端从首页重新开始，
    // 绝不静默跨已变更的历史拼页。
    const cursor = turnIndexById.get(input.params.beforeTurnId);
    if (cursor === undefined) throw new Error("Codex history cursor turn no longer exists");
    before = cursor;
  }
  const wanted = input.params.status;
  const runs: CodexHistoryRun[] = [];
  let matched = 0;
  let hasMore = false;
  // 从游标前一条倒序扫描，凑满 limit + 1 条匹配即停：单页成本只与页大小相关，
  // 不再 slice(0, before).reverse() 翻转全表，也不再对整段历史投影 run。
  for (let cursor = before - 1; cursor >= 0; cursor -= 1) {
    const turn = turns[cursor]!;
    if (wanted && projectedStatus(turn) !== wanted) continue;
    matched += 1;
    if (matched > limit) {
      hasMore = true;
      break;
    }
    runs.push(projectRunCached(threadId, turn));
  }
  return codexConversationHistoryRunsResultSchema.parse({
    runs,
    ...(hasMore ? { nextBeforeTurnId: runs.at(-1)?.turnId } : {}),
    atSeq: input.seq,
    atRevision: input.revision,
    atLogEpoch: input.logEpoch,
    source: "native-thread",
  });
}
