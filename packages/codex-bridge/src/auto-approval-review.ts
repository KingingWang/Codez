import type {
  ConversationRow,
  ToolAutoApprovalReview,
  ToolAutoApprovalReviewStatus,
  ToolAutoApprovalRiskLevel,
  ToolAutoApprovalUserAuthorization,
  ToolCallRow,
} from "@codez/shared/codez-protocol-v4";
import { array, type JsonObject } from "./json.js";
import { codexEventMarker, type RowBase } from "./projection-item-extras.js";

const MAX_REVIEW_ID_CHARS = 256;
const MAX_RATIONALE_CHARS = 4_096;
const MAX_ACTION_SUMMARY_CHARS = 500;

const VALID_STATUSES = new Set<ToolAutoApprovalReviewStatus>([
  "inProgress",
  "approved",
  "denied",
  "timedOut",
  "aborted",
]);
const VALID_RISK_LEVELS = new Set<ToolAutoApprovalRiskLevel>(["low", "medium", "high", "critical"]);
const VALID_USER_AUTHS = new Set<ToolAutoApprovalUserAuthorization>([
  "unknown",
  "low",
  "medium",
  "high",
]);

export interface NativeAutoApprovalReviewEntry {
  reviewId: string;
  turnId: string;
  targetItemId?: string;
  actionType?: string;
  actionSummary?: string;
  status: ToolAutoApprovalReviewStatus;
  riskLevel?: ToolAutoApprovalRiskLevel;
  userAuthorization?: ToolAutoApprovalUserAuthorization;
  rationale?: string;
  strictReviewRequired?: true;
  startedAtMs?: number;
  completedAtMs?: number;
  ordinal: number;
}

export type TurnAutoApprovalReviewsMap = Readonly<
  Record<string, Readonly<Record<string, NativeAutoApprovalReviewEntry>>>
>;

export interface AutoApprovalReviewsStateHolder {
  autoApprovalReviews?: TurnAutoApprovalReviewsMap;
}

function boundedText(value: unknown, max: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  return trimmed.length <= max ? trimmed : `${trimmed.slice(0, max - 1)}…`;
}

function finiteNonNegativeTimestamp(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return undefined;
  return Math.floor(value);
}

function summarizeGuardianAction(action: unknown): {
  actionType?: string;
  actionSummary?: string;
} {
  if (typeof action !== "object" || action === null || Array.isArray(action)) return {};
  const record = action as Record<string, unknown>;
  const actionType = boundedText(record.type, 64);
  let summary: string | undefined;
  switch (actionType) {
    case "command":
      summary = boundedText(record.command, MAX_ACTION_SUMMARY_CHARS);
      break;
    case "execve": {
      const argv = array(record.argv).filter((entry): entry is string => typeof entry === "string");
      const program = boundedText(record.program, MAX_ACTION_SUMMARY_CHARS);
      summary = boundedText(argv.length > 0 ? argv.join(" ") : program, MAX_ACTION_SUMMARY_CHARS);
      break;
    }
    case "writeStdin": {
      const processId = boundedText(record.processId, 120) ?? "terminal";
      const stdin = boundedText(record.stdin, 80);
      summary = boundedText(
        stdin ? `write_stdin (${processId}): ${stdin}` : `write_stdin (${processId})`,
        MAX_ACTION_SUMMARY_CHARS,
      );
      break;
    }
    case "applyPatch": {
      const files = array(record.files).filter(
        (entry): entry is string => typeof entry === "string" && entry.trim().length > 0,
      );
      summary = boundedText(
        files.length === 1
          ? `apply_patch (${files[0]!.trim()})`
          : files.length > 1
            ? `apply_patch (${files.length} files)`
            : "apply_patch",
        MAX_ACTION_SUMMARY_CHARS,
      );
      break;
    }
    case "networkAccess": {
      const target = boundedText(record.target, 240) ?? boundedText(record.host, 240);
      summary = boundedText(
        target ? `network access to ${target}` : "network access",
        MAX_ACTION_SUMMARY_CHARS,
      );
      break;
    }
    case "mcpToolCall": {
      const server = boundedText(record.connectorName, 120) ?? boundedText(record.server, 120);
      const toolName = boundedText(record.toolTitle, 120) ?? boundedText(record.toolName, 120);
      summary = boundedText(
        server && toolName ? `MCP ${server}/${toolName}` : toolName || server || "MCP tool call",
        MAX_ACTION_SUMMARY_CHARS,
      );
      break;
    }
    case "requestPermissions": {
      const reason = boundedText(record.reason, MAX_ACTION_SUMMARY_CHARS);
      summary = boundedText(
        reason ? `permission request: ${reason}` : "permission request",
        MAX_ACTION_SUMMARY_CHARS,
      );
      break;
    }
  }
  return {
    ...(actionType ? { actionType } : {}),
    ...(summary ? { actionSummary: summary } : {}),
  };
}

