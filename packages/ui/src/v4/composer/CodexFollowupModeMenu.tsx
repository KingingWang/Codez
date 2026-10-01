import { memo } from "react";
import { ChevronDownIcon, CornerDownRightIcon, ListPlusIcon } from "lucide-react";
import { TID_V4_COMPOSER_INPUT } from "@codez/shared";
import { Button } from "@/components/ui/button.js";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu.js";
import { useCodezIntl } from "@/i18n/IntlProvider.js";

export type CodexFollowupIntent = "queue" | "guide";

interface CodexFollowupModeMenuProps {
  intent: CodexFollowupIntent;
  disabled: boolean;
  onChange: (intent: CodexFollowupIntent) => void;
}

function CodexFollowupModeMenuImpl({ intent, disabled, onChange }: CodexFollowupModeMenuProps) {
  const { intl } = useCodezIntl();
  const label = (mode: CodexFollowupIntent) =>
    intl.formatMessage({ id: `chat.followup.mode.${mode}` });
  const title = intl.formatMessage({ id: "chat.followup.mode.trigger" }, { mode: label(intent) });
  const Icon = intent === "guide" ? CornerDownRightIcon : ListPlusIcon;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={disabled}
          data-testid="v4-codex-followup-mode"
          aria-label={title}
          className="h-7 min-w-0 shrink-0 gap-1 rounded-lg px-2 text-ui-sm text-foreground-subtle hover:text-foreground"
        >
          <Icon className="size-4 shrink-0" />
          <span className="truncate">{label(intent)}</span>
          <ChevronDownIcon className="size-3 shrink-0" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        side="top"
        align="end"
        sideOffset={4}
        className="w-64"
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          document.querySelector<HTMLElement>(`[data-testid="${TID_V4_COMPOSER_INPUT}"]`)?.focus();
        }}
      >
        <DropdownMenuRadioGroup
          value={intent}
          onValueChange={(value) => {
            if (value === "queue" || value === "guide") onChange(value);
          }}
        >
          {(["queue", "guide"] as const).map((mode) => {
            const OptionIcon = mode === "guide" ? CornerDownRightIcon : ListPlusIcon;
            return (
              <DropdownMenuRadioItem key={mode} value={mode} className="min-h-12 gap-2 py-2">
                <OptionIcon className="size-4 shrink-0" />
                <span className="flex min-w-0 flex-col gap-0.5">
                  <span className="text-ui-base">{label(mode)}</span>
                  <span className="text-ui-sm text-foreground-subtle">
                    {intl.formatMessage({ id: `chat.followup.mode.${mode}.description` })}
                  </span>
                </span>
              </DropdownMenuRadioItem>
            );
          })}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export const CodexFollowupModeMenu = memo(CodexFollowupModeMenuImpl);
