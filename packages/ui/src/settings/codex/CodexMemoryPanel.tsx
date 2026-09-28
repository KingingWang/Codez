import { useState } from "react";
import { codexConfigWriteResponseSchema, type CodexRequest } from "@codez/shared";
import { Input } from "@/components/ui/input.js";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select.js";
import { Switch } from "@/components/ui/switch.js";
import type { CodexSettingsController } from "@/hooks/useCodexSettings.js";
import {
  CODEX_MEMORY_NUMBER_FIELDS,
  codexMemoryConfigView,
  codexMemoryEdit,
  codexMemoryNumberEdit,
  type CodexMemoryNumberField,
} from "./codexMemorySettings.js";
import { codexUserConfigTarget } from "./codexSettingsData.js";
import { CodexNotice, CodexSection } from "./CodexSettingsParts.js";
import { useCodexMessages } from "./messages.js";

const MEMORY_MODEL_DEFAULT_VALUE = "__default__";

function MemoryToggleRow({
  label,
  help,
  checked,
  disabled,
  onChange,
}: {
  label: string;
  help: string;
  checked: boolean;
  disabled: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3">
      <div className="min-w-0 flex-1 space-y-1 text-ui-sm">
        <p className="text-ui-base">{label}</p>
        <p className="text-foreground-subtle">{help}</p>
      </div>
      <Switch aria-label={label} checked={checked} disabled={disabled} onCheckedChange={onChange} />
    </div>
  );
}

function MemoryModelSelect({
  label,
  help,
  value,
  models,
  disabled,
  defaultLabel,
  onChange,
}: {
  label: string;
  help: string;
  value: string | undefined;
  models: { model: string; displayName: string }[];
  disabled: boolean;
  defaultLabel: string;
  onChange: (value: string | null) => void;
}) {
  // 已配置但目录里查不到的模型仍要可见可选，否则用户无法切回默认。
  const known = value === undefined || models.some((entry) => entry.model === value);
  return (
    <div className="flex flex-wrap items-center justify-between gap-3">
      <div className="min-w-0 flex-1 space-y-1 text-ui-sm">
        <p className="text-ui-base">{label}</p>
        <p className="text-foreground-subtle">{help}</p>
      </div>
      <Select
        value={value ?? MEMORY_MODEL_DEFAULT_VALUE}
        disabled={disabled}
        onValueChange={(next) => onChange(next === MEMORY_MODEL_DEFAULT_VALUE ? null : next)}
      >
        <SelectTrigger aria-label={label} className="w-56">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={MEMORY_MODEL_DEFAULT_VALUE}>{defaultLabel}</SelectItem>
          {models.map((entry) => (
            <SelectItem key={entry.model} value={entry.model}>
              {entry.displayName}
            </SelectItem>
          ))}
          {!known && value ? <SelectItem value={value}>{value}</SelectItem> : null}
        </SelectContent>
      </Select>
    </div>
  );
}

