import { z } from "zod";
import {
  conversationSnapshotSchema,
  pendingInteractionSchema,
  sessionSummarySchema,
  sessionsIndexSnapshotSchema,
  type ApiRetryState,
  type ConversationSnapshot,
  type PlanState,
  type SessionControl,
  type SessionSummary,
  type SessionsIndexSnapshot,
  type SessionUsageState,
  type SessionActionAvailability,
} from "@codez/shared/codez-protocol-v4";
import { codexThreadSchema, isCodexKnownItem, type CodexThread } from "./codex-types.js";
import { projectOriginFromSource } from "./project-origin.js";
import { parseCodexTurnCached, projectRows } from "./projection-rows.js";
import { isSelectionSideChatThread } from "./selection-side-chat.js";
import { projectQueue, type QueueAdmissionFacts } from "./projection-queue.js";
import { nativeThreadTitle } from "./native-thread-title.js";

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
  apiRetry?: ApiRetryState | null;
  /** 辅助对话 child 的继承 turn id 集合：投影跳过（spec: codex-selection-side-chat）。 */
  hiddenTurnIds?: ReadonlySet<string>;
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
const codexThreadHeaderSchema = codexThreadSchema.omit({ turns: true });
const conversationSnapshotEnvelopeSchema = conversationSnapshotSchema.omit({ rows: true });
const summaryPreviewCache = new WeakMap<
  CodexThread,
  {
    updatedAt: number;
    turnsLength: number;
    lastTurn: CodexThread["turns"][number] | undefined;
    lastTurnItemsLength: number;
    preview: string | undefined;
  }
>();

function resolveLastAssistantPreview(source: CodexThread): string | undefined {
  const lastTurn = source.turns.at(-1);
  const lastTurnItemsLength = lastTurn?.items.length ?? 0;
  const cached = summaryPreviewCache.get(source);
  if (
    cached &&
    cached.updatedAt === source.updatedAt &&
    cached.turnsLength === source.turns.length &&
    cached.lastTurn === lastTurn &&
    cached.lastTurnItemsLength === lastTurnItemsLength
  ) {
    return cached.preview;
  }
  let preview: string | undefined;
  outer: for (let turnIndex = source.turns.length - 1; turnIndex >= 0; turnIndex -= 1) {
    const items = source.turns[turnIndex]!.items;
    for (let itemIndex = items.length - 1; itemIndex >= 0; itemIndex -= 1) {
      const item = items[itemIndex]!;
      if (isCodexKnownItem(item) && item.type === "agentMessage") {
        // 120 个 Unicode code points 最多占 240 个 UTF-16 code units；先 slice(0, 480) 避免把长文拆成数万元素数组。
        preview = Array.from(item.text.slice(0, 480)).slice(0, 120).join("");
        break outer;
      }
    }
  }
  summaryPreviewCache.set(source, {
    updatedAt: source.updatedAt,
    turnsLength: source.turns.length,
    lastTurn,
    lastTurnItemsLength,
    preview,
  });
  return preview;
}

/** 增量校验 CodexThread：已完成且未变的 turn 复用 parseCodexTurnCached，避免流式期间每帧全历史重跑 Zod。 */
export function parseCodexThreadIncremental(thread: unknown): CodexThread {
  const raw = thread && typeof thread === "object" ? (thread as { turns?: unknown }) : undefined;
  if (!raw || !Array.isArray(raw.turns)) return codexThreadSchema.parse(thread);
  const header = codexThreadHeaderSchema.parse(thread);
  const turns = raw.turns.map((turn) => parseCodexTurnCached(turn));
  return { ...header, turns };
}

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

function control(thread: CodexThread, apiRetry: ApiRetryState | null = null): SessionControl {
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
    apiRetry: activeTurn ? apiRetry : null,
  };
}

