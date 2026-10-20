import type { CodexHookConfigEvent } from "@codez/shared";
import { Button } from "@/components/ui/button.js";
import { Input } from "@/components/ui/input.js";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select.js";
import { Switch } from "@/components/ui/switch.js";
import { SettingsGroupCard } from "@/settings/SettingsPageParts.js";
import {
  CODEX_HOOK_CONFIG_EVENTS,
  type CodexHookFormState,
} from "./codexHooksSettings.js";
import { CodexNotice } from "./CodexSettingsParts.js";
import { useCodexMessages } from "./messages.js";

export function CodexHookForm({
  form,
  formError,
  disabled,
  onChange,
  onClearError,
  onCancel,
  onSubmit,
}: {
  form: CodexHookFormState;
  formError: string | null;
  disabled: boolean;
  onChange: (next: CodexHookFormState) => void;
  onClearError: () => void;
  onCancel: () => void;
  onSubmit: () => void;
}) {
  const text = useCodexMessages();
  return (
    <SettingsGroupCard>
      <div className="space-y-4 p-4">
        {formError ? <CodexNotice error>{formError}</CodexNotice> : null}
        <div className="grid gap-4 sm:grid-cols-2">
          <label className="space-y-1.5">
            <span className="text-ui-sm font-medium text-foreground">{text.hooksFormScope}</span>
            <Select
              value={form.scope}
              disabled={disabled || Boolean(form.originalEntry)}
              onValueChange={(value) => onChange({ ...form, scope: value as "user" | "project" })}
            >
              <SelectTrigger aria-label={text.hooksFormScope}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="project">{text.hooksFormScopeProject}</SelectItem>
                <SelectItem value="user">{text.hooksFormScopeUser}</SelectItem>
              </SelectContent>
            </Select>
          </label>

          <label className="space-y-1.5">
            <span className="text-ui-sm font-medium text-foreground">{text.hooksFormEvent}</span>
            <Select
              value={form.event}
              disabled={disabled}
              onValueChange={(value) =>
                onChange({ ...form, event: value as CodexHookConfigEvent })
              }
            >
              <SelectTrigger aria-label={text.hooksFormEvent}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {CODEX_HOOK_CONFIG_EVENTS.map((eventName) => (
                  <SelectItem key={eventName} value={eventName}>
                    {eventName}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </label>
        </div>

        <label className="block space-y-1.5">
          <span className="text-ui-sm font-medium text-foreground">{text.hooksFormCommand}</span>
          <Input
            aria-label={text.hooksFormCommand}
            value={form.command}
            disabled={disabled}
            placeholder={text.hooksFormCommandPlaceholder}
            onChange={(event) => {
              onClearError();
              onChange({ ...form, command: event.target.value });
            }}
          />
        </label>

        <div className="grid gap-4 sm:grid-cols-3">
          <label className="space-y-1.5">
            <span className="text-ui-sm font-medium text-foreground">{text.hooksFormMatcher}</span>
            <Input
              aria-label={text.hooksFormMatcher}
              value={form.matcher}
              disabled={disabled}
              placeholder={text.hooksFormMatcherPlaceholder}
              onChange={(event) => onChange({ ...form, matcher: event.target.value })}
            />
          </label>

          <label className="space-y-1.5">
            <span className="text-ui-sm font-medium text-foreground">{text.hooksFormTimeout}</span>
            <Input
              aria-label={text.hooksFormTimeout}
              value={form.timeoutSec}
              disabled={disabled}
              placeholder="600"
              onChange={(event) => {
                onClearError();
                onChange({ ...form, timeoutSec: event.target.value });
              }}
            />
          </label>

          <label className="space-y-1.5">
            <span className="text-ui-sm font-medium text-foreground">
              {text.hooksFormStatusMessage}
            </span>
            <Input
              aria-label={text.hooksFormStatusMessage}
              value={form.statusMessage}
              disabled={disabled}
              onChange={(event) => onChange({ ...form, statusMessage: event.target.value })}
            />
          </label>
        </div>

        <div className="flex items-center justify-between gap-3 rounded-md border border-border px-3 py-2">
          <div className="space-y-0.5">
            <p className="text-ui-sm font-medium text-foreground">{text.hooksFormAsync}</p>
            <p className="text-ui-xs text-foreground-subtle">{text.hooksFormAsyncHelp}</p>
          </div>
          <Switch
            aria-label={text.hooksFormAsync}
            checked={form.async}
            disabled={disabled}
            onCheckedChange={(checked) => onChange({ ...form, async: checked })}
          />
        </div>

        <div className="flex justify-end gap-2">
          <Button variant="outline" size="sm" disabled={disabled} onClick={onCancel}>
            {text.cancelAction}
          </Button>
          <Button size="sm" disabled={disabled} onClick={onSubmit}>
            {text.save}
          </Button>
        </div>
      </div>
    </SettingsGroupCard>
  );
}
