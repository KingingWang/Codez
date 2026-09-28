import { useCallback, useEffect, useMemo, useState } from "react";
import {
  codexConfigWriteResponseSchema,
  type CodezCatalogModelEntry,
  type CodexRequest,
} from "@codez/shared";
import { Button } from "@/components/ui/button.js";
import { Switch } from "@/components/ui/switch.js";
import type { CodexSettingsController } from "@/hooks/useCodexSettings.js";
import {
  codexCatalogModelTemplate,
  codexCatalogModelView,
  codexConfiguredDefaultModel,
  codexModelEntryFromForm,
  codexModelFormFrom,
  codexProviderCreateEdits,
  codexProviderDeleteEdits,
  codexProviderFormError,
  codexProviderFormFrom,
  codexProviderSetDefaultEdits,
  codexProvidersView,
  codexProviderUpdateEdits,
  type CodexCatalogModelView,
  type CodexConfigEdit,
  type CodexModelForm,
  type CodexProviderForm,
  type CodexProviderView,
} from "./codexProviderSettings.js";
import { codexUserConfigTarget } from "./codexSettingsData.js";
import { CodexCatalogModelFormView, CodexProviderFormView } from "./CodexProviderForms.js";
import { CodexConfirmButton, CodexNotice, CodexSection } from "./CodexSettingsParts.js";
import { useCodexMessages } from "./messages.js";

interface CatalogState {
  path: string | null;
  models: CodezCatalogModelEntry[];
}

