import { useState, type FocusEvent, type PointerEvent, type ReactElement } from "react";
import { Folder, Globe, Laptop } from "lucide-react";
import {
  parseRemoteWorkspaceIdentity,
  remoteHostIdFromWorkspaceIdentity,
  type CodezTaskMeta,
} from "@codez/shared";
import type { RemoteProjectHost } from "@/project-sidebar/contract.js";
import { useOptionalProjectDirectory } from "@/project-sidebar/ProjectDirectoryProvider.js";
import { remoteHostLabel } from "@/project-sidebar/RemoteHostSection.js";
import { formatGroupedTaskHoverChangeParts } from "@/project-sidebar/grouped/task-row-tooltip.js";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip.js";
import { cn } from "@/components/lib/utils.js";
import { useCodezIntl } from "@/i18n/IntlProvider.js";
import { getPathLeaf } from "@/lib/path.js";
import { getTaskChangeSummary } from "@/lib/taskChangeSummary.js";
import { formatTaskRelativeTime } from "@/lib/taskListItemPresentation.js";
import { resolveTaskSourceLabel } from "@/lib/taskSourceAttribution.js";

export type TaskHoverCardTask = Pick<
  CodezTaskMeta,
  | "title"
  | "forkedFromTaskId"
  | "updatedAt"
  | "workspacePath"
  | "workspaceIdentity"
  | "sourceServerId"
  | "serverDisplayName"
  | "changeSummary"
> & {
  hostId?: string;
};

export interface TaskHoverCardMeta {
  title: string;
  timeLabel: string;
  workspaceLabel: string;
  isRemote: boolean;
  remoteHostLabel: string | null;
  changeParts: string[];
}

function resolveTaskRemoteHostLabel(
  task: TaskHoverCardTask,
  options?: {
    deviceNames?: ReadonlyMap<string, string>;
    hosts?: readonly RemoteProjectHost[];
  },
): string | null {
  const directLabel = resolveTaskSourceLabel(task);
  if (directLabel) {
    return directLabel;
  }
  const identity = task.workspaceIdentity?.trim() ?? "";
  const parsed = identity ? parseRemoteWorkspaceIdentity(identity) : null;
  const sourceServerId =
    task.sourceServerId?.trim() ||
    (parsed?.kind === "server" ? parsed.sourceServerId?.trim() : undefined);
  const fromDeviceNames = sourceServerId ? options?.deviceNames?.get(sourceServerId)?.trim() : null;
  if (fromDeviceNames) {
    return fromDeviceNames;
  }
  const hostId =
    (task.hostId && task.hostId !== "local" ? task.hostId : null) ??
    (identity ? remoteHostIdFromWorkspaceIdentity(identity) : null);
  if (hostId && options?.hosts) {
    const host = options.hosts.find((candidate) => candidate.id === hostId);
    if (host) {
      const label = remoteHostLabel(host).trim();
      if (label) {
        return label;
      }
    }
  }
  if (parsed?.kind === "wsl") {
    return "WSL";
  }
  return null;
}

export function resolveTaskHoverCardMeta(params: {
  task: TaskHoverCardTask;
  workspaceLabel?: string;
  remoteSessionId?: string;
  deviceNames?: ReadonlyMap<string, string>;
  hosts?: readonly RemoteProjectHost[];
  intl: {
    formatMessage: (desc: { id: string }, values?: Record<string, string>) => string;
  };
}): TaskHoverCardMeta {
  const { task, intl } = params;
  const title =
    task.title ||
    intl.formatMessage({
      id: task.forkedFromTaskId ? "taskList.forkedUntitled" : "taskList.untitled",
    });
  const timeLabel = formatTaskRelativeTime(task.updatedAt, intl);
  const workspaceLabel = params.workspaceLabel?.trim() || getPathLeaf(task.workspacePath);
  const isRemote = Boolean(
    (task.hostId && task.hostId !== "local") ||
    task.workspaceIdentity?.trim() ||
    params.remoteSessionId?.trim(),
  );
  const resolvedRemoteHostLabel = isRemote
    ? resolveTaskRemoteHostLabel(task, {
        deviceNames: params.deviceNames,
        hosts: params.hosts,
      })
    : null;
  const changeParts = formatGroupedTaskHoverChangeParts(getTaskChangeSummary(task));
  return {
    title,
    timeLabel,
    workspaceLabel,
    isRemote,
    remoteHostLabel: resolvedRemoteHostLabel,
    changeParts,
  };
}

export function isPointerOnTaskRowActionTarget(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) {
    return false;
  }
  return Boolean(
    target.closest("[data-task-row-actions], [data-archive-confirming-task-id], button"),
  );
}

