import { useState } from "react";
import type {
  CodezAgentRoleScope,
  CodezAgentRoleSummary,
  CodezAgentRoleWriteInput,
} from "@codez/shared";
import { Button } from "@/components/ui/button.js";
import { Input } from "@/components/ui/input.js";
import { Textarea } from "@/components/ui/textarea.js";
import { useCodexAgents } from "@/hooks/useCodexAgents.js";
import { CodexConfirmButton, CodexNotice, CodexSection } from "./CodexSettingsParts.js";
import { useCodexMessages } from "./messages.js";

// 与 bridge 新建派生规则一致（specs/codex-desktop-subagents.md）；最终校验仍以 bridge 为准。
const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9 _-]{0,63}$/;
const NICKNAME_CHARSET = /^[A-Za-z0-9 _-]+$/;

interface RoleFormState {
  scope: CodezAgentRoleScope;
  /** 编辑时锁定原名称（不支持改名）；新建为 undefined。 */
  originalName?: string;
  name: string;
  description: string;
  model: string;
  effort: string;
  instructions: string;
  nicknames: string;
}

function formFromRole(scope: CodezAgentRoleScope, role?: CodezAgentRoleSummary): RoleFormState {
  return {
    scope,
    ...(role ? { originalName: role.name } : {}),
    name: role?.name ?? "",
    description: role?.description ?? "",
    model: role?.model ?? "",
    effort: role?.modelReasoningEffort ?? "",
    instructions: role?.developerInstructions ?? "",
    nicknames: role?.nicknameCandidates?.join(", ") ?? "",
  };
}

/** 表单 → 写入输入。校验失败抛错，由调用方展示；可选字段空白 = 省略（= 清除该 key）。 */
export function roleFormToWriteInput(form: RoleFormState): CodezAgentRoleWriteInput {
  const name = form.name.trim();
  if (!name) throw new Error("name required");
  if (!form.originalName && !SAFE_NAME.test(name)) throw new Error("name charset");
  const instructions = form.instructions.trim();
  if (!instructions) throw new Error("developer instructions required");
  const nicknames = form.nicknames
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  if (nicknames.length > 0) {
    if (new Set(nicknames).size !== nicknames.length) throw new Error("nickname duplicates");
    for (const nickname of nicknames)
      if (!NICKNAME_CHARSET.test(nickname)) throw new Error("nickname charset");
  }
  return {
    name,
    ...(form.description.trim() ? { description: form.description.trim() } : {}),
    ...(form.model.trim() ? { model: form.model.trim() } : {}),
    ...(form.effort.trim() ? { modelReasoningEffort: form.effort.trim() } : {}),
    developerInstructions: instructions,
    ...(nicknames.length > 0 ? { nicknameCandidates: nicknames } : {}),
  };
}

