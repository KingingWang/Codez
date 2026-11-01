import { useCallback, useEffect, useMemo, useState } from "react";
import { Package, Plus } from "lucide-react";
import {
  codexConfigWriteResponseSchema,
  type CodezCatalogModelEntry,
  type CodexRequest,
} from "@codez/shared";
import { Button } from "@/components/ui/button.js";
import { Switch } from "@/components/ui/switch.js";
import {
  SettingsResourceGroupHeader,
  SettingsResourceList,
  ModelProviderSplitPanel,
} from "@/settings/SettingsResourceGroup.js";
import type { CodexSettingsController } from "@/hooks/useCodexSettings.js";
import {
  codexCatalogModelTemplate,
  codexCatalogModelGroups,
  codexConfiguredDefaultModel,
  codexModelFormFrom,
  codexProviderDeleteBlock,
  codexProviderFormError,
  codexProviderFormFrom,
  codexProviderSetDefaultEdits,
  codexProvidersView,
  isCodexManagedEnvKey,
  type CodexConfigEdit,
  type CodexModelForm,
  type CodexProviderForm,
  type CodexProviderView,
} from "./codexProviderSettings.js";
import {
  deleteCodexProviderWithKeyCleanup,
  saveCodexProviderWithKeySource,
} from "./codexProviderKeyFlow.js";
import { codexUserConfigTarget } from "./codexSettingsData.js";
import { CodexCatalogModelFormView, CodexProviderFormView } from "./CodexProviderForms.js";
import { CodexProviderRow } from "./CodexProviderRow.js";
import { CodexConfirmButton, CodexNotice } from "./CodexSettingsParts.js";
import { useCodexMessages } from "./messages.js";
import {
  useCodexManagedKeyState,
  useCodexProviderKeySupport,
} from "./useCodexProviderKeySupport.js";
import { useCodexCatalogModelActions } from "./useCodexCatalogModelActions.js";
import { SettingsResourceHeaderActions } from "@/settings/SettingsResourceHeaderActions.js";

interface CatalogState {
  path: string | null;
  models: CodezCatalogModelEntry[];
}

