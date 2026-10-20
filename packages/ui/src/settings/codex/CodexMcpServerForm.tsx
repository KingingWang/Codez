import { Button } from "@/components/ui/button.js";
import { Input } from "@/components/ui/input.js";
import { Textarea } from "@/components/ui/textarea.js";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select.js";
import { CodexNotice } from "./CodexSettingsParts.js";
import { useCodexMessages } from "./messages.js";
import type { CodexMcpKeyValueRow, CodexMcpServerFormState } from "./codexMcpSettings.js";

function KeyValueRows({
  idPrefix,
  rows,
  disabled,
  addLabel,
  onChange,
}: {
  idPrefix: string;
  rows: CodexMcpKeyValueRow[];
  disabled: boolean;
  addLabel: string;
  onChange: (rows: CodexMcpKeyValueRow[]) => void;
}) {
  return (
    <div className="space-y-2">
      {rows.map((row, index) => (
        <div key={`${idPrefix}-${index}`} className="flex flex-wrap items-center gap-2">
          <Input
            aria-label={`${idPrefix}-key-${index}`}
            className="min-w-0 flex-1 font-mono"
            value={row.key}
            disabled={disabled}
            placeholder="KEY"
            onChange={(event) =>
              onChange(rows.map((r, i) => (i === index ? { ...r, key: event.target.value } : r)))
            }
          />
          <Input
            aria-label={`${idPrefix}-value-${index}`}
            className="min-w-0 flex-1 font-mono"
            value={row.value}
            disabled={disabled}
            placeholder="value"
            onChange={(event) =>
              onChange(rows.map((r, i) => (i === index ? { ...r, value: event.target.value } : r)))
            }
          />
          <Button
            size="sm"
            variant="ghost"
            disabled={disabled}
            onClick={() => onChange(rows.filter((_, i) => i !== index))}
          >
            ×
          </Button>
        </div>
      ))}
      <Button
        size="sm"
        variant="outline"
        disabled={disabled}
        onClick={() => onChange([...rows, { key: "", value: "" }])}
      >
        {addLabel}
      </Button>
    </div>
  );
}

