// 隔离 Host 事实复现：配置 provider 没有模型分组；真实草稿/控件/Lexical 共同消费目录。
import { useEffect, useRef, useState } from "react";
import type { IServiceAccessor } from "@codez/services";
import { ServiceProvider } from "@/hooks/useServices.js";
import { useCodexModelCatalog } from "@/hooks/useCodexModelCatalog.js";
import { LexicalChatInput, type LexicalChatInputHandle } from "@/LexicalChatInput.js";
import { Button } from "@/components/ui/button.js";
import { useDraftConfigControl } from "@/v4/composer/useDraftConfigControl.js";
import { createComposerSubmissionConfig } from "@/v4/composer/composerSubmissionConfig.js";
import {
  persistV4ComposerDraft,
  readV4ComposerDraft,
  V4_DRAFT_SCOPE_ROOT,
} from "@/v4/composer/composerDraftStore.js";
import { CodexComposerModelControls } from "../CodexComposerModelControls.js";
import { model } from "./harnessConfig.js";

export const mappedProviderScenario = new URLSearchParams(location.search).get("mapped-provider");
const workspacePath = `/isolated/mapped-provider-${mappedProviderScenario}`;
if (
  mappedProviderScenario === "stale" &&
  !readV4ComposerDraft(workspacePath, undefined, V4_DRAFT_SCOPE_ROOT)
) {
  persistV4ComposerDraft(workspacePath, undefined, V4_DRAFT_SCOPE_ROOT, {
    text: "你好",
    mode: "yolo",
    permissionModeGen: 2,
    planEnabled: true,
    modelSelection: {
      providerId: "config-provider",
      modelId: "second-model",
      options: { reasoningLevel: "high" },
    },
  });
}

export function MappedProviderFixture({ services }: { services: IServiceAccessor }) {
  const [mappedServices] = useState<IServiceAccessor>(() => ({
    ...services,
    subagentsService: {
      ...services.subagentsService,
      async list() {
        return {
          agents: [],
          userAgents: [],
          pluginAgents: [],
          capability: { userScopeAvailable: false },
        };
      },
    },
    codezAgentService: {
      ...services.codezAgentService,
      async readCodexCatalog() {
        return {
          path: "/isolated/catalog.json",
          models: [
            { slug: "glm-5.3", provider: "model-owner" },
            { slug: "second-model", provider: "model-owner" },
          ],
        };
      },
      async codexRequest({ request }) {
        if (request.method === "config/read")
          return {
            config: {
              model_provider: "config-provider",
              model: "glm-5.3",
              model_reasoning_effort: mappedProviderScenario === "stale" ? "medium" : "high",
            },
            origins: {},
            layers: [],
          };
        if (request.method === "model/list")
          return {
            data: [{ ...model("glm-5.3", true), displayName: "GLM-5.3" }, model("second-model")],
            nextCursor: null,
          };
        throw new Error(`Forbidden mapped-provider mutation: ${request.method}`);
      },
    },
  }));
  return (
    <ServiceProvider services={mappedServices}>
      <MappedProviderComposer services={mappedServices} />
    </ServiceProvider>
  );
}

function MappedProviderComposer({ services }: { services: IServiceAccessor }) {
  const read = useCodexModelCatalog({ workspacePath, enabled: true });
  const draft = useDraftConfigControl({
    workspacePath,
    sessionId: null,
    modelSelectionService: services.modelSelectionService,
    codex: true,
    codexCatalog: read.catalog,
    agentStartupAllowed: false,
  });
  const editorApiRef = useRef<LexicalChatInputHandle | null>(null);
  const initialText = useRef(draft.composerDraft.text);
  const [output, setOutput] = useState<unknown>(null);
  // 只在测试编辑器挂载时回填持久化正文，不参与生产模型状态修复。
  useEffect(() => {
    editorApiRef.current?.setText(initialText.current);
  }, []);
  const submission = createComposerSubmissionConfig(draft.draftConfig, null, read.catalog);
  const canSend = Boolean(submission && draft.composerDraft.text.trim());
  const submit = (text: string) => {
    const current = createComposerSubmissionConfig(
      draft.draftConfigRef.current,
      null,
      read.catalog,
    );
    if (current && text.trim()) setOutput({ ...current, text });
    return false; // 夹具保留正文，便于验证恢复与重复发送不改变草稿。
  };
  return (
    <main className="mx-auto max-w-3xl space-y-4 p-6">
      <h1>Mapped provider cold-start regression</h1>
      <CodexComposerModelControls
        read={read}
        selection={draft.draftConfig.modelSelection}
        disabled={false}
        onSelectModel={draft.handleDraftSelectModel}
        onSelectThought={draft.handleDraftSelectThought}
      />
      <LexicalChatInput
        workspacePath={workspacePath}
        taskId={null}
        inputTestId="mapped-provider-input"
        editorApiRef={editorApiRef}
        enableMentionPanel={false}
        submitDisabled={!canSend}
        onSubmit={submit}
        onChange={(text) => draft.updateComposerContent({ text })}
      />
      <Button disabled={!canSend} onClick={() => submit(editorApiRef.current?.getText() ?? "")}>
        Send mapped fixture
      </Button>
      <output data-testid="mapped-draft">{JSON.stringify(draft.draftConfig)}</output>
      <pre data-testid="mapped-result">{JSON.stringify(output)}</pre>
    </main>
  );
}