export function CodexProvidersPanel({
  controller,
  workspacePath,
  workspaceIdentity,
  showRefresh = true,
}: {
  controller: CodexSettingsController;
  workspacePath?: string | null;
  workspaceIdentity?: string;
  showRefresh?: boolean;
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
  const [selectedProviderId, setSelectedProviderId] = useState<string | null>(null);

  const config = controller.snapshot.config?.data;
  const target = codexUserConfigTarget(config);
  const disabled = controller.busy || controller.loading || !controller.enabled || !target;
  const catalogReady = catalog !== null && catalogError === null;
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
  const keyService = controller.services.codexNativeProviderKeyService;
  const keySourceSupported = useCodexProviderKeySupport(
    controller.services,
    controller.enabled,
    workspaceRef?.workspacePath,
  );
  // 本机临时 Key 的凭据存在性；仅控制提示展示，安全判定在 Host/bridge。
  const {
    managedKeyConfigured,
    probeProvider,
    reset: resetManagedKeyState,
  } = useCodexManagedKeyState(keyService, keySourceSupported);

  const loadCatalog = useCallback(async () => {
    if (!workspaceRef) return;
    setCatalog(null);
    setCatalogError(null);
    try {
      const result =
        await controller.services.codezAgentService.readCodexCatalogModels(workspaceRef);
      setCatalog({ path: result.path, models: result.models });
      setCatalogError(null);
    } catch (error) {
      setCatalog(null);
      setCatalogError(error instanceof Error ? error.message : String(error));
    }
  }, [controller.services, workspaceRef]);

  useEffect(() => {
    // 独立 Codex 页的外层刷新会替换配置快照；目录随同刷新，不另放重复按钮。
    void loadCatalog();
  }, [loadCatalog, config]);

  const providers = useMemo(
    () => codexProvidersView(config, catalog?.models ?? []),
    [config, catalog],
  );
  const defaultModel = codexConfiguredDefaultModel(config);
  const modelGroups = useMemo(
    () => codexCatalogModelGroups(catalog?.models ?? [], providers),
    [catalog, providers],
  );
  // 修复原因：fork 将原供应商导航改成上下长列表，配置和模型失去共同目标。
  // 这里只恢复纯展示分栏；左侧选择不是「设为默认」，不触碰原生配置或会话模型。
  const navigation = [
    ...providers.map((provider) => ({ id: provider.id, name: provider.name })),
    ...modelGroups
      .filter((group) => !providers.some((provider) => provider.id === group.key))
      .map((group) => ({ id: group.key, name: group.label })),
  ];
  const selectedId = navigation.some((entry) => entry.id === selectedProviderId)
    ? selectedProviderId
    : (navigation[0]?.id ?? null);
  const selectedProvider = providers.find((provider) => provider.id === selectedId);
  const shownModelGroups = modelGroups.filter((group) => group.key === selectedId);
  // 外部删除后的回退只在目录事实已验证时清理草稿，瞬时重读不能把在制表单误清空。
  if (
    catalogReady &&
    config &&
    !controller.snapshot.config?.error &&
    !controller.busy &&
    !controller.loading &&
    selectedProviderId !== null &&
    selectedId !== selectedProviderId
  ) {
    setSelectedProviderId(selectedId);
    setProviderForm(null);
    setModelForm(null);
  }
  const selectProvider = (id: string) => {
    setSelectedProviderId(id);
    setProviderForm(null);
    setModelForm(null);
    setFormError(null);
    resetManagedKeyState();
  };
  const addProvider = () => {
    setFormError(null);
    setModelForm(null);
    setProviderForm({ form: codexProviderFormFrom(), creating: true });
    resetManagedKeyState();
  };

  async function writeEdits(edits: CodexConfigEdit[]) {
    setNotice(null);
    const request: CodexRequest = {
      method: "config/batchWrite",
      params: { ...target, edits, reloadUserConfig: true },
    };
    const result = codexConfigWriteResponseSchema.parse(await controller.request(request));
    setNotice(result.status === "okOverridden" ? text.overridden : text.saved);
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
    void controller
      .run(async () => {
        // 顺序契约（spec: codex-provider-runtime-env-key）：先建立跨连接屏障并写
        // 本机凭据，再写 config.toml 引用，最后逐连接安装并解除屏障。
        await saveCodexProviderWithKeySource(
          {
            keyService,
            keySourceSupported,
            unsupportedMessage: text.providerKeySourceUnsupported,
            writeEdits,
          },
          { form, creating },
        );
      })
      .then((ok) => {
        if (ok) {
          if (providerForm.creating) setSelectedProviderId(providerForm.form.id.trim());
          setProviderForm(null);
          resetManagedKeyState();
        }
      });
  };

  const deleteProvider = (view: CodexProviderView) => {
    // 根因：目录读取失败曾被投影成空数组，未知引用数误判为 0 时会放行删除。
    // 判定与按钮禁用共用 codexProviderDeleteBlock；写入前再判一次，
    // 使删除不变量不依赖渲染期 prop（新增入口/自动化调用同样受保护）。
    const block = codexProviderDeleteBlock(view, catalogReady);
    if (block) {
      setFormError(text[block]);
      return;
    }
    setFormError(null);
    void controller.run(() =>
      deleteCodexProviderWithKeyCleanup(
        {
          keyService,
          keySourceSupported,
          unsupportedMessage: text.providerKeySourceUnsupported,
          writeEdits,
        },
        view,
      ),
    );
  };

  const { submitModel, deleteModel, toggleModelHidden, restartRuntime } =
    useCodexCatalogModelActions({
      controller,
      workspaceRef,
      catalog,
      modelForm,
      text,
      setFormError,
      setModelForm,
      setCatalogStale,
      setNotice,
      loadCatalog,
    });

  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-3">
        <p className="text-ui-base leading-6 text-foreground-subtle">{text.providersHelp}</p>
        <SettingsResourceHeaderActions
          onRefresh={
            showRefresh ? () => void Promise.all([controller.refresh(), loadCatalog()]) : undefined
          }
          refreshLabel={text.refresh}
          refreshing={controller.loading}
          refreshDisabled={controller.busy || controller.loading || !controller.enabled}
          onNew={addProvider}
          newLabel={text.providerAdd}
          newDisabled={Boolean(disabled)}
        />
      </div>
      <ModelProviderSplitPanel
        navigation={
          <nav aria-label={text.providers} className="space-y-1 p-2">
            {navigation.map((entry) => (
              <button
                key={entry.id}
                type="button"
                aria-label={entry.name}
                aria-current={selectedId === entry.id ? "page" : undefined}
                data-testid={`codex-provider-nav-${entry.id || "unassigned"}`}
                disabled={controller.busy}
                onClick={() => selectProvider(entry.id)}
                className={`relative box-border flex h-8 w-full items-center gap-2 rounded-lg border px-2 py-1 text-left text-ui-base font-medium transition-colors max-md:size-8 max-md:justify-center max-md:px-0 ${
                  selectedId === entry.id
                    ? "border-border-hover bg-card-selected text-foreground"
                    : "border-transparent text-foreground hover:border-border-hover/60"
                } disabled:cursor-not-allowed disabled:opacity-60`}
              >
                <Package className="size-4 shrink-0" aria-hidden="true" />
                <span className="min-w-0 truncate max-md:sr-only">{entry.name}</span>
              </button>
            ))}
          </nav>
        }
      >
        <div className="space-y-6">
          <section className="space-y-3">
            <SettingsResourceGroupHeader count={selectedProvider ? 1 : 0} title={text.providers} />
            {controller.snapshot.config?.error ? (
              <CodexNotice error>{controller.snapshot.config.error}</CodexNotice>
            ) : null}
            {notice ? <CodexNotice>{notice}</CodexNotice> : null}
            {formError ? <CodexNotice error>{formError}</CodexNotice> : null}
            {providers.length > 0 && !catalogReady ? (
              <CodexNotice>{text.providerCatalogUnavailable}</CodexNotice>
            ) : null}
            {providers.length === 0 ? <CodexNotice>{text.providerEmpty}</CodexNotice> : null}
            <SettingsResourceList
              items={selectedProvider ? [selectedProvider] : []}
              getKey={(view) => view.id}
              renderItem={(view) => (
                <CodexProviderRow
                  view={view}
                  disabled={Boolean(disabled)}
                  catalogReady={catalogReady}
                  onSetDefault={() =>
                    void controller.run(() => writeEdits(codexProviderSetDefaultEdits(view.id)))
                  }
                  onEdit={() => {
                    setFormError(null);
                    setModelForm(null);
                    setProviderForm({ form: codexProviderFormFrom(view), creating: false });
                    probeProvider(view);
                  }}
                  onDelete={() => deleteProvider(view)}
                />
              )}
            />
            {providerForm ? (
              <CodexProviderFormView
                form={providerForm.form}
                creating={providerForm.creating}
                disabled={Boolean(disabled)}
                error={null}
                keySourceSupported={keySourceSupported}
                hasAuthCommand={
                  providers.find((provider) => provider.id === providerForm.form.id.trim())
                    ?.hasAuthCommand
                }
                externalEnvKey={(() => {
                  const envKey = providerForm.form.initialEnvKey;
                  return envKey && !isCodexManagedEnvKey(envKey) ? envKey : undefined;
                })()}
                managedKeyConfigured={managedKeyConfigured}
                onChange={(form) => setProviderForm({ ...providerForm, form })}
                onSubmit={submitProvider}
                onCancel={() => {
                  setProviderForm(null);
                  resetManagedKeyState();
                }}
              />
            ) : null}
          </section>
          <section className="space-y-3">
            <SettingsResourceGroupHeader
              count={shownModelGroups.reduce((total, group) => total + group.entries.length, 0)}
              title={text.providerModels}
              actions={
                catalog?.path ? (
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={Boolean(disabled) || !selectedProvider}
                    onClick={() => {
                      setFormError(null);
                      setProviderForm(null);
                      const firstProvider = selectedProvider?.id;
                      if (!firstProvider) return;
                      setModelForm(
                        codexModelFormFrom(
                          undefined,
                          codexCatalogModelTemplate(catalog.models, firstProvider),
                        ),
                      );
                    }}
                  >
                    <Plus data-icon="inline-start" aria-hidden="true" />
                    {text.modelAdd}
                  </Button>
                ) : undefined
              }
            />
            <CodexNotice>{text.providerModelsHelp}</CodexNotice>
            {catalogError ? <CodexNotice error>{catalogError}</CodexNotice> : null}
            {catalogReady && !catalog?.path ? (
              <CodexNotice>{text.modelNoCatalog}</CodexNotice>
            ) : null}
            {shownModelGroups.length === 0 && catalog?.path ? (
              <CodexNotice>{text.providerModelsEmpty}</CodexNotice>
            ) : null}
            {shownModelGroups.map((group) => (
              <div key={group.key || "(none)"} className="space-y-2">
                <p className="text-ui-sm font-medium text-foreground-subtle">{group.label}</p>
                <SettingsResourceList
                  items={group.entries}
                  getKey={(view) => view.slug}
                  renderItem={(view) => (
                    <div className="flex flex-col items-start justify-between gap-3 px-4 py-3 transition-colors hover:bg-hover md:flex-row md:items-center">
                      <div className="w-full min-w-0 md:flex-1">
                        <p className="text-ui-base font-medium text-foreground">
                          {view.displayName}
                        </p>
                        <p className="mt-0.5 break-all font-mono text-ui-sm text-foreground-subtlest">
                          {view.slug}
                          {view.slug === defaultModel ? ` · config.model` : ""}
                        </p>
                        {view.slug === defaultModel ? (
                          <p className="mt-0.5 text-ui-sm text-foreground-subtlest">
                            {text.modelDeleteDefaultWarning}
                          </p>
                        ) : null}
                        {catalog?.models.length === 1 ? (
                          <p className="mt-0.5 text-ui-sm text-foreground-subtle">
                            {text.modelDeleteLastBlocked}
                          </p>
                        ) : null}
                      </div>
                      <div className="flex flex-wrap items-center gap-2">
                        <Switch
                          // 列表勾选态是“显示”，与编辑表单的 hidden 草稿相反；读屏名称必须跟状态一致，
                          // 并包含 slug，避免多个同名模型的开关无法区分。
                          aria-label={`${text.modelVisible}: ${view.slug}`}
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
                            const source = catalog?.models.find(
                              (entry) => entry.slug === view.slug,
                            );
                            if (source) setModelForm(codexModelFormFrom(source, {}));
                          }}
                        >
                          {text.providerEdit}
                        </Button>
                        <CodexConfirmButton
                          label={text.providerDelete}
                          targetLabel={view.slug}
                          disabled={Boolean(disabled) || catalog?.models.length === 1}
                          onConfirm={() => deleteModel(view.slug)}
                        />
                      </div>
                    </div>
                  )}
                />
              </div>
            ))}
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
                  confirmationLabel={text.modelConfirmRestart}
                  confirmationNotice={text.modelRestartRuntimeConfirm}
                  disabled={Boolean(disabled)}
                  onConfirm={restartRuntime}
                />
              </div>
            ) : null}
          </section>
        </div>
      </ModelProviderSplitPanel>
    </div>
  );
}