export function CodexMcpServerForm({
  form,
  creating,
  disabled,
  busy,
  error,
  onChange,
  onSubmit,
  onCancel,
}: {
  form: CodexMcpServerFormState;
  creating: boolean;
  disabled: boolean;
  busy: boolean;
  error?: string;
  onChange: (form: CodexMcpServerFormState) => void;
  onSubmit: () => void;
  onCancel: () => void;
}) {
  const text = useCodexMessages();
  return (
    <div className="space-y-3 rounded-lg border border-border bg-surface p-3">
      {creating ? (
        <div className="space-y-1">
          <label className="text-ui-sm text-foreground-subtle" htmlFor="codex-mcp-scope">
            {text.mcpFormScope}
          </label>
          <Select
            value={form.scope}
            disabled={disabled}
            onValueChange={(value) =>
              onChange({ ...form, scope: value === "project" ? "project" : "user" })
            }
          >
            <SelectTrigger id="codex-mcp-scope" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="user">{text.mcpScopeUser}</SelectItem>
              <SelectItem value="project">{text.mcpScopeProject}</SelectItem>
            </SelectContent>
          </Select>
          <p className="text-ui-sm text-foreground-subtlest">{text.mcpFormScopeHelp}</p>
        </div>
      ) : null}
      <div className="space-y-1">
        <label className="text-ui-sm text-foreground-subtle" htmlFor="codex-mcp-name">
          {text.mcpFormName}
        </label>
        <Input
          id="codex-mcp-name"
          value={form.name}
          disabled={disabled || Boolean(form.originalName)}
          onChange={(event) => onChange({ ...form, name: event.target.value })}
        />
        <p className="text-ui-sm text-foreground-subtlest">
          {form.originalName ? text.agentsNameLocked : text.mcpFormNameHelp}
        </p>
      </div>
      <div className="space-y-1">
        <label className="text-ui-sm text-foreground-subtle" htmlFor="codex-mcp-transport">
          {text.mcpFormTransport}
        </label>
        <Select
          value={form.transport}
          disabled={disabled}
          onValueChange={(value) =>
            onChange({ ...form, transport: value === "http" ? "http" : "stdio" })
          }
        >
          <SelectTrigger id="codex-mcp-transport" className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="stdio">stdio</SelectItem>
            <SelectItem value="http">http</SelectItem>
          </SelectContent>
        </Select>
      </div>
      {form.transport === "stdio" ? (
        <>
          <div className="space-y-1">
            <label className="text-ui-sm text-foreground-subtle" htmlFor="codex-mcp-command">
              {text.mcpFormCommand}
            </label>
            <Input
              id="codex-mcp-command"
              className="font-mono"
              value={form.command}
              disabled={disabled}
              placeholder="npx"
              onChange={(event) => onChange({ ...form, command: event.target.value })}
            />
          </div>
          <div className="space-y-1">
            <label className="text-ui-sm text-foreground-subtle" htmlFor="codex-mcp-args">
              {text.mcpFormArgs}
            </label>
            <Textarea
              id="codex-mcp-args"
              className="font-mono"
              rows={3}
              value={form.argsText}
              disabled={disabled}
              placeholder={"-y\n@modelcontextprotocol/server-filesystem\n/path"}
              onChange={(event) => onChange({ ...form, argsText: event.target.value })}
            />
          </div>
          <div className="space-y-1">
            <span className="text-ui-sm text-foreground-subtle">{text.mcpFormEnv}</span>
            <KeyValueRows
              idPrefix="codex-mcp-env"
              rows={form.envRows}
              disabled={disabled}
              addLabel={text.mcpFormAddRow}
              onChange={(envRows) => onChange({ ...form, envRows })}
            />
          </div>
          <div className="space-y-1">
            <label className="text-ui-sm text-foreground-subtle" htmlFor="codex-mcp-cwd">
              {text.mcpFormCwd}
            </label>
            <Input
              id="codex-mcp-cwd"
              className="font-mono"
              value={form.cwd}
              disabled={disabled}
              onChange={(event) => onChange({ ...form, cwd: event.target.value })}
            />
          </div>
        </>
      ) : (
        <>
          <div className="space-y-1">
            <label className="text-ui-sm text-foreground-subtle" htmlFor="codex-mcp-url">
              {text.mcpFormUrl}
            </label>
            <Input
              id="codex-mcp-url"
              className="font-mono"
              value={form.url}
              disabled={disabled}
              placeholder="https://example.com/mcp"
              onChange={(event) => onChange({ ...form, url: event.target.value })}
            />
          </div>
          <div className="space-y-1">
            <span className="text-ui-sm text-foreground-subtle">{text.mcpFormHeaders}</span>
            <KeyValueRows
              idPrefix="codex-mcp-header"
              rows={form.headerRows}
              disabled={disabled}
              addLabel={text.mcpFormAddRow}
              onChange={(headerRows) => onChange({ ...form, headerRows })}
            />
          </div>
          <div className="space-y-1">
            <label className="text-ui-sm text-foreground-subtle" htmlFor="codex-mcp-bearer">
              {text.mcpFormBearerEnv}
            </label>
            <Input
              id="codex-mcp-bearer"
              className="font-mono"
              value={form.bearerTokenEnvVar}
              disabled={disabled}
              onChange={(event) => onChange({ ...form, bearerTokenEnvVar: event.target.value })}
            />
            <p className="text-ui-sm text-foreground-subtlest">{text.mcpFormBearerEnvHelp}</p>
          </div>
        </>
      )}
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1">
          <label className="text-ui-sm text-foreground-subtle" htmlFor="codex-mcp-startup-timeout">
            {text.mcpFormStartupTimeout}
          </label>
          <Input
            id="codex-mcp-startup-timeout"
            value={form.startupTimeoutSec}
            disabled={disabled}
            onChange={(event) => onChange({ ...form, startupTimeoutSec: event.target.value })}
          />
        </div>
        <div className="space-y-1">
          <label className="text-ui-sm text-foreground-subtle" htmlFor="codex-mcp-tool-timeout">
            {text.mcpFormToolTimeout}
          </label>
          <Input
            id="codex-mcp-tool-timeout"
            value={form.toolTimeoutSec}
            disabled={disabled}
            onChange={(event) => onChange({ ...form, toolTimeoutSec: event.target.value })}
          />
        </div>
      </div>
      {error ? <CodexNotice error>{error}</CodexNotice> : null}
      <div className="flex flex-wrap gap-2">
        <Button size="sm" disabled={disabled} onClick={onSubmit}>
          {text.save}
        </Button>
        <Button size="sm" variant="ghost" disabled={busy} onClick={onCancel}>
          {text.cancelAction}
        </Button>
      </div>
    </div>
  );
}
