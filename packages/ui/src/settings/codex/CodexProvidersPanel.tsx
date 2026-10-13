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
import { CodexConfirmButton, CodexNotice, CodexSection } from "./CodexSettingsParts.js";
import { useCodexMessages } from "./messages.js";
import {
  useCodexManagedKeyState,
  useCodexProviderKeySupport,
} from "./useCodexProviderKeySupport.js";
import { useCodexCatalogModelActions } from "./useCodexCatalogModelActions.js";

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
  const { managedKeyConfigured, probeProvider, reset: resetManagedKeyState } =
    useCodexManagedKeyState(keyService, keySourceSupported);

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
    void loadCatalog();
  }, [loadCatalog]);

  const providers = useMemo(
    () => codexProvidersView(config, catalog?.models ?? []),
    [config, catalog],
  );
  const defaultModel = codexConfiguredDefaultModel(config);
  const modelGroups = useMemo(
    () => codexCatalogModelGroups(catalog?.models ?? [], providers),
    [catalog, providers],
  );

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
      <CodexSection title={text.providers}>
        <CodexNotice>{text.providersHelp}</CodexNotice>
        {controller.snapshot.config?.error ? (
          <CodexNotice error>{controller.snapshot.config.error}</CodexNotice>
        ) : null}
        {notice ? <CodexNotice>{notice}</CodexNotice> : null}
        {formError ? <CodexNotice error>{formError}</CodexNotice> : null}
        {providers.length > 0 && !catalogReady ? (
          <CodexNotice>{text.providerCatalogUnavailable}</CodexNotice>
        ) : null}
        {providers.length === 0 ? <CodexNotice>{text.providerEmpty}</CodexNotice> : null}
        {providers.map((view) => (
          <CodexProviderRow
            key={view.id}
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
              resetManagedKeyState();
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
      </CodexSection>
      <CodexSection title={text.providerModels}>
        <CodexNotice>{text.providerModelsHelp}</CodexNotice>
        {catalogError ? <CodexNotice error>{catalogError}</CodexNotice> : null}
        {catalogReady && !catalog?.path ? <CodexNotice>{text.modelNoCatalog}</CodexNotice> : null}
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
                  {catalog?.models.length === 1 ? (
                    <p className="text-ui-sm text-foreground-subtle">
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
                      const source = catalog?.models.find((entry) => entry.slug === view.slug);
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
              confirmationLabel={text.modelConfirmRestart}
              confirmationNotice={text.modelRestartRuntimeConfirm}
              disabled={Boolean(disabled)}
              onConfirm={restartRuntime}
            />
          </div>
        ) : null}
      </CodexSection>
    </div>
  );
}
