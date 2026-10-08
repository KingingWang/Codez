import { useState } from "react";
import { resolveCodexTitleModel, type AppSettings, type CodexTitleModel } from "@codez/shared";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select.js";
import type { CodexModelCatalog } from "./codexModelCatalog.js";
import { CodexNotice, CodexSection } from "./CodexSettingsParts.js";
import { useCodexMessages } from "./messages.js";

const INHERIT = "inherit";
const modelKey = (model: CodexTitleModel) => JSON.stringify([model.providerId, model.modelId]);

export function CodexTitleModelSettings({
  settings,
  catalog,
  catalogError,
  workspacePath,
  workspaceIdentity,
  settingsError,
  update,
}: {
  settings: AppSettings | null;
  catalog?: CodexModelCatalog;
  catalogError?: string;
  workspacePath: string;
  workspaceIdentity?: string;
  settingsError?: unknown;
  update: (patch: Partial<AppSettings>) => Promise<void>;
}) {
  const text = useCodexMessages();
  const [error, setError] = useState(false);
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);
  const key = workspaceIdentity?.trim() || workspacePath;
  const override = settings?.codexTitleWorkspaceModels?.[key];
  const global = settings?.codexTitleDefaultModel;
  const effective = settings
    ? resolveCodexTitleModel(settings, workspacePath, workspaceIdentity)
    : null;
  const effectiveLabel = effective
    ? (catalog?.groups
        .find((group) => group.providerId === effective.providerId)
        ?.models.find((model) => model.model === effective.modelId)?.displayName ??
      effective.modelId)
    : "";
  const options = new Map<string, CodexTitleModel>();
  for (const group of catalog?.groups ?? []) {
    for (const model of group.models) {
      options.set(modelKey({ providerId: group.providerId, modelId: model.model }), {
        providerId: group.providerId,
        modelId: model.model,
      });
    }
  }
  const configured = catalog?.configuredSelection;
  if (configured)
    options.set(modelKey(configured), {
      providerId: configured.providerId,
      modelId: configured.modelId,
    });

  async function save(patch: Partial<AppSettings>) {
    setError(false);
    setSaved(false);
    setBusy(true);
    try {
      await update(patch);
      setSaved(true);
    } catch {
      setError(true);
    } finally {
      setBusy(false);
    }
  }

  function modelItems() {
    return (
      <>
        {catalog?.groups.map((group) => (
          <SelectGroup key={group.providerId}>
            <SelectLabel>{group.providerName}</SelectLabel>
            {group.models.map((model) => {
              const ref = { providerId: group.providerId, modelId: model.model };
              return (
                <SelectItem key={modelKey(ref)} value={modelKey(ref)}>
                  {model.displayName}
                </SelectItem>
              );
            })}
          </SelectGroup>
        ))}
        {configured &&
        !catalog?.groups.some(
          (group) =>
            group.providerId === configured.providerId &&
            group.models.some((model) => model.model === configured.modelId),
        ) ? (
          <SelectItem value={modelKey(configured)}>
            {configured.modelId} · {text.configured}
          </SelectItem>
        ) : null}
      </>
    );
  }

  function picker(
    label: string,
    value: string,
    onChange: (value: string) => void,
    inherit = false,
  ) {
    const unavailable = value !== INHERIT && !options.has(value);
    return (
      <div className="min-w-0 space-y-1 text-ui-sm">
        <span>{label}</span>
        <Select
          value={value}
          onValueChange={onChange}
          disabled={!settings || !catalog || Boolean(settingsError) || busy}
        >
          <SelectTrigger aria-label={label} className="w-full">
            <SelectValue placeholder="—" />
          </SelectTrigger>
          <SelectContent>
            {inherit ? <SelectItem value={INHERIT}>{text.titleModelInherit}</SelectItem> : null}
            {unavailable ? (
              <SelectItem value={value} disabled>
                {JSON.parse(value)[1]} · {text.titleModelUnavailable}
              </SelectItem>
            ) : null}
            {modelItems()}
          </SelectContent>
        </Select>
      </div>
    );
  }

  return (
    <CodexSection title={text.titleModelTitle}>
      <p className="text-ui-sm text-foreground-subtle">{text.titleModelHelp}</p>
      {catalogError ? <CodexNotice error>{catalogError}</CodexNotice> : null}
      {settingsError ? <CodexNotice error>{text.titleModelSettingsUnavailable}</CodexNotice> : null}
      <div className="grid gap-3 sm:grid-cols-2">
        {picker(text.titleModelGlobal, global ? modelKey(global) : "", (value) => {
          const model = options.get(value);
          if (model) void save({ codexTitleDefaultModel: model });
        })}
        {picker(
          text.titleModelWorkspace,
          override ? modelKey(override) : INHERIT,
          (value) => {
            const next = { ...settings?.codexTitleWorkspaceModels };
            if (value === INHERIT) delete next[key];
            else {
              const model = options.get(value);
              if (!model) return;
              next[key] = model;
            }
            void save({ codexTitleWorkspaceModels: next });
          },
          true,
        )}
      </div>
      {effective ? (
        <p className="text-ui-sm text-foreground-subtle">
          {!override ? `${text.titleModelInherit} · ` : ""}
          {effectiveLabel}
        </p>
      ) : null}
      {effective && !options.has(modelKey(effective)) ? (
        <CodexNotice>{text.titleModelUnavailable}</CodexNotice>
      ) : null}
      {error ? <CodexNotice error>{text.failed}</CodexNotice> : null}
      {saved ? (
        <p role="status" className="text-ui-sm text-foreground-subtle">
          {text.titleModelSaved}
        </p>
      ) : null}
    </CodexSection>
  );
}
