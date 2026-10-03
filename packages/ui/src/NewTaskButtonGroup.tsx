import { ChevronDown, MessageCirclePlus } from "lucide-react";
import type { ReactNode } from "react";
import { TID_TASK_NEW_BUTTON } from "@codez/shared";
import { Button } from "@/components/ui/button.js";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu.js";
import { cn } from "@/components/lib/utils.js";
import { useCodezIntl } from "@/i18n/IntlProvider.js";
import { useShortcutCommandLabel } from "@/shortcuts/useShortcutBindings.js";
import { runUserAction } from "@/lib/userActionTelemetry.js";

export function NewTaskButtonGroup({
  onCreateTask,
  disabled = false,
  menuContent,
  menuLabel,
}: {
  onCreateTask: () => void;
  disabled?: boolean;
  menuContent?: ReactNode;
  menuLabel?: string;
}) {
  const { intl } = useCodezIntl();
  const newTaskShortcutLabel = useShortcutCommandLabel("newTask");
  const menuTriggerLabel = menuLabel ?? intl.formatMessage({ id: "taskList.newThread" });

  const handleCreateTask = () => {
    if (disabled) {
      return;
    }
    runUserAction({
      input: { featureId: "task.lifecycle", action: "create", trigger: "button" },
      operation: onCreateTask,
      completed: { resultSource: "optimistic_projection" },
      failureStage: "task_create",
    });
  };

  return (
    <DropdownMenu>
      <div
        role="group"
        aria-disabled={disabled}
        className={cn(
          "group inline-flex h-8 w-full shrink-0 items-stretch justify-stretch overflow-hidden rounded-lg",
          disabled ? "text-foreground-subtlest" : "text-foreground hover:bg-surface-hover",
        )}
      >
        <Button
          type="button"
          variant="ghost"
          size="lg"
          data-testid={TID_TASK_NEW_BUTTON}
          aria-label={intl.formatMessage({ id: "taskList.newThread" })}
          disabled={disabled}
          onClick={handleCreateTask}
          className={cn(
            "h-8 min-w-0 flex-1 justify-start gap-2 rounded-none border-0 px-2.5 text-ui-base active:translate-y-0",
            disabled && "hover:bg-transparent disabled:text-foreground-subtlest",
          )}
        >
          <MessageCirclePlus className="h-4 w-4 shrink-0" />
          <span className="min-w-0 flex-1 truncate text-left">
            {intl.formatMessage({ id: "taskList.newThread" })}
          </span>
          {newTaskShortcutLabel ? (
            <span className="ml-auto shrink-0 text-ui-xs font-normal text-foreground-subtlest">
              {newTaskShortcutLabel}
            </span>
          ) : null}
        </Button>
        {menuContent ? (
          <DropdownMenuTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon-lg"
              className="h-8 w-8 shrink-0 rounded-none border-0 px-0 text-foreground-subtlest disabled:text-foreground-subtlest"
              disabled={disabled}
              aria-label={menuTriggerLabel}
              title={menuTriggerLabel}
            >
              <ChevronDown className="size-4" aria-hidden="true" />
            </Button>
          </DropdownMenuTrigger>
        ) : null}
      </div>
      {menuContent ? <DropdownMenuContent align="end">{menuContent}</DropdownMenuContent> : null}
    </DropdownMenu>
  );
}
