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
    setNotice,
    loadCatalog,
  } = params;

  async function writeCatalog(operation: () => Promise<unknown>) {
    setNotice(null);
    await operation();
    // 写盘成功就登记提醒；即使随后重读失败或面板卸载，也不能丢掉待刷新事实。
    controller.markCatalogRestartPending();
    await loadCatalog();
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
          agent.writeCodexCatalogModel(codexCatalogModelWriteParams(modelForm, workspaceRef)),
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
          // Codex ModelVisibility 接受 hide，不接受 UI 布尔草稿名 hidden。
          model: { ...source, visibility: view.hidden ? "list" : "hide" },
        }),
      ),
    );
  };

  const restartRuntime = () => {
    void controller.restartRuntime().then((ok) => {
      if (ok) setNotice(text.saved);
    });
  };

  return { submitModel, deleteModel, toggleModelHidden, restartRuntime };
}
