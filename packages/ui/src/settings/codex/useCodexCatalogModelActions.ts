import type { CodezCatalogModelEntry } from "@codez/shared";
import type { CodexSettingsController } from "@/hooks/useCodexSettings.js";
import {
  codexCatalogModelWriteParams,
  codexModelEntryFromForm,
  type CodexCatalogModelView,
  type CodexModelForm,
} from "./codexProviderSettings.js";
import type { useCodexMessages } from "./messages.js";

export interface CodexCatalogModelsState {
  path: string | null;
  models: CodezCatalogModelEntry[];
}

interface WorkspaceRef {
  workspacePath: string;
  workspaceIdentity?: string;
}

/** 目录模型（model_catalog_json）的写操作编排；供应商/Key 逻辑在 codexProviderKeyFlow。 */
export function useCodexCatalogModelActions(params: {
  controller: CodexSettingsController;
  workspaceRef: WorkspaceRef | null;
  catalog: CodexCatalogModelsState | null;
  modelForm: CodexModelForm | null;
  text: ReturnType<typeof useCodexMessages>;
  setFormError: (value: string | null) => void;
  setModelForm: (value: CodexModelForm | null) => void;
  setCatalogStale: (value: boolean) => void;
  setNotice: (value: string | null) => void;
  loadCatalog: () => Promise<void>;
}): {
  submitModel: () => void;
  deleteModel: (slug: string) => void;
  toggleModelHidden: (view: CodexCatalogModelView) => void;
  restartRuntime: () => void;
} {
  const {
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
  } = params;

  async function writeCatalog(operation: () => Promise<unknown>) {
    setNotice(null);
    await operation();
    await loadCatalog();
    setCatalogStale(true);
    setNotice(text.modelCatalogStale);
  }

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
        writeCatalog(() =>
          agent.writeCodexCatalogModel(
            codexCatalogModelWriteParams(modelForm, workspaceRef),
          ),
        ),
      )
      .then((ok) => {
        if (ok) setModelForm(null);
      });
  };

  const deleteModel = (slug: string) => {
    if (!workspaceRef) return;
    const agent = controller.services.codezAgentService;
    void controller.run(() =>
      writeCatalog(() =>
        agent.deleteCodexCatalogModel({ ...workspaceRef, slug }),
      ),
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

  return { submitModel, deleteModel, toggleModelHidden, restartRuntime };
}