function parseStatus(
  rawStatus: unknown,
  fallback: ToolAutoApprovalReviewStatus,
): ToolAutoApprovalReviewStatus {
  return typeof rawStatus === "string" &&
    VALID_STATUSES.has(rawStatus as ToolAutoApprovalReviewStatus)
    ? (rawStatus as ToolAutoApprovalReviewStatus)
    : fallback;
}

function parseRiskLevel(rawRisk: unknown): ToolAutoApprovalRiskLevel | undefined {
  return typeof rawRisk === "string" && VALID_RISK_LEVELS.has(rawRisk as ToolAutoApprovalRiskLevel)
    ? (rawRisk as ToolAutoApprovalRiskLevel)
    : undefined;
}

function parseUserAuthorization(rawAuth: unknown): ToolAutoApprovalUserAuthorization | undefined {
  return typeof rawAuth === "string" &&
    VALID_USER_AUTHS.has(rawAuth as ToolAutoApprovalUserAuthorization)
    ? (rawAuth as ToolAutoApprovalUserAuthorization)
    : undefined;
}

/**
 * 应用原生 `item/autoApprovalReview/started`、`item/autoApprovalReview/completed` 与
 * `autoApprovalReview/strictReviewRequired` 通知。
 * 载荷防御性解析：字段缺失或非法时忽略，不让串行事件尾巴报错崩溃。
 */