export function CodexProvidersPanel({
  controller,
  workspacePath,
  workspaceIdentity,
}: {
  controller: CodexSettingsController;
  workspacePath?: string | null;
  workspaceIdentity?: string;
}) {
  const text = useCodexMessages();
  const [catalog, setCatalog] = useState<CatalogState | null>(null);
  const [catalogError, setCatalogError] = useState<string | null>(null);
  const [catalogStale, setCatalogStale] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [providerForm, setProviderForm] = useState<{
    form: CodexProviderForm;
    creating: boolean;
  } | null>(null);
  const [modelForm, setModelForm] = useState<CodexModelForm | null>(null);

  const config = controller.snapshot.config?.data;
  const target = codexUserConfigTarget(config);
  const disabled = controller.busy || controller.loading || !controller.enabled || !target;
  const workspaceRef = useMemo(
    () =>
      workspacePath
        ? {
            workspacePath,
            ...(workspaceIdentity ? { workspaceIdentity } : {}),
          }
        : null,
    [workspacePath, workspaceIdentity],
  );

  const loadCatalog = useCallback(async () => {
    if (!workspaceRef) return;
    try {
      const result =
        await controller.services.codezAgentService.readCodexCatalogModels(workspaceRef);
      setCatalog({ path: result.path, models: result.models });
      setCatalogError(null);
    } catch (error) {
      setCatalog({ path: null, models: [] });
      setCatalogError(error instanceof Error ? error.message : String(error));
    }
  }, [controller.services, workspaceRef]);

  useEffect(() => {
    void loadCatalog();
  }, [loadCatalog]);

  const providers = useMemo(
    () => codexProvidersView(config, catalog?.models ?? []),
    [config, catalog],
  );
  const defaultModel = codexConfiguredDefaultModel(config);
  const modelGroups = useMemo(() => {
    const groups = new Map<string, { label: string; entries: CodexCatalogModelView[] }>();
    for (const entry of catalog?.models ?? []) {
      const view = codexCatalogModelView(entry);
      const key = view.provider ?? "";
      const label = providers.find((provider) => provider.id === key)?.name ?? (key || entry.slug);
      const bucket = groups.get(key);
      if (bucket) bucket.entries.push(view);
      else groups.set(key, { label, entries: [view] });
    }
    const ordered = [
      ...providers.map((provider) => provider.id),
      ...[...groups.keys()].filter((key) => !providers.some((p) => p.id === key)),
    ];
    return ordered.filter((key) => groups.has(key)).map((key) => ({ key, ...groups.get(key)! }));
  }, [catalog, providers]);

  async function writeEdits(edits: CodexConfigEdit[]) {
    setNotice(null);
    const request: CodexRequest = {
      method: "config/batchWrite",
      params: { ...target, edits, reloadUserConfig: true },
    };
    const result = codexConfigWriteResponseSchema.parse(await controller.request(request));
    setNotice(result.status === "okOverridden" ? text.overridden : text.saved);
  }

  async function writeCatalog(operation: () => Promise<unknown>) {
    setNotice(null);
    await operation();
    await loadCatalog();
    setCatalogStale(true);
    setNotice(text.modelCatalogStale);
  }

  const submitProvider = () => {
    if (!providerForm) return;
    const { form, creating } = providerForm;
    const errorKey = codexProviderFormError(
      form,
      creating,
      providers.map((provider) => provider.id),
    );
    if (errorKey) {
      setFormError(text[errorKey]);
      return;
    }
    setFormError(null);
    const edits = creating ? codexProviderCreateEdits(form) : codexProviderUpdateEdits(form);
    void controller
      .run(() => writeEdits(edits))
      .then((ok) => {
        if (ok) setProviderForm(null);
      });
  };

  const deleteProvider = (view: CodexProviderView) => {
    if (view.isDefault) {
      setFormError(text.providerDeleteDefaultBlocked);
      return;
    }
    if (view.modelCount > 0) {
      setFormError(text.providerDeleteModelsBlocked);
      return;
    }
    setFormError(null);
    void controller.run(() => writeEdits(codexProviderDeleteEdits(view.id)));
  };

  const submitModel = () => {
    if (!modelForm || !workspaceRef) return;
    const entry = codexModelEntryFromForm(modelForm);
    if (!entry) {
      setFormError(text.modelInvalid);
      return;
    }
    setFormError(null);
    const agent = controller.services.codezAgentService;
    void controller
      .run(() =>
        writeCatalog(() => agent.writeCodexCatalogModel({ ...workspaceRef, model: entry })),
      )
      .then((ok) => {
        if (ok) setModelForm(null);
      });
  };

  const deleteModel = (slug: string) => {
    if (!workspaceRef) return;
    const agent = controller.services.codezAgentService;
    void controller.run(() =>
      writeCatalog(() => agent.deleteCodexCatalogModel({ ...workspaceRef, slug })),
    );
  };

  const toggleModelHidden = (view: CodexCatalogModelView) => {
    if (!workspaceRef) return;
    const source = catalog?.models.find((entry) => entry.slug === view.slug);
    if (!source) return;
    const agent = controller.services.codezAgentService;
    void controller.run(() =>
      writeCatalog(() =>
        agent.writeCodexCatalogModel({
          ...workspaceRef,
          model: { ...source, visibility: view.hidden ? "list" : "hidden" },
        }),
      ),
    );
  };

  const restartRuntime = () => {
    if (!workspaceRef) return;
    const agent = controller.services.codezAgentService;
    void controller.run(async () => {
      await agent.disposeWorkspace(workspaceRef);
      // dispose 后的首次请求立即拉起新 runtime（代际 >1 → onAgentRuntimeRestarted →
      // composer 模型下拉重拉 model/list），新 app-server 重读目录文件。
      await loadCatalog();
      setCatalogStale(false);
      setNotice(text.saved);
    });
  };

  return (
    <div className="space-y-4">
      <CodexSection title={text.providers}>
        <CodexNotice>{text.providersHelp}</CodexNotice>
        {controller.snapshot.config?.error ? (
          <CodexNotice error>{controller.snapshot.config.error}</CodexNotice>
        ) : null}
        {notice ? <CodexNotice>{notice}</CodexNotice> : null}
        {formError ? <CodexNotice error>{formError}</CodexNotice> : null}
        {providers.length === 0 ? <CodexNotice>{text.providerEmpty}</CodexNotice> : null}
        {providers.map((view) => (
          <div
            key={view.id}
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
                {view.baseUrl ? ` · ${view.baseUrl}` : ""} · {view.modelCount}{" "}
                {text.providerModelCount}
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              {!view.isDefault ? (
                <Button
                  variant="outline"
                  size="sm"
                  disabled={Boolean(disabled)}
                  onClick={() =>
                    void controller.run(() => writeEdits(codexProviderSetDefaultEdits(view.id)))
                  }
                >
                  {text.providerSetDefault}
                </Button>
              ) : null}
              <Button
                variant="outline"
                size="sm"
                disabled={Boolean(disabled)}
                onClick={() => {
                  setFormError(null);
                  setModelForm(null);
                  setProviderForm({ form: codexProviderFormFrom(view), creating: false });
                }}
              >
                {text.providerEdit}
              </Button>
              <CodexConfirmButton
                label={text.providerDelete}
                disabled={Boolean(disabled) || view.isDefault}
                onConfirm={() => deleteProvider(view)}
              />
            </div>
          </div>
        ))}
        <div className="border-t border-border pt-3">
          <Button
            variant="outline"
            size="sm"
            disabled={Boolean(disabled)}
            onClick={() => {
              setFormError(null);
              setModelForm(null);
              setProviderForm({ form: codexProviderFormFrom(), creating: true });
            }}
          >
            {text.providerAdd}
          </Button>
        </div>
        {providerForm ? (
          <CodexProviderFormView
            form={providerForm.form}
            creating={providerForm.creating}
            disabled={Boolean(disabled)}
            error={null}
            onChange={(form) => setProviderForm({ ...providerForm, form })}
            onSubmit={submitProvider}
            onCancel={() => setProviderForm(null)}
          />
        ) : null}
      </CodexSection>
      <CodexSection title={text.providerModels}>
        <CodexNotice>{text.providerModelsHelp}</CodexNotice>
        {catalogError ? <CodexNotice error>{catalogError}</CodexNotice> : null}
        {catalog && !catalog.path ? <CodexNotice>{text.modelNoCatalog}</CodexNotice> : null}
        {modelGroups.length === 0 && catalog?.path ? (
          <CodexNotice>{text.providerModelsEmpty}</CodexNotice>
        ) : null}
        {modelGroups.map((group) => (
          <div key={group.key || "(none)"} className="space-y-2 border-t border-border pt-3">
            <p className="text-ui-sm font-medium text-foreground-subtle">{group.label}</p>
            {group.entries.map((view) => (
              <div key={view.slug} className="flex flex-wrap items-center justify-between gap-3">
                <div className="min-w-0 flex-1">
                  <p className="text-ui-base">{view.displayName}</p>
                  <p className="break-all font-mono text-ui-sm text-foreground-subtlest">
                    {view.slug}
                    {view.slug === defaultModel ? ` · config.model` : ""}
                  </p>
                  {view.slug === defaultModel ? (
                    <p className="text-ui-sm text-foreground-subtlest">
                      {text.modelDeleteDefaultWarning}
                    </p>
                  ) : null}
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <Switch
                    aria-label={text.modelHidden}
                    checked={!view.hidden}
                    disabled={Boolean(disabled) || !catalog?.path}
                    onCheckedChange={() => toggleModelHidden(view)}
                  />
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={Boolean(disabled)}
                    onClick={() => {
                      setFormError(null);
                      setProviderForm(null);
                      const source = catalog?.models.find((entry) => entry.slug === view.slug);
                      if (source) setModelForm(codexModelFormFrom(source, {}));
                    }}
                  >
                    {text.providerEdit}
                  </Button>
                  <CodexConfirmButton
                    label={text.providerDelete}
                    disabled={Boolean(disabled)}
                    onConfirm={() => deleteModel(view.slug)}
                  />
                </div>
              </div>
            ))}
          </div>
        ))}
        {catalog?.path ? (
          <div className="border-t border-border pt-3">
            <Button
              variant="outline"
              size="sm"
              disabled={Boolean(disabled) || providers.length === 0}
              onClick={() => {
                setFormError(null);
                setProviderForm(null);
                const firstProvider = providers[0]?.id;
                if (!firstProvider) return;
                setModelForm(
                  codexModelFormFrom(
                    undefined,
                    codexCatalogModelTemplate(catalog.models, firstProvider),
                  ),
                );
              }}
            >
              {text.modelAdd}
            </Button>
          </div>
        ) : null}
        {modelForm ? (
          <CodexCatalogModelFormView
            form={modelForm}
            creating={!modelForm.originalSlug}
            providers={providers}
            disabled={Boolean(disabled)}
            error={null}
            onChange={setModelForm}
            onSubmit={submitModel}
            onCancel={() => setModelForm(null)}
          />
        ) : null}
        {catalogStale ? (
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border bg-surface p-3">
            <p className="min-w-0 flex-1 text-ui-sm text-foreground-subtle">
              {text.modelCatalogStale}
            </p>
            <CodexConfirmButton
              label={text.modelRestartRuntime}
              disabled={Boolean(disabled)}
              onConfirm={restartRuntime}
            />
          </div>
        ) : null}
      </CodexSection>
    </div>
  );
}
