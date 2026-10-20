import type { useCodezIntl } from "@/i18n/IntlProvider.js";
import { RetryErrorDetailsPopover } from "@/chat-input-toolbar/display.js";

export function CodexRetryStatus({
  httpStatusCode,
  attempt = null,
  maxRetries = null,
  errorDetail = null,
  intl,
}: {
  httpStatusCode: number | null;
  attempt?: number | null;
  maxRetries?: number | null;
  errorDetail?: string | null;
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
    <RetryErrorDetailsPopover
      detail={errorDetail}
      intl={intl}
      retryLabel={retryLabel}
      testId="v4-codex-retry-status"
      className="px-1 text-ui-base"
    >
      <span className="animated-gradient-text animated-gradient-text-subtle min-w-0 break-words whitespace-normal font-medium">
        {retryLabel}
      </span>
    </RetryErrorDetailsPopover>
  );
}
