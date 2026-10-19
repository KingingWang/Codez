import type { useCodezIntl } from "@/i18n/IntlProvider.js";

export function CodexRetryStatus({
  httpStatusCode,
  attempt = null,
  maxRetries = null,
  intl,
}: {
  httpStatusCode: number | null;
  attempt?: number | null;
  maxRetries?: number | null;
  intl: ReturnType<typeof useCodezIntl>["intl"];
}) {
  const label = intl.formatMessage({ id: "chat.codexApiRetryStatus" });
  const hasValidCounts =
    typeof attempt === "number" &&
    typeof maxRetries === "number" &&
    Number.isInteger(attempt) &&
    Number.isInteger(maxRetries) &&
    attempt >= 1 &&
    maxRetries >= attempt;
  const labelWithCount = hasValidCounts ? `${label} ${attempt}/${maxRetries}` : label;
  const retryLabel =
    httpStatusCode === null ? labelWithCount : `${labelWithCount} · HTTP ${httpStatusCode}`;
  return (
    <span
      role="status"
      aria-live="polite"
      data-testid="v4-codex-retry-status"
      className="inline-flex min-h-7 max-w-full min-w-0 items-center px-1 text-ui-base"
      title={retryLabel}
    >
      <span className="animated-gradient-text animated-gradient-text-subtle min-w-0 break-words whitespace-normal font-medium">
        {retryLabel}
      </span>
    </span>
  );
}
