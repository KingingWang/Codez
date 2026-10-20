import { RefreshCcw } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import { useCodezIntl } from "@/i18n/IntlProvider.js";
import type { CodexUsageObservationsSnapshot } from "./codexUsageThreads.js";
import {
  CodexUsageObservationNotice,
  CodexUsageObservationSummary,
  useCodexUsageObservations,
} from "./AppUsagePanel.js";

export function CodexOnlyUsageView({
  snapshot,
  error,
  loading = false,
  onRefresh,
}: {
  snapshot: CodexUsageObservationsSnapshot | null;
  error: boolean | null;
  loading?: boolean;
  onRefresh: () => void;
}) {
  const { intl, locale } = useCodezIntl();
  const hasThreads = Boolean(snapshot?.threads.length);
  return (
    <div className="space-y-5">
      <CodexUsageObservationNotice intl={intl} />
      {error ? (
        <p role="alert" className="text-ui-sm text-destructive">
          {intl.formatMessage({ id: "settings.usage.appUsage.observationReadError" })}
        </p>
      ) : null}
      {hasThreads ? (
        <CodexUsageObservationSummary observations={snapshot} intl={intl} locale={locale} />
      ) : error ? null : !loading ? (
        <p role="status" className="text-ui-sm text-foreground-subtle">
          {intl.formatMessage({ id: "settings.usage.appUsage.observationEmpty" })}
        </p>
      ) : (
        <p role="status" className="text-ui-sm text-foreground-subtle">
          {intl.formatMessage({ id: "settings.usage.appUsage.observationLoading" })}
        </p>
      )}
      <div className="flex justify-end">
        <Button type="button" variant="outline" size="sm" onClick={onRefresh} disabled={loading}>
          <RefreshCcw className="size-3.5" />
          {intl.formatMessage({ id: "settings.usage.refresh" })}
        </Button>
      </div>
    </div>
  );
}

export function CodexOnlyUsagePanel({
  workspaceIdentity,
  workspacePath,
}: {
  workspaceIdentity?: string;
  workspacePath?: string;
}) {
  const observation = useCodexUsageObservations({ workspaceIdentity, workspacePath });
  return (
    <CodexOnlyUsageView
      snapshot={observation.snapshot}
      error={observation.error}
      loading={observation.loading}
      onRefresh={() => void observation.refresh()}
    />
  );
}