export function TaskHoverCardContentBody({ meta }: { meta: TaskHoverCardMeta }) {
  return (
    <div data-testid="task-hover-card" className="flex min-w-52 max-w-72 flex-col gap-1.5">
      <div className="flex items-start justify-between gap-2.5">
        <span
          data-testid="task-hover-card-title"
          className="min-w-0 flex-1 break-words text-ui-base font-medium leading-snug text-tooltip-foreground"
        >
          {meta.title}
        </span>
        <span className="mt-0.5 flex shrink-0 items-center gap-1.5 text-ui-sm text-tooltip-foreground/70">
          {meta.changeParts.length > 0 ? (
            <span
              data-testid="task-hover-card-changes"
              className="inline-flex shrink-0 items-center gap-1"
            >
              {meta.changeParts.map((part) => (
                <span
                  key={part}
                  className={part.startsWith("+") ? "text-diff-added" : "text-diff-removed"}
                >
                  {part}
                </span>
              ))}
            </span>
          ) : null}
          {meta.isRemote ? (
            <Globe
              data-testid="task-hover-card-env-icon"
              data-env="remote"
              aria-hidden="true"
              className="size-3.5 shrink-0 text-remote-foreground-muted"
            />
          ) : (
            <Laptop
              data-testid="task-hover-card-env-icon"
              data-env="local"
              aria-hidden="true"
              className="size-3.5 shrink-0 text-tooltip-foreground/70"
            />
          )}
          <span data-testid="task-hover-card-time" className="shrink-0">
            {meta.timeLabel}
          </span>
        </span>
      </div>
      <div
        data-testid="task-hover-card-workspace"
        className="flex min-w-0 items-center gap-1.5 text-ui-sm text-tooltip-foreground/80"
      >
        <Folder aria-hidden="true" className="size-3.5 shrink-0 text-tooltip-foreground/70" />
        <span className="min-w-0 truncate">{meta.workspaceLabel}</span>
      </div>
      {meta.isRemote && meta.remoteHostLabel ? (
        <div
          data-testid="task-hover-card-host"
          className="flex min-w-0 items-center gap-1.5 text-ui-sm text-tooltip-foreground/80"
        >
          <Globe aria-hidden="true" className="size-3.5 shrink-0 text-remote-foreground-muted" />
          <span className="min-w-0 truncate">{meta.remoteHostLabel}</span>
        </div>
      ) : null}
    </div>
  );
}

const TASK_HOVER_CARD_DELAY_MS = 300;

export function TaskHoverCard({
  task,
  workspaceLabel,
  remoteSessionId,
  disabled = false,
  children,
}: {
  task: TaskHoverCardTask;
  workspaceLabel?: string;
  remoteSessionId?: string;
  disabled?: boolean;
  children: ReactElement;
}) {
  const { intl } = useCodezIntl();
  const projectDirectory = useOptionalProjectDirectory();
  const [radixOpen, setRadixOpen] = useState(false);
  const [actionSuppressed, setActionSuppressed] = useState(false);
  const [isHoverNone] = useState(
    () =>
      typeof window !== "undefined" &&
      typeof window.matchMedia === "function" &&
      window.matchMedia("(hover: none)").matches,
  );

  if (disabled || isHoverNone) {
    return children;
  }

  const meta = resolveTaskHoverCardMeta({
    task,
    workspaceLabel,
    remoteSessionId,
    deviceNames: projectDirectory?.deviceNames,
    hosts: projectDirectory?.directory.hosts,
    intl,
  });

  const handlePointerMoveCapture = (event: PointerEvent<HTMLElement>) => {
    const onAction = isPointerOnTaskRowActionTarget(event.target);
    setActionSuppressed((current) => (current === onAction ? current : onAction));
  };

  const handlePointerLeave = () => {
    setActionSuppressed(false);
  };

  const handleFocusCapture = (event: FocusEvent<HTMLElement>) => {
    const onAction =
      event.target !== event.currentTarget && isPointerOnTaskRowActionTarget(event.target);
    setActionSuppressed((current) => (current === onAction ? current : onAction));
  };

  const open = radixOpen && !actionSuppressed;

  return (
    <TooltipProvider
      delayDuration={TASK_HOVER_CARD_DELAY_MS}
      skipDelayDuration={0}
      alwaysDelay
      disableHoverableContent
    >
      <Tooltip open={open} onOpenChange={setRadixOpen}>
        <TooltipTrigger
          asChild
          onPointerMoveCapture={handlePointerMoveCapture}
          onPointerLeave={handlePointerLeave}
          onFocusCapture={handleFocusCapture}
        >
          {children}
        </TooltipTrigger>
        <TooltipContent
          side="right"
          align="start"
          sideOffset={8}
          className={cn("max-w-72 flex-col items-stretch rounded-xl px-3 py-2.5 shadow-md")}
        >
          <TaskHoverCardContentBody meta={meta} />
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
