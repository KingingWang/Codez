import { Button } from "@/components/ui/button.js";
import { CodexConfirmButton } from "./CodexSettingsParts.js";
import { codexProviderDeleteBlock, type CodexProviderView } from "./codexProviderSettings.js";
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
      className="flex flex-wrap items-center justify-between gap-3 border-t border-border pt-3"
    >
      <div className="min-w-0 flex-1">
        <p className="text-ui-base">
          {view.name}
          {view.isDefault ? (
            <span className="ml-2 rounded bg-surface px-1.5 py-0.5 text-ui-sm text-foreground-subtle">
              {text.providerDefaultBadge}
            </span>
          ) : null}
        </p>
        <p className="break-all font-mono text-ui-sm text-foreground-subtlest">
          {view.id} · {view.wireApi}
          {view.baseUrl ? ` · ${view.baseUrl}` : ""} ·{" "}
          {catalogReady
            ? `${view.modelCount} ${text.providerModelCount}`
            : text.providerModelCountUnknown}
        </p>
        {!view.isDefault && view.modelCount > 0 ? (
          <p className="text-ui-sm text-foreground-subtle">{text.providerDeleteModelsBlocked}</p>
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
