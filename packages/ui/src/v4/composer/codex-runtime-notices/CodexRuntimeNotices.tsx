import { memo } from "react";
import { CheckCircle2Icon, RefreshCwIcon, TriangleAlertIcon } from "lucide-react";
import { cn } from "@/components/lib/utils.js";
import type { CodexRuntimeNoticesProps } from "./contract.js";

export const CodexRuntimeNotices = memo(function CodexRuntimeNotices({
  notices,
}: CodexRuntimeNoticesProps) {
  if (notices.length === 0) return null;
  return notices.map((notice) => {
    const recovered = notice.kind === "authRecovery" && notice.phase === "completed";
    const recovering = notice.kind === "authRecovery" && notice.phase === "started";
    const Icon = recovered ? CheckCircle2Icon : recovering ? RefreshCwIcon : TriangleAlertIcon;
    return (
      <div
        key={notice.id}
        role="status"
        data-testid="v4-codex-runtime-notice"
        data-notice-kind={notice.kind}
        data-notice-phase={notice.phase}
        className={cn(
          "mb-2 flex w-full items-start gap-2 rounded-lg px-3 py-2 text-ui-base",
          recovered
            ? "bg-success-surface text-success-surface-foreground"
            : "bg-warning-surface text-warning-surface-foreground",
        )}
      >
        <Icon
          aria-hidden="true"
          className={cn("mt-0.5 size-4 shrink-0", recovering && "animate-spin")}
        />
        <div className="min-w-0 flex-1">
          <div className="break-words">{notice.message}</div>
          {notice.detail ? (
            <div className="mt-0.5 whitespace-pre-wrap break-words text-ui-sm opacity-90">
              {notice.detail}
            </div>
          ) : null}
          {notice.provider ? (
            <div className="mt-0.5 text-ui-xs opacity-80">{notice.provider}</div>
          ) : null}
        </div>
      </div>
    );
  });
});
