import { useState } from "react";
import {
  codexConfigEditsSchema,
  codexConfigWriteResponseSchema,
  type CodexRequest,
} from "@zcode/shared";
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
import type { CodexSettingsController } from "@/hooks/useCodexSettings.js";
import { codexModelEdits, codexUserConfigTarget } from "./codexSettingsData.js";
import { CodexNotice, CodexSection, codexVisibleConfig } from "./CodexSettingsParts.js";
import { useCodexMessages } from "./messages.js";

function ConfigSelect({
  label,
  value,
  options,
  disabled,
  onChange,
}: {
  label: string;
  value: string;
  options: { value: string; label: string }[];
  disabled: boolean;
  onChange: (value: string) => void;
}) {
  return (
    <div className="min-w-0 space-y-1 text-ui-sm">
      <span>{label}</span>
      <Select value={value} onValueChange={onChange} disabled={disabled}>
        <SelectTrigger aria-label={label} className="w-full">
          <SelectValue placeholder="—" />
        </SelectTrigger>
        <SelectContent>
          {options.map((option) => (
            <SelectItem key={option.value} value={option.value}>
              {option.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

export function CodexConfigPanel({
  controller,
  advanced = false,
}: {
  controller: CodexSettingsController;
  advanced?: boolean;
}) {
  const text = useCodexMessages();
  const [draftModel, setDraftModel] = useState<string | null>(null);
  const [draftEffort, setDraftEffort] = useState<string | null>(null);
  const [approval, setApproval] = useState<string | null>(null);
  const [sandbox, setSandbox] = useState<string | null>(null);
  const [keyPath, setKeyPath] = useState("");
  const [jsonValue, setJsonValue] = useState("");
  const [batch, setBatch] = useState("");
  const [notice, setNotice] = useState<string | null>(null);
  const config = controller.snapshot.config?.data;
  const target = codexUserConfigTarget(config);
  const requirements = controller.snapshot.requirements?.data;
  const disabled =
    controller.busy || controller.loading || !controller.enabled || !target || !requirements;
  const models = controller.snapshot.models?.data?.data ?? [];
  const modelName =
    draftModel ??
    (typeof config?.config.model === "string"
      ? config.config.model
      : models.find((model) => model.isDefault)?.model) ??
    "";
  const model = models.find((entry) => entry.model === modelName);
  const configured = !model && modelName !== "" && modelName === config?.config.model;
  const effort =
    draftEffort ??
    (typeof config?.config.model_reasoning_effort === "string"
      ? config.config.model_reasoning_effort
      : model?.defaultReasoningEffort) ??
    "";
  const approvalValue =
    approval ??
    (typeof config?.config.approval_policy === "string" ? config.config.approval_policy : "");
  const sandboxValue =
    sandbox ?? (typeof config?.config.sandbox_mode === "string" ? config.config.sandbox_mode : "");
  const approvalOptions = (
    requirements?.requirements?.allowedApprovalPolicies ?? ["untrusted", "on-request", "never"]
  ).filter((value): value is string => typeof value === "string");
  const sandboxOptions = requirements?.requirements?.allowedSandboxModes ?? [
    "read-only",
    "workspace-write",
    "danger-full-access",
  ];
  const options = (values: string[]) => values.map((value) => ({ value, label: value }));
  async function write(request: CodexRequest) {
    setNotice(null);
    const result = codexConfigWriteResponseSchema.parse(await controller.request(request));
    setNotice(result.status === "okOverridden" ? text.overridden : text.saved);
  }
  function saveDefaults() {
    if (!target || (!model && !configured)) return;
    void controller.run(async () => {
      // 未发现的显式配置不能伪造 model 能力；保持其 model/effort，仅提交用户修改的权限。
      const edits = model ? codexModelEdits(model, effort) : [];
      if (approval && approvalOptions.includes(approval))
        edits.push({ keyPath: "approval_policy", value: approval, mergeStrategy: "replace" });
      if (sandbox && sandboxOptions.includes(sandbox))
        edits.push({ keyPath: "sandbox_mode", value: sandbox, mergeStrategy: "replace" });
      await write({ method: "config/batchWrite", params: { ...target, edits } });
      setDraftModel(null);
      setDraftEffort(null);
      setApproval(null);
      setSandbox(null);
    });
  }
  return (
    <CodexSection title={advanced ? text.config : text.models}>
      {[
        controller.snapshot.config?.error,
        controller.snapshot.requirements?.error,
        controller.snapshot.models?.error,
      ]
        .filter(Boolean)
        .map((error, index) => (
          <CodexNotice key={index} error>
            {error}
          </CodexNotice>
        ))}
      {!target ? <CodexNotice>{text.noVersion}</CodexNotice> : null}
      {advanced ? (
        <>
          <CodexNotice>{text.configHelp}</CodexNotice>
          <form
            className="space-y-3"
            onSubmit={(event) => {
              event.preventDefault();
              if (!target) return;
              void controller.run(async () => {
                const [edit] = codexConfigEditsSchema.parse([
                  {
                    keyPath: keyPath.trim(),
                    value: JSON.parse(jsonValue),
                    mergeStrategy: "replace",
                  },
                ]);
                await write({ method: "config/value/write", params: { ...target, ...edit } });
              });
            }}
          >
            <label className="block space-y-1 text-ui-sm">
              {text.keyPath}
              <Input
                value={keyPath}
                onChange={(event) => setKeyPath(event.target.value)}
                placeholder="model_reasoning_effort"
                disabled={disabled}
              />
            </label>
            <label className="block space-y-1 text-ui-sm">
              {text.jsonValue}
              <Textarea
                value={jsonValue}
                onChange={(event) => setJsonValue(event.target.value)}
                placeholder={'"high"'}
                disabled={disabled}
              />
            </label>
            <Button type="submit" disabled={disabled || !keyPath.trim() || !jsonValue.trim()}>
              {text.saveValue}
            </Button>
          </form>
          <form
            className="space-y-3 border-t border-border pt-3"
            onSubmit={(event) => {
              event.preventDefault();
              if (!target) return;
              void controller.run(async () => {
                await write({
                  method: "config/batchWrite",
                  params: { ...target, edits: codexConfigEditsSchema.parse(JSON.parse(batch)) },
                });
              });
            }}
          >
            <label className="block space-y-1 text-ui-sm">
              {text.edits}
              <Textarea
                value={batch}
                rows={4}
                onChange={(event) => setBatch(event.target.value)}
                disabled={disabled}
                placeholder={
                  '[{"keyPath":"model_reasoning_effort","value":"high","mergeStrategy":"replace"}]'
                }
              />
            </label>
            <Button type="submit" variant="outline" disabled={disabled || !batch.trim()}>
              {text.saveBatch}
            </Button>
          </form>
        </>
      ) : (
        <>
          <div className="grid gap-3 sm:grid-cols-2">
            <ConfigSelect
              label={text.model}
              value={modelName}
              options={[
                ...(configured
                  ? [{ value: modelName, label: `${modelName} · ${text.configured}` }]
                  : []),
                ...models
                  .filter((entry) => !entry.hidden)
                  .map((entry) => ({ value: entry.model, label: entry.displayName })),
              ]}
              disabled={disabled}
              onChange={(value) => {
                setDraftModel(value);
                setDraftEffort(
                  models.find((entry) => entry.model === value)?.defaultReasoningEffort ?? null,
                );
              }}
            />
            <ConfigSelect
              label={text.effort}
              value={effort}
              options={
                configured && effort
                  ? options([effort])
                  : options(
                      model?.supportedReasoningEfforts.map((entry) => entry.reasoningEffort) ?? [],
                    )
              }
              disabled={disabled || !model}
              onChange={setDraftEffort}
            />
            <ConfigSelect
              label={text.approval}
              value={approvalValue}
              options={options(approvalOptions)}
              disabled={disabled}
              onChange={setApproval}
            />
            <ConfigSelect
              label={text.sandbox}
              value={sandboxValue}
              options={options(sandboxOptions)}
              disabled={disabled}
              onChange={setSandbox}
            />
          </div>
          {model ? <CodexNotice>{model.description}</CodexNotice> : null}
          {configured ? <CodexNotice>{text.configuredHelp}</CodexNotice> : null}
          <CodexNotice>{text.defaults}</CodexNotice>
          <Button
            disabled={
              disabled ||
              (configured
                ? !approval && !sandbox
                : !model?.supportedReasoningEfforts.some(
                    (entry) => entry.reasoningEffort === effort,
                  ))
            }
            onClick={saveDefaults}
          >
            {text.save}
          </Button>
        </>
      )}
      {notice ? <CodexNotice>{notice}</CodexNotice> : null}
      {config ? (
        <details>
          <summary className="cursor-pointer text-ui-sm">{text.effective}</summary>
          <pre className="mt-2 overflow-auto whitespace-pre-wrap break-all font-mono text-ui-sm">
            {JSON.stringify(codexVisibleConfig(config.config), null, 2)}
          </pre>
        </details>
      ) : null}
      {requirements ? (
        <details>
          <summary className="cursor-pointer text-ui-sm">{text.requirements}</summary>
          <pre className="mt-2 overflow-auto whitespace-pre-wrap break-all font-mono text-ui-sm">
            {JSON.stringify(
              requirements.requirements
                ? {
                    allowedApprovalPolicies: requirements.requirements.allowedApprovalPolicies,
                    allowedSandboxModes: requirements.requirements.allowedSandboxModes,
                  }
                : null,
              null,
              2,
            )}
          </pre>
        </details>
      ) : null}
    </CodexSection>
  );
}
