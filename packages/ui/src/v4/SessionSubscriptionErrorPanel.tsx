import { useCallback } from "react";
import { TID_V4_RETRY_SUBSCRIBE } from "@codez/shared/test-ids";
import { Button } from "@/components/ui/button.js";
import { toast } from "@/components/ui/toast.js";
import { useFeedbackEntryAction } from "@/feedback/useFeedbackEntryAction.js";
import { useCodezIntl } from "@/i18n/IntlProvider.js";
import { buildErrorFeedbackDescription } from "@/lib/errorFeedbackDraft.js";

export interface SessionSubscriptionErrorPanelProps {
  error: string;
  sessionId: string;
  workspacePath: string;
  onReconnect: () => void;
}

export function SessionSubscriptionErrorPanel({
  error,
  sessionId,
  workspacePath,
  onReconnect,
}: SessionSubscriptionErrorPanelProps) {
  const { intl } = useCodezIntl();
  const { runFeedbackEntry } = useFeedbackEntryAction();
  const handleOpenFeedback = useCallback(async () => {
    const outcome = runFeedbackEntry({
      title: error.slice(0, 80),
      errorSummary: error,
      description: buildErrorFeedbackDescription({
        message: error,
        contextLines: [
          intl.formatMessage({ id: "feedback.submit.template.section.taskInfo" }),
          intl.formatMessage({ id: "feedback.submit.template.section.taskId" }, { id: sessionId }),
          intl.formatMessage(
            { id: "feedback.submit.template.section.taskWorkspace" },
            { path: workspacePath },
          ),
        ],
        formatMessage: (id: string, values?: Record<string, string>) =>
          intl.formatMessage({ id }, values),
      }),
    });
    if (outcome === "opened") {
      toast(intl.formatMessage({ id: "chat.error.feedbackOpened" }));
    }
  }, [error, intl, runFeedbackEntry, sessionId, workspacePath]);

  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-3 p-4 text-ui-base">
      <p className="max-w-full break-words text-center font-mono text-destructive">{error}</p>
      <div className="flex flex-wrap items-center justify-center gap-2">
        <Button type="button" variant="outline" onClick={handleOpenFeedback}>
          {intl.formatMessage({ id: "chat.error.feedback" })}
        </Button>
        <Button type="button" data-testid={TID_V4_RETRY_SUBSCRIBE} onClick={onReconnect}>
          {intl.formatMessage({ id: "workspaceSidebar.reconnect" })}
        </Button>
      </div>
    </div>
  );
}