function MemoryNumberRow({
  label,
  field,
  value,
  disabled,
  help,
  invalidLabel,
  onCommit,
}: {
  label: string;
  field: CodexMemoryNumberField;
  value: number | undefined;
  disabled: boolean;
  help: string;
  invalidLabel: string;
  onCommit: (field: CodexMemoryNumberField, raw: string) => boolean;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const [invalid, setInvalid] = useState(false);
  const shown = draft ?? (value === undefined ? "" : String(value));
  return (
    <div className="flex flex-wrap items-center justify-between gap-3">
      <div className="min-w-0 flex-1 space-y-1 text-ui-sm">
        <p className="text-ui-base">{label}</p>
        <p className="text-foreground-subtle">
          {`${field.min} - ${field.max} · ${invalid ? invalidLabel : `${help}（默认 ${field.defaultValue}）`}`}
        </p>
      </div>
      <Input
        aria-label={label}
        className="w-28"
        inputMode="numeric"
        disabled={disabled}
        value={shown}
        placeholder={String(field.defaultValue)}
        onChange={(event) => {
          setDraft(event.target.value);
          setInvalid(false);
        }}
        onBlur={() => {
          if (draft === null) return;
          const ok = onCommit(field, draft);
          setInvalid(!ok);
          setDraft(null);
        }}
        onKeyDown={(event) => {
          if (event.key !== "Enter") return;
          event.currentTarget.blur();
        }}
      />
    </div>
  );
}

export function CodexMemoryPanel({ controller }: { controller: CodexSettingsController }) {
  const text = useCodexMessages();
  const [notice, setNotice] = useState<string | null>(null);
  const config = controller.snapshot.config?.data;
  const target = codexUserConfigTarget(config);
  const view = codexMemoryConfigView(config);
  const models = (controller.snapshot.models?.data?.data ?? []).filter((entry) => !entry.hidden);
  const disabled = controller.busy || controller.loading || !controller.enabled || !target;

  async function writeEdits(edits: ReturnType<typeof codexMemoryEdit>[]) {
    setNotice(null);
    // reloadUserConfig 让原生把新用户层配置热刷新进所有已加载线程，
    // 与原生 TUI 写记忆设置同一机制；不重启 server，不等下次打开 APP。
    const request: CodexRequest = {
      method: "config/batchWrite",
      params: { ...target, edits, reloadUserConfig: true },
    };
    const result = codexConfigWriteResponseSchema.parse(await controller.request(request));
    setNotice(result.status === "okOverridden" ? text.overridden : text.saved);
  }

  const applyEdits = (edits: ReturnType<typeof codexMemoryEdit>[]) =>
    void controller.run(async () => {
      await writeEdits(edits);
    });

  const applyToggle = (keyPath: string, checked: boolean) =>
    applyEdits([codexMemoryEdit(keyPath, checked)]);

  const commitNumber = (field: CodexMemoryNumberField, raw: string): boolean => {
    const edit = codexMemoryNumberEdit(field, raw);
    if (!edit) return false;
    applyEdits([edit]);
    return true;
  };

  return (
    <div className="space-y-4">
      <CodexSection title={text.memory}>
        <CodexNotice>{text.memoryHelp}</CodexNotice>
        {controller.snapshot.config?.error ? (
          <CodexNotice error>{controller.snapshot.config.error}</CodexNotice>
        ) : null}
        {notice ? <CodexNotice>{notice}</CodexNotice> : null}
        <MemoryToggleRow
          label={text.memoryEnable}
          help={text.memoryEnableHelp}
          checked={view.featureEnabled}
          disabled={Boolean(disabled)}
          onChange={(checked) => applyToggle("features.memories", checked)}
        />
        {view.featureEnabled ? (
          <>
            <MemoryToggleRow
              label={text.memoryUse}
              help={text.memoryUseHelp}
              checked={view.useMemories !== false}
              disabled={Boolean(disabled)}
              onChange={(checked) => applyToggle("memories.use_memories", checked)}
            />
            <MemoryToggleRow
              label={text.memoryGenerate}
              help={text.memoryGenerateHelp}
              checked={view.generateMemories !== false}
              disabled={Boolean(disabled)}
              onChange={(checked) => applyToggle("memories.generate_memories", checked)}
            />
            <MemoryToggleRow
              label={text.memoryDedicatedTools}
              help={text.memoryDedicatedToolsHelp}
              checked={view.dedicatedTools === true}
              disabled={Boolean(disabled)}
              onChange={(checked) => applyToggle("memories.dedicated_tools", checked)}
            />
            <MemoryToggleRow
              label={text.memoryDisableOnExternalContext}
              help={text.memoryDisableOnExternalContextHelp}
              checked={view.disableOnExternalContext === true}
              disabled={Boolean(disabled)}
              onChange={(checked) => applyToggle("memories.disable_on_external_context", checked)}
            />
            <MemoryModelSelect
              label={text.memoryExtractModel}
              help={text.memoryExtractModelHelp}
              value={view.extractModel}
              models={models}
              disabled={Boolean(disabled)}
              defaultLabel={text.memoryModelDefault}
              onChange={(next) => applyEdits([codexMemoryEdit("memories.extract_model", next)])}
            />
            <MemoryModelSelect
              label={text.memoryConsolidationModel}
              help={text.memoryConsolidationModelHelp}
              value={view.consolidationModel}
              models={models}
              disabled={Boolean(disabled)}
              defaultLabel={text.memoryModelDefault}
              onChange={(next) =>
                applyEdits([codexMemoryEdit("memories.consolidation_model", next)])
              }
            />
          </>
        ) : null}
      </CodexSection>
      {view.featureEnabled ? (
        <CodexSection title={text.memoryAdvanced}>
          {CODEX_MEMORY_NUMBER_FIELDS.map((field) => (
            <MemoryNumberRow
              key={field.key}
              label={text[field.labelKey]}
              field={field}
              value={view[field.key]}
              disabled={Boolean(disabled)}
              help={text.memoryNumberHelp}
              invalidLabel={text.memoryNumberInvalid}
              onCommit={commitNumber}
            />
          ))}
        </CodexSection>
      ) : null}
    </div>
  );
}
