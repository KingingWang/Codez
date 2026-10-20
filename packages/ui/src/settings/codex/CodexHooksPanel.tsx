import { useMemo, useState } from "react";
import { Plus, ShieldCheck, Webhook } from "lucide-react";
import type { CodexHookMetadata, CodezHookCommandEntry } from "@codez/shared";
import { Badge } from "@/components/ui/badge.js";
import { Button } from "@/components/ui/button.js";
import { Switch } from "@/components/ui/switch.js";
import { SettingsGroupCard, SettingsRow } from "@/settings/SettingsPageParts.js";
import {
  SettingsResourceGroupHeader,
  SettingsResourceList,
} from "@/settings/SettingsResourceGroup.js";
import type { CodexSettingsController } from "@/hooks/useCodexSettings.js";
import {
  codexProjectRootFromDotFolder,
  readCodexMcpProjectLayers,
  trustCodexProject,
} from "./codexMcpSettings.js";
import { CodexHookForm } from "./CodexHookForm.js";
import {
  buildCodexHooksView,
  codexHookFormToCommandEntry,
  codexHookMetadataToCommandEntry,
  codexHookMetadataToForm,
  codexWireEventToConfigEvent,
  createEmptyCodexHookForm,
  isCodexHooksFeatureEnabled,
  isEditableHooksJsonEntry,
  setCodexHookEnabled,
  setCodexHooksFeatureEnabled,
  trustCodexHooks,
  type CodexHookFormState,
} from "./codexHooksSettings.js";
import { CodexConfirmButton, CodexNotice } from "./CodexSettingsParts.js";
import { formatCodexTemplate, useCodexMessages } from "./messages.js";

