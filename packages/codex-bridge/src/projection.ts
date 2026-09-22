import { z } from "zod";
import {
  conversationSnapshotSchema,
  pendingInteractionSchema,
  sessionSummarySchema,
  sessionsIndexSnapshotSchema,
  type ConversationSnapshot,
  type SessionControl,
  type SessionSummary,
  type SessionsIndexSnapshot,
  type SessionUsageState,
  type SessionActionAvailability,
} from "@zcode/shared/zcode-protocol-v4";
import { codexThreadSchema, isCodexKnownItem, type CodexThread } from "./codex-types.js";
import { projectRows } from "./projection-rows.js";
import { projectQueue, type QueueAdmissionFacts } from "./projection-queue.js";

export { projectRows, projectInputText } from "./projection-rows.js";
export { projectCodexQueue, projectQueue, type QueueAdmissionFacts } from "./projection-queue.js";
export { projectLegacySnapshot } from "./projection-legacy.js";

export interface ProjectThreadOptions {
  workspacePath: string;
  workspaceId?: string;
  workspaceIdentity?: string;
  /** Required for live seq/revision; cold snapshots use a history-only namespace. */
  logEpoch?: string;
  seq?: number;
  revision?: number;
  model?: string;
  provider?: string;
  interactions?: unknown;
  pendingInteractions?: unknown;
  /** Native QueuedSubmission[] or the complete {data,nextCursor} response. */
  queue?: unknown;
  queueAdmissions?: Readonly<Record<string, QueueAdmissionFacts>>;
  usage?: SessionUsageState;
  availability?: Partial<SessionActionAvailability>;
}

export interface SessionsIndexOptions {
  workspacePath: string;
  workspaceId?: string;
  workspaceIdentity?: string;
  /** Host index epoch, independent of any conversation epoch. */
  logEpoch: string;
}

const nonempty = z.string().trim().min(1);
const watermark = z.number().int().nonnegative();

function workspaceKey(
  options: Pick<SessionsIndexOptions, "workspacePath" | "workspaceId" | "workspaceIdentity">,
): string {
  nonempty.parse(options.workspacePath);
  return nonempty.parse(
    options.workspaceId?.trim() || options.workspaceIdentity?.trim() || options.workspacePath,
  );
}

function phase(thread: CodexThread): SessionControl["phase"] {
  if (thread.status.type === "systemError") return "error";
  if (thread.status.type === "active") return "running";
  const last = thread.turns.at(-1);
  if (last?.status === "failed") return "error";
  if (last?.status === "interrupted") return "completedInterrupted";
  if (last?.status === "inProgress") return "running";
  // V4 has no idle/unloaded phase. This is an idle presentation, not proof of a successful run.
  // Persisted Codex threads must never become V4's ephemeral, non-persisted "draft".
  return "completedSuccess";
}

function control(thread: CodexThread): SessionControl {
  const currentPhase = phase(thread);
  const activeTurn =
    currentPhase === "running"
      ? thread.turns.findLast((turn) => turn.status === "inProgress")
      : undefined;
  const last = thread.turns.at(-1);
  return {
    phase: currentPhase,
    sessionEnded: currentPhase === "completedSuccess" || currentPhase === "completedInterrupted",
    canStop: activeTurn !== undefined,
    stopState: activeTurn ? "stoppable" : "idle",
    stopTargetKind: activeTurn ? "assistant" : "unknown",
    activeWorks:
      activeTurn?.startedAt != null
        ? [
            {
              kind: "primaryTurn",
              foregroundExecutionId: activeTurn.id,
              startedAt: activeTurn.startedAt * 1000,
            },
          ]
        : [],
    lastError:
      last?.status === "failed" && last.error
        ? {
            code: "codex.turn.failed",
            message: last.error.message,
            recoverable: false,
            at: (last.completedAt ?? thread.updatedAt) * 1000,
            source: "runtime",
            ...(last.error.additionalDetails ? { detail: last.error.additionalDetails } : {}),
          }
        : null,
    apiRetry: null,
  };
}

/** Pure whole-snapshot projection, never a reducer or accepted-input queue.
 *
 * Codex history → validated facts → deterministic rows → schema-validated snapshot.
 * The caller atomically captures thread + queue + interactions + epoch/seq/revision.
 * Same projection serves desktop-continuous and web-remote-replayable; transport owns
 * delta/gap repair. A rollback, insertion or reorder requires caller epoch rotation.
 *
 * Thread has no usage telemetry, title provenance, permission mode or per-item timing.
 * Required empty strings/zero usage are unavailable display values, not measured facts;
 * capabilities are denied until the control layer can supply them. No fake model binding,
 * tool timestamps, working duration, parsed plan completion or event sequences are emitted.
 */