function projectLatestPlanState(thread: CodexThread): PlanState | null {
  for (let turnIndex = thread.turns.length - 1; turnIndex >= 0; turnIndex -= 1) {
    const turn = thread.turns[turnIndex]!;
    for (let itemIndex = turn.items.length - 1; itemIndex >= 0; itemIndex -= 1) {
      const item = turn.items[itemIndex]!;
      const rawPlan = (item as unknown as { plan?: unknown }).plan;
      if (item.type !== "planUpdate" || !Array.isArray(rawPlan)) continue;
      const items: PlanState["items"] = [];
      for (const [index, rawEntry] of rawPlan.entries()) {
        if (typeof rawEntry !== "object" || rawEntry === null) continue;
        const entry = rawEntry as { step?: unknown; status?: unknown };
        const content = typeof entry.step === "string" ? entry.step.trim() : "";
        const rawStatus = entry.status;
        const status: PlanState["items"][number]["status"] | null =
          rawStatus === "pending" || rawStatus === "completed"
            ? rawStatus
            : rawStatus === "in_progress" || rawStatus === "inProgress"
              ? "inProgress"
              : null;
        if (!content || !status) continue;
        items.push({
          id: `${turn.id}:plan:${index + 1}`,
          content,
          status,
        });
      }
      if (items.length === 0) continue;
      const updatedAtSec = turn.completedAt ?? turn.startedAt ?? thread.updatedAt;
      return {
        items,
        updatedAt: Math.max(0, Math.floor(updatedAtSec * 1000)),
      };
    }
  }
  return null;
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
  const source = parseCodexThreadIncremental(thread);
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
  const rows = projectRows(source, interactions, options.hiddenTurnIds);
  const state = control(source, options.apiRetry);
  const waiting = source.status.type === "active" && source.status.activeFlags.length > 0;
  // Bug 原因：把上一回合 failed 当作永久 admission 错误，GUI 会一直禁用输入框。
  // Codex 的 systemError 可保留到下一轮；仅在已有明确失败终态时开放显式续发，
  // 错误/历史仍保留，审批、未加载的 active turn 和未知系统错误继续走原门禁。
  const unresolvedError = state.phase === "error" && source.turns.at(-1)?.status !== "failed";
  const unavailable = { allowed: false as const, reasonCode: "guard.codex.capabilityUnknown" };
  // projectRows 已对每条新行做过 conversationRowSchema.parse，避免每帧在全历史 rows 上再跑一遍深度 Zod 校验。
  const envelope = conversationSnapshotEnvelopeSchema.parse({
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
      waiting || interactions.length > 0 || unresolvedError
        ? { mode: "reject", reasonCode: "guard.codex.authorityRequired" }
        : state.phase === "running"
          ? state.canStop
            ? { mode: "enqueue" }
            : { mode: "reject", reasonCode: "guard.codex.turnNotLoaded" }
          : { mode: "startNow" },
    // Codex name has no provenance. V4 requires a source, so default means not certified custom/generated.
    meta: { title: nativeThreadTitle(source), titleSource: "default" },
    config: {
      provider: options.provider ?? source.modelProvider,
      model: options.model ?? source.model ?? "",
      thought: source.reasoningEffort ?? "",
      thoughtLevels: [],
      // 与 busy 默认投递一致（queue）：组合键反向投递因而是 startNow 抢占，
      // 由命令层 interrupt+start 实现（specs/codex-desktop-adapter.md）。
      followupMode: "queue",
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
    plan: projectLatestPlanState(source),
  });
  return {
    ...envelope,
    rows: { window: rows, totalCount: rows.length, firstRowId: rows[0]?.rowId ?? null },
  };
}

export function projectSessionSummary(thread: unknown, workspacePath: string): SessionSummary {
  const source = parseCodexThreadIncremental(thread);
  const state = control(source);
  const lastAssistantPreview = resolveLastAssistantPreview(source);
  const parentSessionId = source.forkedFromId ?? source.parentThreadId;
  const originProjectId = projectOriginFromSource(source.threadSource);
  return sessionSummarySchema.parse({
    sessionId: source.id,
    workspaceId: nonempty.parse(workspacePath),
    ...(parentSessionId ? { parentSessionId } : {}),
    ...(originProjectId !== undefined ? { originProjectId } : {}),
    title: nativeThreadTitle(source),
    phase: state.phase,
    sessionEnded: state.sessionEnded,
    // Thread does not include a background-work inventory; do not infer it from active flags.
    hasBackgroundWork: false,
    createdAt: source.createdAt * 1000,
    lastActivityAt: source.updatedAt * 1000,
    ...(lastAssistantPreview !== undefined ? { lastAssistantPreview } : {}),
  });
}

/** Canonical native thread-list input: validate every record, then retain one newest record
 * per native thread ID. Equal timestamps keep the first encountered record and first position. */
export function canonicalNativeThreads(threads: readonly unknown[]): unknown[] {
  const parsed = threads.map((thread) => parseCodexThreadIncremental(thread));
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
  const sessions = canonicalNativeThreads(threads)
    // 辅助对话 child 不进任务列表；身份由持久化 threadSource 判定，重启后一致。
    .filter((thread) => !isSelectionSideChatThread(thread))
    .map((thread) => projectSessionSummary(thread, workspaceId));
  return sessionsIndexSnapshotSchema.parse({
    protocolVersion: 1,
    workspaceId,
    logEpoch: nonempty.parse(options.logEpoch),
    sessions,
  });
}