export function CodexHooksPanel({
  controller,
  workspacePath,
  workspaceIdentity,
  hideSectionTitle = false,
}: {
  controller: CodexSettingsController;
  workspacePath?: string | null;
  workspaceIdentity?: string;
  hideSectionTitle?: boolean;
}) {
  const text = useCodexMessages();
  const hooksState = controller.snapshot.hooks;
  const configState = controller.snapshot.config;
  const [form, setForm] = useState<CodexHookFormState | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const disabled = controller.busy || controller.loading || !controller.enabled;

  const view = useMemo(() => buildCodexHooksView(hooksState?.data), [hooksState?.data]);
  const featureEnabled = useMemo(
    () => isCodexHooksFeatureEnabled(configState?.data),
    [configState?.data],
  );
  const untrustedProjectLayer = useMemo(
    () => readCodexMcpProjectLayers(configState?.data).find((layer) => layer.disabledReason),
    [configState?.data],
  );

  const submitForm = () => {
    if (!form || !workspacePath) return;
    let entry: CodezHookCommandEntry;
    try {
      entry = codexHookFormToCommandEntry(form);
    } catch (error) {
      setFormError(error instanceof Error ? error.message : String(error));
      return;
    }
    setFormError(null);
    const target = { workspacePath, ...(workspaceIdentity ? { workspaceIdentity } : {}) };
    void controller
      .run(async () => {
        await controller.services.codezAgentService.writeCodexHooksConfig({
          ...target,
          scope: form.scope,
          action: form.originalEntry ? "update" : "add",
          ...(form.dotCodexFolder ? { dotCodexFolder: form.dotCodexFolder } : {}),
          ...(form.originalEntry ? { target: form.originalEntry } : {}),
          hook: entry,
        });
      })
      .then((ok) => {
        if (ok) setForm(null);
      });
  };

  const deleteHook = (hook: CodexHookMetadata) => {
    if (!workspacePath) return;
    const scope: "user" | "project" = hook.source === "project" ? "project" : "user";
    const dotCodexFolder =
      scope === "project" ? hook.sourcePath.replace(/[\\/]+hooks\.json$/i, "") : undefined;
    const targetEntry = codexHookMetadataToCommandEntry(hook);
    const target = { workspacePath, ...(workspaceIdentity ? { workspaceIdentity } : {}) };
    void controller.run(async () => {
      await controller.services.codezAgentService.writeCodexHooksConfig({
        ...target,
        scope,
        action: "delete",
        ...(dotCodexFolder && dotCodexFolder !== hook.sourcePath ? { dotCodexFolder } : {}),
        target: targetEntry,
      });
    });
  };

  const renderTrustBadge = (hook: CodexHookMetadata) => {
    if (hook.trustStatus === "untrusted") {
      return <Badge variant="outline">{text.hooksStatusUntrusted}</Badge>;
    }
    if (hook.trustStatus === "modified") {
      return <Badge variant="outline">{text.hooksStatusModified}</Badge>;
    }
    if (hook.trustStatus === "managed" || hook.isManaged) {
      return <Badge variant="secondary">{text.hooksStatusManaged}</Badge>;
    }
    return <Badge variant="secondary">{text.hooksStatusTrusted}</Badge>;
  };

  const renderSourceBadge = (hook: CodexHookMetadata) => {
    const label =
      hook.pluginId
        ? `${text.hooksSourcePlugin}: ${hook.pluginId}`
        : hook.source === "project"
          ? text.hooksSourceProject
          : hook.source === "user"
            ? text.hooksSourceUser
            : text.hooksSourceManaged;
    return <Badge variant="secondary">{label}</Badge>;
  };

  const renderHookRow = (hook: CodexHookMetadata) => {
    const eventLabel = codexWireEventToConfigEvent(hook.eventName);
    const primaryCommand =
      hook.handlerType === "command"
        ? hook.command ?? hook.key
        : hook.handlerType === "mcpTool"
          ? `mcp:${hook.server ?? ""}/${hook.tool ?? ""}`
          : hook.key;
    const editable = isEditableHooksJsonEntry(hook);
    const needsTrust = hook.trustStatus === "untrusted" || hook.trustStatus === "modified";

    return (
      <div className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-3 px-4 py-3 transition-colors hover:bg-hover">
        <div
          className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-background text-foreground-subtle"
          aria-hidden="true"
        >
          <Webhook className="size-4" />
        </div>
        <div className="min-w-0 flex-1 space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="inline-flex min-h-5 items-center rounded-md bg-background px-1.5 py-0.5 font-mono text-ui-xs font-medium text-foreground ring-1 ring-border">
              {eventLabel}
            </span>
            {hook.matcher ? (
              <span className="inline-flex min-h-5 items-center rounded-md bg-background px-1.5 py-0.5 font-mono text-ui-xs text-foreground-subtle ring-1 ring-border">
                {hook.matcher}
              </span>
            ) : null}
            {renderSourceBadge(hook)}
            {renderTrustBadge(hook)}
            {!hook.enabled ? <Badge variant="outline">{text.disabled}</Badge> : null}
          </div>
          <p className="break-all font-mono text-ui-sm text-foreground">{primaryCommand}</p>
          {hook.statusMessage ? (
            <p className="text-ui-xs text-foreground-subtle">{hook.statusMessage}</p>
          ) : null}
          <p className="break-all font-mono text-ui-xs text-foreground-subtlest">
            {hook.sourcePath}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {needsTrust ? (
            <Button
              variant="outline"
              size="sm"
              aria-label={`${text.hooksTrust}: ${eventLabel} (${primaryCommand})`}
              disabled={disabled}
              onClick={() =>
                void controller.run(() => trustCodexHooks(controller, [hook]))
              }
            >
              <ShieldCheck data-icon="inline-start" aria-hidden="true" />
              {text.hooksTrust}
            </Button>
          ) : null}
          {editable ? (
            <>
              <Button
                variant="outline"
                size="sm"
                aria-label={`${text.hooksEdit}: ${eventLabel} (${primaryCommand})`}
                disabled={disabled}
                onClick={() => {
                  setFormError(null);
                  setForm(codexHookMetadataToForm(hook));
                }}
              >
                {text.hooksEdit}
              </Button>
              <CodexConfirmButton
                label={text.hooksDelete}
                targetLabel={`${text.hooksDelete}: ${eventLabel} (${primaryCommand})`}
                disabled={disabled}
                onConfirm={() => deleteHook(hook)}
              />
            </>
          ) : null}
          {!hook.isManaged ? (
            <Switch
              aria-label={`${eventLabel}: ${primaryCommand}`}
              checked={hook.enabled}
              disabled={disabled}
              onCheckedChange={(enabled) =>
                void controller.run(() => setCodexHookEnabled(controller, hook.key, enabled))
              }
            />
          ) : null}
        </div>
      </div>
    );
  };

  const renderScopeGroup = (
    scope: "project" | "user",
    title: string,
    items: CodexHookMetadata[],
  ) => (
    <section className="space-y-3">
      <SettingsResourceGroupHeader
        count={items.length}
        title={title}
        actions={
          <Button
            variant="outline"
            size="sm"
            aria-label={`${text.hooksAdd}: ${title}`}
            disabled={disabled || !workspacePath}
            onClick={() => {
              setFormError(null);
              setForm(createEmptyCodexHookForm(scope));
            }}
          >
            <Plus data-icon="inline-start" aria-hidden="true" />
            {text.hooksAdd}
          </Button>
        }
      />
      {items.length > 0 ? (
        <SettingsResourceList items={items} getKey={(item) => item.key} renderItem={renderHookRow} />
      ) : (
        <CodexNotice>{text.hooksEmptyScope}</CodexNotice>
      )}
    </section>
  );

  return (
    <div className="space-y-6">
      {!hideSectionTitle ? (
        <div className="space-y-1">
          <h3 className="text-ui-md font-medium text-foreground">{text.hooks}</h3>
          <p className="text-ui-sm text-foreground-subtle">{text.hooksHelp}</p>
        </div>
      ) : (
        <p className="text-ui-sm text-foreground-subtle">{text.hooksHelp}</p>
      )}

      {hooksState?.error ? <CodexNotice error>{hooksState.error}</CodexNotice> : null}
      {configState?.error ? <CodexNotice error>{configState.error}</CodexNotice> : null}

      <SettingsGroupCard>
        <SettingsRow
          label={text.hooksFeatureToggle}
          description={text.hooksFeatureToggleHelp}
          control={
            <Switch
              aria-label={text.hooksFeatureToggle}
              checked={featureEnabled}
              disabled={disabled}
              onCheckedChange={(enabled) =>
                void controller.run(() => setCodexHooksFeatureEnabled(controller, enabled))
              }
            />
          }
        />
      </SettingsGroupCard>

      {untrustedProjectLayer ? (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border bg-background px-4 py-3">
          <div className="min-w-0 flex-1 space-y-1">
            <p className="text-ui-sm text-foreground">{text.mcpProjectUntrustedHelp}</p>
            <p className="break-all font-mono text-ui-xs text-foreground-subtlest">
              {untrustedProjectLayer.dotCodexFolder}
            </p>
          </div>
          <Button
            variant="outline"
            size="sm"
            disabled={disabled}
            onClick={() =>
              void controller.run(() =>
                trustCodexProject(
                  controller,
                  codexProjectRootFromDotFolder(untrustedProjectLayer.dotCodexFolder),
                ),
              )
            }
          >
            {text.mcpTrustProject}
          </Button>
        </div>
      ) : null}

      {view.pendingTrustHooks.length > 0 ? (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border bg-background px-4 py-3">
          <p className="min-w-0 flex-1 text-ui-sm text-foreground">
            {formatCodexTemplate(text.hooksTrustBanner, {
              count: String(view.pendingTrustHooks.length),
            })}
          </p>
          <Button
            variant="outline"
            size="sm"
            disabled={disabled}
            onClick={() =>
              void controller.run(() => trustCodexHooks(controller, view.pendingTrustHooks))
            }
          >
            <ShieldCheck data-icon="inline-start" aria-hidden="true" />
            {formatCodexTemplate(text.hooksTrustAll, {
              count: String(view.pendingTrustHooks.length),
            })}
          </Button>
        </div>
      ) : null}

      {view.errors.length > 0 ? (
        <div className="space-y-2">
          <p className="text-ui-sm font-medium text-destructive">{text.hooksErrorsTitle}</p>
          {view.errors.map((err, index) => (
            <CodexNotice key={`${err.sourcePath ?? "err"}:${index}`} error>
              {err.sourcePath ? `${err.sourcePath}: ${err.message}` : err.message}
            </CodexNotice>
          ))}
        </div>
      ) : null}

      {view.warnings.length > 0 ? (
        <div className="space-y-2">
          <p className="text-ui-sm font-medium text-foreground">{text.hooksWarningsTitle}</p>
          {view.warnings.map((warning, index) => (
            <CodexNotice key={`warn:${index}`}>{warning}</CodexNotice>
          ))}
        </div>
      ) : null}

      {form ? (
        <CodexHookForm
          form={form}
          formError={formError}
          disabled={disabled}
          onChange={setForm}
          onClearError={() => setFormError(null)}
          onCancel={() => {
            setFormError(null);
            setForm(null);
          }}
          onSubmit={submitForm}
        />
      ) : null}

      {renderScopeGroup("project", text.hooksScopeProject, view.projectHooks)}
      {renderScopeGroup("user", text.hooksScopeUser, view.userHooks)}

      {view.otherHooks.length > 0 ? (
        <section className="space-y-3">
          <SettingsResourceGroupHeader
            count={view.otherHooks.length}
            title={text.hooksScopeOther}
          />
          <SettingsResourceList
            items={view.otherHooks}
            getKey={(item) => item.key}
            renderItem={renderHookRow}
          />
        </section>
      ) : null}
    </div>
  );
}