export function CodexAgentsPanel(props: {
  workspacePath?: string | null;
  workspaceIdentity?: string;
  remoteSessionId?: string;
}) {
  const text = useCodexMessages();
  const controller = useCodexAgents(props);
  const [form, setForm] = useState<RoleFormState | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const disabled = controller.busy || controller.loading || !controller.enabled;

  const submit = () => {
    if (!form) return;
    let role: CodezAgentRoleWriteInput;
    try {
      role = roleFormToWriteInput(form);
    } catch (error) {
      setFormError(error instanceof Error ? error.message : String(error));
      return;
    }
    setFormError(null);
    void controller
      .saveRole({
        scope: form.scope,
        ...(form.originalName ? { originalName: form.originalName } : {}),
        role,
      })
      .then((ok) => {
        if (ok) setForm(null);
      });
  };

  const renderGroup = (scope: CodezAgentRoleScope, title: string, pathHint: string) => {
    const roles = controller.roles.filter((role) => role.scope === scope);
    return (
      <div className="space-y-2 border-t border-border pt-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="min-w-0">
            <p className="text-ui-base font-medium">{title}</p>
            <p className="font-mono text-ui-sm text-foreground-subtlest">{pathHint}</p>
          </div>
          <Button
            variant="outline"
            size="sm"
            disabled={disabled}
            onClick={() => {
              setFormError(null);
              setForm(formFromRole(scope));
            }}
          >
            {text.agentsCreate}
          </Button>
        </div>
        {roles.length === 0 ? <CodexNotice>{text.agentsEmpty}</CodexNotice> : null}
        {roles.map((role) => (
          <div
            key={`${scope}:${role.fileName}`}
            className="flex flex-wrap items-center justify-between gap-3 border-t border-border pt-3"
          >
            <div className="min-w-0 flex-1">
              <p className="text-ui-base">{role.name}</p>
              {role.description ? (
                <p className="break-words text-ui-sm text-foreground-subtle">{role.description}</p>
              ) : null}
              <p className="break-all font-mono text-ui-sm text-foreground-subtlest">
                {role.fileName}
                {role.model ? ` · ${role.model}` : ""}
                {role.modelReasoningEffort ? ` · ${role.modelReasoningEffort}` : ""}
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Button
                variant="outline"
                size="sm"
                disabled={disabled}
                onClick={() => {
                  setFormError(null);
                  setForm(formFromRole(scope, role));
                }}
              >
                {text.agentsEdit}
              </Button>
              <CodexConfirmButton
                label={text.agentsDelete}
                disabled={disabled}
                onConfirm={() => void controller.deleteRole({ scope, name: role.name })}
              />
            </div>
          </div>
        ))}
      </div>
    );
  };

  return (
    <CodexSection title={text.agents}>
      <CodexNotice>{text.agentsHelp}</CodexNotice>
      {controller.error ? <CodexNotice error>{controller.error}</CodexNotice> : null}
      {controller.diagnostics.map((entry, index) => (
        <CodexNotice
          key={`${entry.code}:${entry.fileName ?? index}`}
          error={entry.severity === "error"}
        >
          {entry.fileName ? `${entry.fileName}: ` : ""}
          {entry.message}
        </CodexNotice>
      ))}
      {form ? (
        <div className="space-y-3 rounded-lg border border-border bg-surface p-3">
          <div className="space-y-1">
            <label className="text-ui-sm text-foreground-subtle" htmlFor="codex-agent-name">
              {text.agentsName}
            </label>
            <Input
              id="codex-agent-name"
              value={form.name}
              disabled={disabled || Boolean(form.originalName)}
              onChange={(event) => setForm({ ...form, name: event.target.value })}
            />
            <p className="text-ui-sm text-foreground-subtlest">
              {form.originalName ? text.agentsNameLocked : text.agentsNameHelp}
            </p>
          </div>
          <div className="space-y-1">
            <label className="text-ui-sm text-foreground-subtle" htmlFor="codex-agent-description">
              {text.agentsDescription}
            </label>
            <Input
              id="codex-agent-description"
              value={form.description}
              disabled={disabled}
              onChange={(event) => setForm({ ...form, description: event.target.value })}
            />
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1">
              <label className="text-ui-sm text-foreground-subtle" htmlFor="codex-agent-model">
                {text.agentsModel}
              </label>
              <Input
                id="codex-agent-model"
                value={form.model}
                disabled={disabled}
                onChange={(event) => setForm({ ...form, model: event.target.value })}
              />
            </div>
            <div className="space-y-1">
              <label className="text-ui-sm text-foreground-subtle" htmlFor="codex-agent-effort">
                {text.agentsEffort}
              </label>
              <Input
                id="codex-agent-effort"
                value={form.effort}
                disabled={disabled}
                onChange={(event) => setForm({ ...form, effort: event.target.value })}
              />
            </div>
          </div>
          <div className="space-y-1">
            <label className="text-ui-sm text-foreground-subtle" htmlFor="codex-agent-instructions">
              {text.agentsInstructions}
            </label>
            <Textarea
              id="codex-agent-instructions"
              value={form.instructions}
              disabled={disabled}
              onChange={(event) => setForm({ ...form, instructions: event.target.value })}
            />
          </div>
          <div className="space-y-1">
            <label className="text-ui-sm text-foreground-subtle" htmlFor="codex-agent-nicknames">
              {text.agentsNicknames}
            </label>
            <Input
              id="codex-agent-nicknames"
              value={form.nicknames}
              disabled={disabled}
              onChange={(event) => setForm({ ...form, nicknames: event.target.value })}
            />
          </div>
          {formError ? <CodexNotice error>{formError}</CodexNotice> : null}
          <div className="flex flex-wrap gap-2">
            <Button size="sm" disabled={disabled} onClick={submit}>
              {text.save}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              disabled={controller.busy}
              onClick={() => setForm(null)}
            >
              {text.cancelAction}
            </Button>
          </div>
        </div>
      ) : null}
      {renderGroup("user", text.agentsUserScope, "~/.codex/agents")}
      {renderGroup("project", text.agentsProjectScope, ".codex/agents")}
    </CodexSection>
  );
}
