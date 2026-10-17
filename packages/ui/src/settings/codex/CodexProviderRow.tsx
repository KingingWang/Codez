import { Package } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import { CodexConfirmButton } from "./CodexSettingsParts.js";
import {
  codexProviderDeleteBlock,
  isCodexManagedEnvKey,
  type CodexProviderView,
} from "./codexProviderSettings.js";
import { useCodexMessages } from "./messages.js";

export function CodexProviderRow({
  view,
  disabled,
  catalogReady,
  onSetDefault,
  onEdit,
  onDelete,
}: {
  view: CodexProviderView;
  disabled: boolean;
  catalogReady: boolean;
  onSetDefault(): void;
  onEdit(): void;
  onDelete(): void;
}) {
  const text = useCodexMessages();
  return (
    <div
      data-testid={`codex-provider-row-${view.id}`}
      className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-3 px-4 py-3 transition-colors hover:bg-hover"
    >
      <div
        className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-background text-foreground-subtle"
        aria-hidden="true"
      >
        <Package className="size-4" />
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <p className="truncate text-ui-base font-medium text-foreground">{view.name}</p>
          {view.isDefault ? (
            <span className="inline-flex min-h-5 items-center rounded-md bg-background px-1.5 py-0.5 text-ui-xs text-foreground-subtle ring-1 ring-border">
              {text.providerDefaultBadge}
            </span>
          ) : null}
          {isCodexManagedEnvKey(view.envKey) ? (
            <span className="inline-flex min-h-5 items-center rounded-md bg-background px-1.5 py-0.5 text-ui-xs text-foreground-subtle ring-1 ring-border">
              {text.providerDeviceKeyBadge}
            </span>
          ) : null}
        </div>
        <p className="mt-0.5 break-all font-mono text-ui-sm text-foreground-subtlest">
          {view.id} · {view.wireApi}
          {view.baseUrl ? ` · ${view.baseUrl}` : ""} ·{" "}
          {catalogReady
            ? `${view.modelCount} ${text.providerModelCount}`
            : text.providerModelCountUnknown}
        </p>
        {!view.isDefault && view.modelCount > 0 ? (
          <p className="mt-0.5 text-ui-sm text-foreground-subtle">
            {text.providerDeleteModelsBlocked}
          </p>
        ) : null}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        {!view.isDefault ? (
          <Button variant="outline" size="sm" disabled={disabled} onClick={onSetDefault}>
            {text.providerSetDefault}
          </Button>
        ) : null}
        <Button variant="outline" size="sm" disabled={disabled} onClick={onEdit}>
          {text.providerEdit}
        </Button>
        <CodexConfirmButton
          label={text.providerDelete}
          disabled={disabled || codexProviderDeleteBlock(view, catalogReady) !== null}
          onConfirm={onDelete}
        />
      </div>
    </div>
  );
}