export function applyNativeAutoApprovalReview(
  state: AutoApprovalReviewsStateHolder,
  method: string,
  params: JsonObject,
): boolean {
  const turnId = boundedText(params.turnId, 256);
  if (!turnId) return false;

  if (method === "autoApprovalReview/strictReviewRequired") {
    const turnMap = state.autoApprovalReviews?.[turnId];
    if (!turnMap) return false;
    let changed = false;
    const nextTurnMap: Record<string, NativeAutoApprovalReviewEntry> = { ...turnMap };
    for (const [reviewId, entry] of Object.entries(turnMap)) {
      if (entry.status === "inProgress" && !entry.strictReviewRequired) {
        nextTurnMap[reviewId] = { ...entry, strictReviewRequired: true };
        changed = true;
      }
    }
    if (!changed) return false;
    state.autoApprovalReviews = {
      ...state.autoApprovalReviews,
      [turnId]: nextTurnMap,
    };
    return true;
  }

  if (
    method !== "item/autoApprovalReview/started" &&
    method !== "item/autoApprovalReview/completed"
  ) {
    return false;
  }

  const reviewId = boundedText(params.reviewId, MAX_REVIEW_ID_CHARS);
  if (!reviewId) return false;
  const rawReview =
    typeof params.review === "object" && params.review !== null && !Array.isArray(params.review)
      ? (params.review as Record<string, unknown>)
      : {};
  const isCompletedEvent = method === "item/autoApprovalReview/completed";
  const incomingStatus = parseStatus(
    rawReview.status,
    isCompletedEvent ? "approved" : "inProgress",
  );
  const existingTurnMap = state.autoApprovalReviews?.[turnId] ?? {};
  const existing = existingTurnMap[reviewId];
  // 终态锁定：已完成（approved/denied/timedOut/aborted）的 review 不被迟到的 started 回退成 inProgress。
  if (existing && existing.status !== "inProgress" && incomingStatus === "inProgress") {
    return false;
  }

  const targetItemId = boundedText(params.targetItemId, 256) ?? existing?.targetItemId;
  const { actionType, actionSummary } = summarizeGuardianAction(params.action);
  const riskLevel = parseRiskLevel(rawReview.riskLevel) ?? existing?.riskLevel;
  const userAuthorization =
    parseUserAuthorization(rawReview.userAuthorization) ?? existing?.userAuthorization;
  const rationale = boundedText(rawReview.rationale, MAX_RATIONALE_CHARS) ?? existing?.rationale;
  const startedAtMs = finiteNonNegativeTimestamp(params.startedAtMs) ?? existing?.startedAtMs;
  const completedAtMs =
    finiteNonNegativeTimestamp(params.completedAtMs) ??
    (incomingStatus !== "inProgress" ? (existing?.completedAtMs ?? startedAtMs) : undefined);
  const ordinal = existing?.ordinal ?? Object.keys(existingTurnMap).length;

  const nextEntry: NativeAutoApprovalReviewEntry = {
    reviewId,
    turnId,
    status: incomingStatus,
    ordinal,
    ...(targetItemId ? { targetItemId } : {}),
    ...((actionType ?? existing?.actionType)
      ? { actionType: (actionType ?? existing?.actionType)! }
      : {}),
    ...((actionSummary ?? existing?.actionSummary)
      ? { actionSummary: (actionSummary ?? existing?.actionSummary)! }
      : {}),
    ...(riskLevel ? { riskLevel } : {}),
    ...(userAuthorization ? { userAuthorization } : {}),
    ...(rationale ? { rationale } : {}),
    ...(existing?.strictReviewRequired ? { strictReviewRequired: true } : {}),
    ...(startedAtMs !== undefined ? { startedAtMs } : {}),
    ...(completedAtMs !== undefined ? { completedAtMs } : {}),
  };

  state.autoApprovalReviews = {
    ...state.autoApprovalReviews,
    [turnId]: {
      ...existingTurnMap,
      [reviewId]: nextEntry,
    },
  };
  return true;
}

/**
 * 当 turn 进入终态（completed / interrupted / failed）时，将该 turn 下仍处于 inProgress 的
 * 自动审批收敛为 aborted，防止中断后卡片永久停留在“正在自动审批”。
 */
export function settleTurnAutoApprovalReviews(
  state: AutoApprovalReviewsStateHolder,
  turnId: unknown,
  turnStatus: unknown,
): void {
  if (typeof turnId !== "string" || turnStatus === "inProgress") return;
  const turnMap = state.autoApprovalReviews?.[turnId];
  if (!turnMap) return;
  let changed = false;
  const nextTurnMap: Record<string, NativeAutoApprovalReviewEntry> = { ...turnMap };
  for (const [reviewId, entry] of Object.entries(turnMap)) {
    if (entry.status === "inProgress") {
      nextTurnMap[reviewId] = {
        ...entry,
        status: "aborted",
      };
      changed = true;
    }
  }
  if (changed) {
    state.autoApprovalReviews = {
      ...state.autoApprovalReviews,
      [turnId]: nextTurnMap,
    };
  }
}

export function toToolAutoApprovalReview(
  entry: NativeAutoApprovalReviewEntry,
): ToolAutoApprovalReview {
  return {
    reviewId: entry.reviewId,
    status: entry.status,
    ...(entry.riskLevel ? { riskLevel: entry.riskLevel } : {}),
    ...(entry.userAuthorization ? { userAuthorization: entry.userAuthorization } : {}),
    ...(entry.rationale ? { rationale: entry.rationale } : {}),
    ...(entry.actionSummary ? { actionSummary: entry.actionSummary } : {}),
    ...(entry.strictReviewRequired ? { strictReviewRequired: true } : {}),
    ...(entry.startedAtMs !== undefined ? { startedAt: entry.startedAtMs } : {}),
    ...(entry.completedAtMs !== undefined ? { completedAt: entry.completedAtMs } : {}),
  };
}