export function projectThread(
  thread: unknown,
  options: ProjectThreadOptions,
): ConversationSnapshot {
  const source = codexThreadSchema.parse(thread);
  workspaceKey(options);
  const seq = watermark.parse(options.seq ?? 0);
  const revision = watermark.parse(options.revision ?? 0);
  if ((options.seq !== undefined || options.revision !== undefined) && !options.logEpoch) {
    throw new Error("A caller-owned logEpoch is required for live projection watermarks");
  }
  const logEpoch =
    options.logEpoch === undefined
      ? `codex:history:${source.id}`
      : nonempty.parse(options.logEpoch);
  if (options.interactions !== undefined && options.pendingInteractions !== undefined) {
    throw new Error("Supply interactions or pendingInteractions, not both");
  }
  const interactions = pendingInteractionSchema
    .array()
    .parse(options.interactions ?? options.pendingInteractions ?? []);
  const rows = projectRows(source, interactions);
  const state = control(source);
  const waiting = source.status.type === "active" && source.status.activeFlags.length > 0;
  const unavailable = { allowed: false as const, reasonCode: "guard.codex.capabilityUnknown" };
  return conversationSnapshotSchema.parse({
    protocolVersion: 1,
    sessionId: source.id,
    logEpoch,
    seq,
    revision,
    control: state,
    availability: {
      fork: unavailable,
      compact: unavailable,
      switchModelConfig: unavailable,
      setFollowupMode: unavailable,
      queueEdit: unavailable,
      sendQueuedNow: unavailable,
      pauseGoal: unavailable,
      resumeGoal: unavailable,
      ...options.availability,
    },
    inputRouting:
      waiting || interactions.length > 0 || state.phase === "error"
        ? { mode: "reject", reasonCode: "guard.codex.authorityRequired" }
        : state.phase === "running"
          ? state.canStop
            ? { mode: "guide" }
            : { mode: "reject", reasonCode: "guard.codex.turnNotLoaded" }
          : { mode: "startNow" },
    // Codex name has no provenance. V4 requires a source, so default means not certified custom/generated.
    meta: { title: source.name ?? source.preview, titleSource: "default" },
    config: {
      provider: options.provider ?? source.modelProvider,
      model: options.model ?? source.model ?? "",
      thought: source.reasoningEffort ?? "",
      thoughtLevels: [],
      followupMode: "guide",
      mode: "",
    },
    usage: options.usage ?? {
      contextWindow: null,
      cumulative: {
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      },
    },
    queue: projectQueue(options.queue ?? [], options.queueAdmissions),
    pendingInteractions: interactions,
    pendingCommands: [],
    backgroundWorks: [],
    goal: null,
    plan: null,
    rows: { window: rows, totalCount: rows.length, firstRowId: rows[0]?.rowId ?? null },
  });
}

export function projectSessionSummary(thread: unknown, workspacePath: string): SessionSummary {
  const source = codexThreadSchema.parse(thread);
  const state = control(source);
  const lastAssistant = source.turns
    .flatMap((turn) => turn.items)
    .filter(isCodexKnownItem)
    .findLast((item) => item.type === "agentMessage");
  const parentSessionId = source.forkedFromId ?? source.parentThreadId;
  return sessionSummarySchema.parse({
    sessionId: source.id,
    workspaceId: nonempty.parse(workspacePath),
    ...(parentSessionId ? { parentSessionId } : {}),
    title: source.name ?? source.preview,
    phase: state.phase,
    sessionEnded: state.sessionEnded,
    // Thread does not include a background-work inventory; do not infer it from active flags.
    hasBackgroundWork: false,
    createdAt: source.createdAt * 1000,
    lastActivityAt: source.updatedAt * 1000,
    ...(lastAssistant?.type === "agentMessage"
      ? { lastAssistantPreview: Array.from(lastAssistant.text).slice(0, 120).join("") }
      : {}),
  });
}

/** Canonical native thread-list input: validate every record, then retain one newest record
 * per native thread ID. Equal timestamps keep the first encountered record and first position. */
export function canonicalNativeThreads(threads: readonly unknown[]): unknown[] {
  const parsed = threads.map((thread) => codexThreadSchema.parse(thread));
  const winner = new Map<string, { thread: CodexThread; updatedAt: number }>();
  const order: string[] = [];
  for (const thread of parsed) {
    const existing = winner.get(thread.id);
    if (!existing) {
      winner.set(thread.id, { thread, updatedAt: thread.updatedAt });
      order.push(thread.id);
      continue;
    }
    // 同一 rollout 可在多个文件/分页出现；先完整校验，再保留最新且同时间先遇到的记录。
    if (thread.updatedAt > existing.updatedAt)
      winner.set(thread.id, { thread, updatedAt: thread.updatedAt });
  }
  return order.map((id) => winner.get(id)!.thread);
}

export function projectSessionsIndex(
  threads: readonly unknown[],
  options: SessionsIndexOptions,
): SessionsIndexSnapshot {
  const workspaceId = workspaceKey(options);
  const sessions = canonicalNativeThreads(threads).map((thread) =>
    projectSessionSummary(thread, workspaceId),
  );
  return sessionsIndexSnapshotSchema.parse({
    protocolVersion: 1,
    workspaceId,
    logEpoch: nonempty.parse(options.logEpoch),
    sessions,
  });
}
