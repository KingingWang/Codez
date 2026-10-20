import {
  codexConversationHistoryRunsResultSchema,
  codexHistoryRunSchema,
  type CodexHistoryRun,
  type CodexHistoryRunStatus,
  type CodexConversationHistoryRunsParams,
} from "@codez/shared/codez-protocol-v4";
import {
  codexThreadSchema,
  codexTurnSchema,
  isCodexKnownItem,
  type CodexTurn,
} from "./codex-types.js";

function addTiming(run: CodexHistoryRun, turn: CodexTurn): void {
  if (turn.startedAt !== undefined && turn.startedAt !== null)
    run.startedAtMs = turn.startedAt * 1000;
  if (turn.completedAt !== undefined && turn.completedAt !== null)
    run.completedAtMs = turn.completedAt * 1000;
  if (turn.durationMs !== undefined && turn.durationMs !== null) run.durationMs = turn.durationMs;
}

function fileChangeFacts(turn: CodexTurn) {
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

function projectRun(threadId: string, turn: CodexTurn): CodexHistoryRun {
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
  const changes = fileChangeFacts(turn);
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
  const source = codexThreadSchema.parse(input.thread);
  const turns = source.turns.map((turn) => codexTurnSchema.parse(turn));
  if (input.params.beforeTurnId && !turns.some((turn) => turn.id === input.params.beforeTurnId))
    throw new Error("Codex history cursor turn no longer exists");
  const before = input.params.beforeTurnId
    ? turns.findIndex((turn) => turn.id === input.params.beforeTurnId)
    : turns.length;
  const candidates = turns.slice(0, before).reverse();
  const matching = input.params.status
    ? candidates.filter((turn) => projectedStatus(turn) === input.params.status)
    : candidates;
  const runs = matching
    .slice(0, input.params.limit ?? 50)
    .map((turn) => projectRun(source.id, turn));
  return codexConversationHistoryRunsResultSchema.parse({
    runs,
    ...(matching.length > runs.length ? { nextBeforeTurnId: runs.at(-1)?.turnId } : {}),
    atSeq: input.seq,
    atRevision: input.revision,
    atLogEpoch: input.logEpoch,
    source: "native-thread",
  });
}
