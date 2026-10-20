import { redactFeedbackText } from "@codez/shared";
import {
  FEEDBACK_DIAGNOSTIC_FIELD_IDS,
  FEEDBACK_DIAGNOSTIC_FIELD_LABEL_IDS,
  buildFeedbackBody,
  buildFeedbackDiagnosticEntries,
  buildFeedbackIssueTitle,
  buildFeedbackPrefilledUrl,
  type FeedbackDiagnosticEntry,
  type FeedbackDiagnosticFieldId,
  type FeedbackDiagnosticRuntime,
} from "@/feedback/feedbackDiagnostics.js";

/**
 * 反馈入口传入的现场上下文。
 * 调用方无需预先脱敏，所有字段由 `feedbackEntryPlan` 在唯一消费点统一走 `redactFeedbackText`。
 */
export interface FeedbackEntryContext {
  /** 显式指定的 Issue 标题（如任务标题或 Feature request: 前缀）。 */
  title?: string;
  /** 用户可见的错误摘要，进入诊断的 error 字段并优先参与标题推导。 */
  errorSummary?: string;
  /** 问题描述或模板正文，进入诊断的 notes 字段。 */
  description?: string;
  /** 反馈类型：产品建议在缺省标题时使用 `Feature request: ` 前缀。 */
  kind?: "bug" | "feature";
}

/**
 * 预填内容的唯一脱敏收口点（幂等）。
 * 覆盖 title / errorSummary / description 三条进入对外 URL 的路径。
 */
export function redactFeedbackEntryText(text: string | undefined): string | undefined {
  const trimmed = text?.trim();
  return trimmed ? redactFeedbackText(trimmed) : undefined;
}

function redactEntryContext(context: FeedbackEntryContext): FeedbackEntryContext {
  const errorSummary = redactFeedbackEntryText(context.errorSummary);
  const description = redactFeedbackEntryText(context.description);
  const title = redactFeedbackEntryText(context.title);
  return {
    ...(errorSummary ? { errorSummary } : {}),
    ...(description ? { description } : {}),
    ...(title ? { title } : {}),
    ...(context.kind ? { kind: context.kind } : {}),
  };
}

export function buildFeedbackEntryDiagnostics(options: {
  context: FeedbackEntryContext;
  runtime?: FeedbackDiagnosticRuntime;
}): FeedbackDiagnosticEntry[] {
  const context = redactEntryContext(options.context);
  return buildFeedbackDiagnosticEntries(
    {
      ...(context.errorSummary ? { errorSummary: context.errorSummary } : {}),
      ...(context.description ? { description: context.description } : {}),
    },
    options.runtime ?? {},
  );
}

export function buildFeedbackEntryBody(options: {
  context: FeedbackEntryContext;
  diagnosticFields?: readonly FeedbackDiagnosticFieldId[];
  locale: "zh-CN" | "en-US";
  formatMessage: (id: string, values?: Record<string, string>) => string;
  runtime?: FeedbackDiagnosticRuntime;
}): string {
  const selectedFields = options.diagnosticFields ?? FEEDBACK_DIAGNOSTIC_FIELD_IDS;
  const entries = buildFeedbackEntryDiagnostics({
    context: options.context,
    ...(options.runtime ? { runtime: options.runtime } : {}),
  });
  const attachmentHint = options.formatMessage("feedback.github.attachmentHint");
  return buildFeedbackBody(
    entries
      .filter((entry) => selectedFields.includes(entry.id))
      .map((entry) => ({
        label: options.formatMessage(FEEDBACK_DIAGNOSTIC_FIELD_LABEL_IDS[entry.id]),
        value: entry.value,
      })),
    {
      locale: options.locale,
      ...(attachmentHint && attachmentHint !== "feedback.github.attachmentHint"
        ? { attachmentHint }
        : {}),
    },
  );
}

/**
 * Issue 标题优先级：入口显式 title → 错误摘要首行 → 描述首行 → 类型默认标题。
 * 标题同样对外可见，统一经过 redactEntryContext 并限长 80 字符。
 */
export function resolveFeedbackEntryTitle(context: FeedbackEntryContext): string {
  const redacted = redactEntryContext(context);
  const resolved =
    redacted.title?.trim() ||
    buildFeedbackIssueTitle(redacted.errorSummary) ||
    buildFeedbackIssueTitle(redacted.description) ||
    (redacted.kind === "feature" ? "Feature request: " : "");
  return resolved.slice(0, 80);
}

export function buildFeatureRequestTemplateBody(
  formatMessage: (id: string, values?: Record<string, string>) => string,
): string {
  return redactFeedbackText(
    [
      `## ${formatMessage("feedback.featureRequest.descriptionLabel")}`,
      formatMessage("feedback.submit.template.section.supplement"),
      "",
      `## ${formatMessage("feedback.featureRequest.solutionLabel")}`,
      formatMessage("feedback.submit.template.section.supplement"),
      "",
      `## ${formatMessage("feedback.submit.template.section.featureSource")}`,
      formatMessage("feedback.featureRequest.source"),
    ].join("\n"),
  );
}

export function buildFeedbackEntryUrl(options: {
  context: FeedbackEntryContext;
  locale: "zh-CN" | "en-US";
  formatMessage: (id: string, values?: Record<string, string>) => string;
  runtime?: FeedbackDiagnosticRuntime;
  repositoryUrl?: string;
  maxUrlLength?: number;
}): string | null {
  const { context, locale, formatMessage, runtime, repositoryUrl, maxUrlLength } = options;
  const effectiveContext: FeedbackEntryContext =
    context.kind === "feature" && !context.description
      ? {
          ...context,
          title: context.title ?? "Feature request: ",
          description: buildFeatureRequestTemplateBody(formatMessage),
        }
      : context;
  const truncatedNotice = formatMessage("feedback.github.truncatedNotice");
  return buildFeedbackPrefilledUrl({
    ...(repositoryUrl !== undefined ? { repositoryUrl } : {}),
    ...(maxUrlLength !== undefined ? { maxUrlLength } : {}),
    title: resolveFeedbackEntryTitle(effectiveContext),
    body: buildFeedbackEntryBody({
      context: effectiveContext,
      locale,
      formatMessage,
      ...(runtime ? { runtime } : {}),
    }),
    locale,
    ...(truncatedNotice && truncatedNotice !== "feedback.github.truncatedNotice"
      ? { truncatedNotice }
      : {}),
  });
}
