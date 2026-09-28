import { Input } from "@/components/ui/input.js";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select.js";
import { Switch } from "@/components/ui/switch.js";
import { Textarea } from "@/components/ui/textarea.js";
import { Button } from "@/components/ui/button.js";
import type {
  CodexModelForm,
  CodexProviderForm,
  CodexProviderView,
} from "./codexProviderSettings.js";
import { useCodexMessages } from "./messages.js";

function Field({
  id,
  label,
  help,
  children,
}: {
  id: string;
  label: string;
  help?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-1">
      <label className="text-ui-sm text-foreground-subtle" htmlFor={id}>
        {label}
      </label>
      {children}
      {help ? <p className="text-ui-sm text-foreground-subtlest">{help}</p> : null}
    </div>
  );
}

export function CodexProviderFormView({
  form,
  creating,
  disabled,
  error,
  onChange,
  onSubmit,
  onCancel,
}: {
  form: CodexProviderForm;
  creating: boolean;
  disabled: boolean;
  error?: string | null;
  onChange: (form: CodexProviderForm) => void;
  onSubmit: () => void;
  onCancel: () => void;
}) {
  const text = useCodexMessages();
  return (
    <div className="space-y-3 rounded-lg border border-border bg-surface p-3">
      <Field
        id="codex-provider-id"
        label={text.providerId}
        help={creating ? text.providerIdHelp : text.providerIdLocked}
      >
        <Input
          id="codex-provider-id"
          value={form.id}
          disabled={disabled || !creating}
          placeholder="my-provider"
          onChange={(event) => onChange({ ...form, id: event.target.value })}
        />
      </Field>
      <Field id="codex-provider-name" label={text.providerName}>
        <Input
          id="codex-provider-name"
          value={form.name}
          disabled={disabled}
          placeholder={form.id || "my-provider"}
          onChange={(event) => onChange({ ...form, name: event.target.value })}
        />
      </Field>
      <Field id="codex-provider-base-url" label={text.providerBaseUrl}>
        <Input
          id="codex-provider-base-url"
          value={form.baseUrl}
          disabled={disabled}
          placeholder="https://api.example.com/v1"
          onChange={(event) => onChange({ ...form, baseUrl: event.target.value })}
        />
      </Field>
      <Field id="codex-provider-wire-api" label={text.providerWireApi}>
        <Select
          value={form.wireApi}
          disabled={disabled}
          onValueChange={(value) =>
            onChange({ ...form, wireApi: value === "responses" ? "responses" : "chat" })
          }
        >
          <SelectTrigger id="codex-provider-wire-api" aria-label={text.providerWireApi}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="chat">chat</SelectItem>
            <SelectItem value="responses">responses</SelectItem>
          </SelectContent>
        </Select>
      </Field>
      <Field
        id="codex-provider-token"
        label={text.providerToken}
        help={form.bearerToken ? undefined : text.providerTokenHelp}
      >
        <Input
          id="codex-provider-token"
          type="password"
          value={form.bearerToken}
          disabled={disabled || form.clearBearerToken}
          placeholder={text.providerTokenConfigured}
          autoComplete="off"
          onChange={(event) => onChange({ ...form, bearerToken: event.target.value })}
        />
      </Field>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-ui-sm text-foreground-subtle">{text.providerTokenClear}</p>
        <Switch
          aria-label={text.providerTokenClear}
          checked={form.clearBearerToken}
          disabled={disabled}
          onCheckedChange={(checked) =>
            onChange({ ...form, clearBearerToken: checked, bearerToken: "" })
          }
        />
      </div>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-ui-sm text-foreground-subtle">{text.providerRequiresOpenaiAuth}</p>
        <Switch
          aria-label={text.providerRequiresOpenaiAuth}
          checked={form.requiresOpenaiAuth}
          disabled={disabled}
          onCheckedChange={(checked) => onChange({ ...form, requiresOpenaiAuth: checked })}
        />
      </div>
      {error ? <p className="text-ui-sm text-red-600 dark:text-red-400">{error}</p> : null}
      <div className="flex flex-wrap gap-2">
        <Button size="sm" disabled={disabled} onClick={onSubmit}>
          {text.providerSave}
        </Button>
        <Button size="sm" variant="ghost" disabled={disabled} onClick={onCancel}>
          {text.providerCancel}
        </Button>
      </div>
    </div>
  );
}

export function CodexCatalogModelFormView({
  form,
  creating,
  providers,
  disabled,
  error,
  onChange,
  onSubmit,
  onCancel,
}: {
  form: CodexModelForm;
  creating: boolean;
  providers: readonly CodexProviderView[];
  disabled: boolean;
  error?: string | null;
  onChange: (form: CodexModelForm) => void;
  onSubmit: () => void;
  onCancel: () => void;
}) {
  const text = useCodexMessages();
  return (
    <div className="space-y-3 rounded-lg border border-border bg-surface p-3">
      <Field
        id="codex-model-slug"
        label={text.modelSlug}
        help={creating ? text.modelSlugHelp : undefined}
      >
        <Input
          id="codex-model-slug"
          value={form.slug}
          disabled={disabled || !creating}
          placeholder="my-model-v1"
          onChange={(event) => onChange({ ...form, slug: event.target.value })}
        />
      </Field>
      <Field id="codex-model-provider" label={text.modelProvider}>
        <Select
          value={form.provider}
          disabled={disabled}
          onValueChange={(value) => onChange({ ...form, provider: value })}
        >
          <SelectTrigger id="codex-model-provider" aria-label={text.modelProvider}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {providers.map((provider) => (
              <SelectItem key={provider.id} value={provider.id}>
                {provider.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Field>
      <Field id="codex-model-display-name" label={text.modelDisplayName}>
        <Input
          id="codex-model-display-name"
          value={form.displayName}
          disabled={disabled}
          onChange={(event) => onChange({ ...form, displayName: event.target.value })}
        />
      </Field>
      <Field id="codex-model-description" label={text.modelDescription}>
        <Input
          id="codex-model-description"
          value={form.description}
          disabled={disabled}
          onChange={(event) => onChange({ ...form, description: event.target.value })}
        />
      </Field>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-ui-sm text-foreground-subtle">{text.modelHidden}</p>
        <Switch
          aria-label={text.modelHidden}
          checked={form.hidden}
          disabled={disabled}
          onCheckedChange={(checked) => onChange({ ...form, hidden: checked })}
        />
      </div>
      <details className="space-y-2">
        <summary className="cursor-pointer text-ui-sm text-foreground-subtle">
          {text.modelAdvancedJson}
        </summary>
        <Textarea
          aria-label={text.modelAdvancedJson}
          className="min-h-40 font-mono text-ui-sm"
          value={form.rawJson}
          disabled={disabled}
          spellCheck={false}
          onChange={(event) => onChange({ ...form, rawJson: event.target.value })}
        />
        <p className="text-ui-sm text-foreground-subtlest">{text.modelAdvancedJsonHelp}</p>
      </details>
      {error ? <p className="text-ui-sm text-red-600 dark:text-red-400">{error}</p> : null}
      <div className="flex flex-wrap gap-2">
        <Button size="sm" disabled={disabled} onClick={onSubmit}>
          {text.modelSave}
        </Button>
        <Button size="sm" variant="ghost" disabled={disabled} onClick={onCancel}>
          {text.providerCancel}
        </Button>
      </div>
    </div>
  );
}
