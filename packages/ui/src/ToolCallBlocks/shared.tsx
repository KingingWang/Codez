import {
  toolAutoApprovalReviewSchema,
  type ToolAutoApprovalReview,
} from "@codez/shared/codez-protocol-v4";
import type { useCodezIntl } from "@/i18n/IntlProvider.js";

export type {
  EditKindLabelId,
  EditKindSource,
  EditOperationKind,
  RawToolCallFileSummary,
  ToolCallBlockRenderContext,
  WorkflowDraftPosition,
  WorkflowRunCardSummary,
} from "@/ToolCallBlocks/fileSummaryTypes.js";
export { readRawToolCallFileSummaries } from "@/ToolCallBlocks/fileSummaries.js";
export {
  getEditKindLabelMessageId,
  renderDiffCount,
  renderFileChip,
  renderFilePath,
  renderJoinedFileChips,
} from "@/ToolCallBlocks/renderers.js";

type IntlLike = Pick<ReturnType<typeof useCodezIntl>["intl"], "formatMessage">;

export function readToolAutoApprovalReview(raw: unknown): ToolAutoApprovalReview | undefined {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return undefined;
  const candidate = (raw as { autoApprovalReview?: unknown }).autoApprovalReview;
  if (candidate === undefined) return undefined;
  const parsed = toolAutoApprovalReviewSchema.safeParse(candidate);
  return parsed.success ? parsed.data : undefined;
}

export function formatAutoApprovalStatusLabel(
  review: ToolAutoApprovalReview,
  intl: IntlLike,
): string {
  const baseId =
    review.status === "inProgress"
      ? review.strictReviewRequired
        ? "chat.autoApproval.inProgressStrict"
        : "chat.autoApproval.inProgress"
      : `chat.autoApproval.${review.status}`;
  const baseLabel = intl.formatMessage({ id: baseId });
  if (!review.riskLevel) return baseLabel;
  const riskLabel = intl.formatMessage({ id: `chat.autoApproval.risk.${review.riskLevel}` });
  return `${baseLabel} (${riskLabel})`;
}

export function formatAutoApprovalTooltipText(
  review: ToolAutoApprovalReview,
  intl: IntlLike,
): string | undefined {
  const lines: string[] = [];
  const statusText = formatAutoApprovalStatusLabel(review, intl);
  if (review.rationale) {
    lines.push(`${statusText}: ${review.rationale}`);
  } else if (review.actionSummary && review.status === "inProgress") {
    lines.push(`${statusText}: ${review.actionSummary}`);
  } else if (review.riskLevel) {
    lines.push(statusText);
  }
  return lines.length > 0 ? lines.join("\n") : undefined;
}

export function formatAutoApprovalMarkerDetail(
  review: ToolAutoApprovalReview | undefined,
  fallbackDetail: string | undefined,
  intl: IntlLike,
): string | undefined {
  if (!review) return fallbackDetail;
  const parts: string[] = [];
  if (review.actionSummary) parts.push(review.actionSummary);
  if (review.riskLevel) {
    parts.push(intl.formatMessage({ id: `chat.autoApproval.risk.${review.riskLevel}` }));
  }
  if (review.rationale) parts.push(review.rationale);
  return parts.length > 0 ? parts.join(" · ") : fallbackDetail;
}
