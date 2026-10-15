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
import {
  CODEX_PROVIDER_WIRE_APIS,
  normalizeCodexProviderWireApi,
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
      {help ? (
        <p className="text-ui-sm text-foreground-subtlest">{help}</p>
      ) : null}
    </div>
  );
}

export function CodexProviderFormView({
  form,
  creating,
  disabled,
  error,
  keySourceSupported,
  hasAuthCommand,
  externalEnvKey,
  managedKeyConfigured,
  onChange,
  onSubmit,
  onCancel,
}: {
  form: CodexProviderForm;
  creating: boolean;
  disabled: boolean;
  error?: string | null;
  /** Host 是否提供本机临时 Key 服务；false 时隐藏来源选择并退回配置文件语义。 */
  keySourceSupported: boolean;
  /** 编辑态：该供应商配置了 [auth] 命令鉴权（与 env_key 互斥）。 */
  hasAuthCommand?: boolean;
  /** 编辑态：现有的非 App 托管 env_key 引用（用户手工外部变量）。 */
  externalEnvKey?: string;
  /** 编辑态 runtime-env：本机凭据是否已存在；false 时提示需重新输入。 */
  managedKeyConfigured?: boolean;
  onChange: (form: CodexProviderForm) => void;
  onSubmit: () => void;
  onCancel: () => void;
}) {
  const text = useCodexMessages();
  const keySourceLockedReason = form.requiresOpenaiAuth
    ? text.providerKeySourceConflictsOpenaiAuth
    : hasAuthCommand
      ? text.providerKeySourceConflictsAuthCommand
      : keySourceSupported
        ? null
        : text.providerKeySourceUnsupported;
  const runtimeEnvSelected =
    form.keySource === "runtime-env" && !keySourceLockedReason;
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
          onChange={(event) =>
            onChange({ ...form, baseUrl: event.target.value })
          }
        />
      </Field>
      <Field id="codex-provider-wire-api" label={text.providerWireApi}>
        <Select
          value={form.wireApi}
          disabled={disabled}
          onValueChange={(value) =>
            onChange({
              ...form,
              wireApi: normalizeCodexProviderWireApi(value),
            })
          }
        >
          <SelectTrigger
            id="codex-provider-wire-api"
            aria-label={text.providerWireApi}
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {CODEX_PROVIDER_WIRE_APIS.map((wireApi) => (
              <SelectItem key={wireApi} value={wireApi}>
                {wireApi}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Field>
      {keySourceSupported && !hasAuthCommand && !form.requiresOpenaiAuth ? (
        <Field id="codex-provider-key-source" label={text.providerKeySource}>
          <Select
            value={form.keySource}
            disabled={disabled}
            onValueChange={(value) =>
              onChange({
                ...form,
                keySource:
                  value === "runtime-env" ? "runtime-env" : "config-file",
                // 切换来源时清空草稿，避免把待写明文误当作待保存的本机 Key。
                bearerToken: "",
                clearBearerToken: false,
              })
            }
          >
            <SelectTrigger
              id="codex-provider-key-source"
              aria-label={text.providerKeySource}
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="config-file">
                {text.providerKeySourceConfigFile}
              </SelectItem>
              <SelectItem value="runtime-env">
                {text.providerKeySourceRuntimeEnv}
              </SelectItem>
            </SelectContent>
          </Select>
        </Field>
      ) : null}
      {runtimeEnvSelected ? (
        <p className="text-ui-sm text-foreground-subtlest">
          {text.providerKeySourceRuntimeEnvWarning}
        </p>
      ) : null}
      {externalEnvKey ? (
        <p className="break-all text-ui-sm text-foreground-subtlest">
          {text.providerExternalEnvKeyNotice}{" "}
          <span className="font-mono">env_key={externalEnvKey}</span>
        </p>
      ) : null}
      {keySourceLockedReason && form.keySource === "runtime-env" ? (
        <p className="text-ui-sm text-foreground-subtlest">
          {keySourceLockedReason}
        </p>
      ) : null}
      <Field
        id="codex-provider-token"
        label={text.providerToken}
        help={
          form.bearerToken
            ? undefined
            : form.keySource === "runtime-env"
              ? text.providerTokenRuntimeEnvHelp
              : text.providerTokenHelp
        }
      >
        <Input
          id="codex-provider-token"
          type="password"
          value={form.bearerToken}
          disabled={disabled || form.clearBearerToken}
          placeholder={text.providerTokenConfigured}
          autoComplete="off"
          onChange={(event) =>
            onChange({ ...form, bearerToken: event.target.value })
          }
        />
      </Field>
      {form.keySource === "runtime-env" && managedKeyConfigured === false ? (
        <p className="text-ui-sm text-foreground-subtle">
          {text.providerKeyNotInstalled}
        </p>
      ) : null}
      {form.keySource === "config-file" ? (
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="text-ui-sm text-foreground-subtle">
            {text.providerTokenClear}
          </p>
          <Switch
            aria-label={text.providerTokenClear}
            checked={form.clearBearerToken}
            disabled={disabled}
            onCheckedChange={(checked) =>
              onChange({ ...form, clearBearerToken: checked, bearerToken: "" })
            }
          />
        </div>
      ) : null}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-ui-sm text-foreground-subtle">
          {text.providerRequiresOpenaiAuth}
        </p>
        <Switch
          aria-label={text.providerRequiresOpenaiAuth}
          checked={form.requiresOpenaiAuth}
          disabled={disabled}
          onCheckedChange={(checked) =>
            onChange({
              ...form,
              requiresOpenaiAuth: checked,
              // Codex 在 requires_openai_auth 下忽略 env_key；开启时退回配置文件来源。
              ...(checked ? { keySource: "config-file" as const } : {}),
            })
          }
        />
      </div>
      {error ? (
        <p className="text-ui-sm text-red-600 dark:text-red-400">{error}</p>
      ) : null}
      <div className="flex flex-wrap gap-2">
        <Button size="sm" disabled={disabled} onClick={onSubmit}>
          {text.providerSave}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          disabled={disabled}
          onClick={onCancel}
        >
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
        help={creating ? text.modelSlugHelp : text.modelSlugEditHelp}
      >
        <Input
          id="codex-model-slug"
          value={form.slug}
          disabled={disabled}
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
          <SelectTrigger
            id="codex-model-provider"
            aria-label={text.modelProvider}
          >
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
          placeholder={
            form.description.trim() || form.slug.trim() || "my-model-v1"
          }
          onChange={(event) =>
            onChange({ ...form, displayName: event.target.value })
          }
        />
      </Field>
      <Field id="codex-model-description" label={text.modelDescription}>
        <Input
          id="codex-model-description"
          value={form.description}
          disabled={disabled}
          placeholder={
            form.displayName.trim() || form.slug.trim() || "my-model-v1"
          }
          onChange={(event) =>
            onChange({ ...form, description: event.target.value })
          }
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
          onChange={(event) =>
            onChange({ ...form, rawJson: event.target.value })
          }
        />
        <p className="text-ui-sm text-foreground-subtlest">
          {text.modelAdvancedJsonHelp}
        </p>
      </details>
      {error ? (
        <p className="text-ui-sm text-red-600 dark:text-red-400">{error}</p>
      ) : null}
      <div className="flex flex-wrap gap-2">
        <Button size="sm" disabled={disabled} onClick={onSubmit}>
          {text.modelSave}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          disabled={disabled}
          onClick={onCancel}
        >
          {text.providerCancel}
        </Button>
      </div>
    </div>
  );
}