export function turnAutoApprovalSignature(
  turnReviews: Readonly<Record<string, NativeAutoApprovalReviewEntry>> | undefined,
): string {
  if (!turnReviews) return "";
  const entries = Object.values(turnReviews).toSorted((a, b) => a.ordinal - b.ordinal);
  if (entries.length === 0) return "";
  return JSON.stringify(entries);
}

/**
 * 判断该 review 是否可以挂载到同 turn 下的目标工具行：
 * - 必须带 targetItemId 且同 turn 的 items 中存在该 id；
 * - writeStdin 是已运行命令的子级输入审批，不能覆盖父命令卡片的审批状态，固定走独立时间线行。
 */
export function canAnchorAutoApprovalToToolItem(
  entry: NativeAutoApprovalReviewEntry,
  turnItemIds: ReadonlySet<string>,
): boolean {
  if (!entry.targetItemId || entry.actionType === "writeStdin") return false;
  return turnItemIds.has(entry.targetItemId);
}

/**
 * 为单个工具 item 选择需要挂载的自动审批状态（如 execve 产生多次子审查时：
 * 优先展示正在进行的 inProgress 或非通过终态 denied/timedOut/aborted，否则取最新一条）。
 */
export function selectAnchoredAutoApprovalForItem(
  itemId: string,
  turnReviews: Readonly<Record<string, NativeAutoApprovalReviewEntry>> | undefined,
  turnItemIds: ReadonlySet<string>,
): ToolAutoApprovalReview | undefined {
  if (!turnReviews) return undefined;
  const candidates = Object.values(turnReviews)
    .filter(
      (entry) =>
        entry.targetItemId === itemId && canAnchorAutoApprovalToToolItem(entry, turnItemIds),
    )
    .toSorted((a, b) => a.ordinal - b.ordinal);
  if (candidates.length === 0) return undefined;
  const active = candidates.findLast((entry) => entry.status === "inProgress");
  if (active) return toToolAutoApprovalReview(active);
  const rejected = candidates.findLast(
    (entry) =>
      entry.status === "denied" || entry.status === "timedOut" || entry.status === "aborted",
  );
  if (rejected) return toToolAutoApprovalReview(rejected);
  return toToolAutoApprovalReview(candidates.at(-1)!);
}

/**
 * 当工具因自动审批被拒绝或超时而结束时，将 Guardian 的结论与 rationale 同步写入工具错误或保留在卡片上，
 * 让未展开状态及错误详情直接可读。
 */
export function decorateToolRowWithAutoApproval(
  row: ToolCallRow,
  review: ToolAutoApprovalReview | undefined,
): ToolCallRow {
  if (!review) return row;
  row.autoApprovalReview = review;
  if (
    (review.status === "denied" || review.status === "timedOut") &&
    review.rationale &&
    (!row.error || row.error.code.startsWith("codex."))
  ) {
    row.error = {
      code:
        review.status === "timedOut" ? "codex.autoApproval.timedOut" : "codex.autoApproval.denied",
      message: review.rationale,
    };
  }
  return row;
}

function formatUnanchoredAutoApprovalDetail(
  entry: NativeAutoApprovalReviewEntry,
): string | undefined {
  const parts: string[] = [];
  if (entry.actionSummary) parts.push(entry.actionSummary);
  if (entry.riskLevel) parts.push(`risk: ${entry.riskLevel}`);
  if (entry.rationale) parts.push(entry.rationale);
  return parts.length > 0 ? parts.join(" · ") : undefined;
}

export function buildUnanchoredAutoApprovalMarkerRow(
  entry: NativeAutoApprovalReviewEntry,
  base: RowBase,
): ConversationRow {
  const projected = toToolAutoApprovalReview(entry);
  const markerRow = codexEventMarker(
    base,
    "autoApprovalReview",
    formatUnanchoredAutoApprovalDetail(entry),
    entry.status === "inProgress" ? "running" : "completed",
  );
  if (markerRow.kind === "timelineMarker" && markerRow.marker.type === "codexEvent") {
    markerRow.marker.autoApprovalReview = projected;
  }
  return markerRow;
}
