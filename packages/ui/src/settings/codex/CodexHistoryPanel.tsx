import { memo } from "react";
import { FileDiffIcon, ListChecksIcon } from "lucide-react";
import type { CodexHistoryRun } from "@codez/shared/codez-protocol-v4";
import { useCodexMessages } from "./messages.js";
import { useCodezIntl } from "@/i18n/IntlProvider.js";
import { cn } from "@/components/lib/utils.js";
import { useCodexHistoryRuns } from "@/capabilities/useCodexHistory.js";
import type { ICodezAgentService } from "@codez/services";
import { CodexNotice } from "./CodexSettingsParts.js";

const statusClass = {
  running: "text-warning",
  completed: "text-success",
  failed: "text-destructive",
  interrupted: "text-warning",
  unknown: "text-foreground-subtlest",
} as const;

export function HistoryRunRow({ run }: { run: CodexHistoryRun }) {
  const text = useCodexMessages();
  const { intl } = useCodezIntl();
  const status = intl.formatMessage({ id: `codexHistoryStatus.${run.status}` });
  return (
    <li
      data-codex-history-run={run.turnId}
      className="rounded-lg border border-border bg-card px-3 py-2"
    >
      <div className="flex min-w-0 items-center gap-2">
        <span className={cn("shrink-0 text-ui-sm font-medium", statusClass[run.status])}>
          {status}
        </span>
        <span className="min-w-0 flex-1 truncate font-mono text-ui-sm text-foreground-subtle">
          {run.turnId}
        </span>
        {run.durationMs !== undefined ? (
          <span className="shrink-0 text-ui-sm text-foreground-subtlest">
            {intl.formatMessage(
              { id: "codexHistoryDuration" },
              { count: String(Math.max(1, Math.round(run.durationMs / 1000))) },
            )}
          </span>
        ) : null}
      </div>
      {run.toolChain.length > 0 ? (
        <p className="mt-1 flex min-w-0 items-center gap-1.5 text-ui-sm text-foreground-subtle">
          <ListChecksIcon aria-hidden className="size-3.5 shrink-0" />
          <span className="truncate font-mono">
            {run.toolChain.map((step) => step.label).join(" → ")}
          </span>
        </p>
      ) : null}
      {run.fileChangeSummary ? (
        <p className="mt-1 flex min-w-0 items-center gap-1.5 text-ui-sm text-foreground-subtle">
          <FileDiffIcon aria-hidden className="size-3.5 shrink-0" />
          <span className="truncate">
            {intl.formatMessage(
              { id: "codexHistoryFileChanges" },
              {
                files: String(run.fileChangeSummary.files),
                additions: String(run.fileChangeSummary.additions),
                deletions: String(run.fileChangeSummary.deletions),
              },
            )}
          </span>
        </p>
      ) : null}
      {run.result ? (
        <p className="mt-1 line-clamp-2 text-ui-sm text-foreground">{run.result}</p>
      ) : null}
      {run.failure ? (
        <p className="mt-1 line-clamp-2 text-ui-sm text-destructive">{run.failure.message}</p>
      ) : null}
      <p className="mt-1 text-ui-xs text-foreground-subtlest">
        {run.usage === undefined
          ? text.codexHistoryUsageUnavailable
          : text.codexHistoryUsageAvailable}
      </p>
      {run.artifacts?.length ? (
        <p className="mt-1 truncate font-mono text-ui-xs text-foreground-subtlest">
          <span className="font-sans">{text.codexHistoryArtifacts}: </span>
          {run.artifacts.map((artifact) => artifact.path).join(", ")}
        </p>
      ) : null}
    </li>
  );
}

export const CodexHistoryPanel = memo(function CodexHistoryPanel({
  agentService,
  workspacePath,
  workspaceIdentity,
  sessionId,
}: {
  agentService: Pick<ICodezAgentService, "helloConversationV4" | "codexHistoryRunsV4">;
  workspacePath?: string | null;
  workspaceIdentity?: string;
  sessionId: string;
}) {
  const text = useCodexMessages();
  const state = useCodexHistoryRuns({
    hello: agentService,
    source: agentService,
    workspacePath,
    workspaceIdentity,
    sessionId,
  });
  return (
    <section data-testid="codex-history-panel" className="space-y-3">
      <div>
        <h3 className="text-ui-base font-medium">{text.codexHistoryTitle}</h3>
        <p className="mt-1 text-ui-sm text-foreground-subtle">{text.codexHistoryDescription}</p>
      </div>
      {state.status === "unavailable" ? (
        <CodexNotice>{text.unsupported}</CodexNotice>
      ) : state.status === "no-session" ? (
        <CodexNotice>{text.codexHistoryNoSession}</CodexNotice>
      ) : state.status === "transport-unavailable" ? (
        <CodexNotice>{text.codexHistoryTransportUnavailable}</CodexNotice>
      ) : state.status === "loading" ? (
        <CodexNotice>{text.codexHistoryLoading}</CodexNotice>
      ) : state.status === "error" ? (
        <CodexNotice error>{state.message}</CodexNotice>
      ) : state.status === "ready" && state.result.runs.length === 0 ? (
        <CodexNotice>{text.codexHistoryEmpty}</CodexNotice>
      ) : state.status === "ready" ? (
        <ul className="space-y-2">
          {state.result.runs.map((run) => (
            <HistoryRunRow key={run.runId} run={run} />
          ))}
        </ul>
      ) : null}
    </section>
  );
});
