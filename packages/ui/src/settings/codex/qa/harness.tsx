// Browser-only fixture: real UI/hooks, injected Host authority, no filesystem or native credentials.
import { StrictMode, useState } from "react";
import { createRoot } from "react-dom/client";
import type { IServiceAccessor } from "@codez/services";
import type {
  CodexRequest,
  CodezAgentRoleScope,
  CodezAgentRoleSummary,
  CodezAgentRoleWriteInput,
} from "@codez/shared";
import type { ConversationSnapshot, PendingInteraction } from "@codez/shared/codez-protocol-v4";
import { pendingInteractionSchema, queueStateSchema } from "@codez/shared/codez-protocol-v4";
import { ServiceProvider } from "@/hooks/useServices.js";
import { PlatformProvider } from "@/hooks/usePlatform.js";
import { TabStoreProvider } from "@/store/TabStoreProvider.js";
import { CodezIntlProvider, useCodezIntl } from "@/i18n/IntlProvider.js";
import { useCodexModelCatalog } from "@/hooks/useCodexModelCatalog.js";
import { useDraftConfigControl } from "@/v4/composer/useDraftConfigControl.js";
import { useDraftModelReadinessGate } from "@/v4/composer/useDraftModelReadinessGate.js";
import { createComposerSubmissionConfig } from "@/v4/composer/composerSubmissionConfig.js";
import { V4InteractionDialogs } from "@/v4/V4InteractionDialogs.js";
import {
  V4ConversationContext,
  type V4ConversationContextValue,
} from "@/v4/V4ConversationContext.js";
import { ConversationQueuePanel } from "@/v4/ConversationQueuePanel.js";
import { Button } from "@/components/ui/button.js";
import { TooltipProvider } from "@/components/ui/tooltip.js";
import { CodexSettingsSection } from "../CodexSettingsSection.js";
import { CodexComposerModelControls } from "../CodexComposerModelControls.js";
import { V4ComposerModeSwitch } from "@/v4/composer/V4ComposerModeControls.js";
import type { V4ComposerConfigPicker } from "@/v4/composer/configPickerState.js";
import { CatalogLifetimeControls, waitForCatalogFixture } from "./catalog-lifetime-fixture.js";
import { UsageObservationRaceFixture } from "./usage-observation-fixture.js";
import { MessageFeedbackFixture } from "./message-feedback-fixture.js";
import { createCatalogModelsFixture } from "./catalog-models-fixture.js";
import { config, model, otherWorkspaceConfig, platform, questions } from "./harnessConfig.js";
import { AdditionalFixtures } from "./additional-fixtures.js";
import {
  createProjectDiscoveryLocalServices,
  initializeProjectDiscoveryFixture,
  ProjectDiscoveryFixture,
  ProjectDiscoveryTabSeeder,
} from "./project-discovery-fixture.js";
import "@/styles.css";
const projectDiscoveryLocalServices = createProjectDiscoveryLocalServices();
const requests: Array<CodexRequest & { workspacePath?: string }> = [];
let modelFailure = false;
let providerCatalogFailure = true;
let rolesReadFailure = true;
let rolesWriteFailure = true;
const agentRoles: CodezAgentRoleSummary[] = [];
let legacyReads = 0;
let catalogReads = 0;
let interactionCommandCount = 0;
let inspection = 0;
const catalogModelsFixture = createCatalogModelsFixture();
const emptyEvent = () => ({ dispose() {} });
const services = {
  codezAgentService: {
    onAgentRuntimeRestarted: emptyEvent,
    async readCodexCatalog() {
      // 根因：composer 已增加 Host 目录读取边界，旧夹具未实现而使模型就绪失败。
      // 目录未配置时按真实服务合同返回空映射，模型回退到激活 provider 组。
      catalogReads++;
      return { path: null, models: [] };
    },
    async readCodexCatalogModels() {
      if (providerCatalogFailure) throw new Error("Fixture provider catalog unavailable");
      return catalogModelsFixture.read();
    },
    writeCodexCatalogModel: catalogModelsFixture.write,
    disposeWorkspace: catalogModelsFixture.dispose,
    async listAgentRoles() {
      if (rolesReadFailure) throw new Error("Fixture agent roles unavailable");
      return { roles: [...agentRoles], diagnostics: [] };
    },
    async writeAgentRole({
      scope,
      role,
    }: {
      scope: CodezAgentRoleScope;
      role: CodezAgentRoleWriteInput;
    }) {
      if (rolesWriteFailure) throw new Error("Fixture role write rejected");
      agentRoles.push({
        ...role,
        scope,
        fileName: `${role.name}.toml`,
      });
    },
    codexRequest: async ({
      request,
      workspacePath,
    }: {
      request: CodexRequest;
      workspacePath: string;
    }) => {
      requests.push(request.method === "config/read" ? { ...request, workspacePath } : request);
      switch (request.method) {
        case "config/read":
          return structuredClone(
            workspacePath === "/isolated/other-workspace" ? otherWorkspaceConfig : config,
          );
        case "model/list":
          await waitForCatalogFixture();
          if (modelFailure) throw new Error("Fixture catalog unavailable");
          return { data: [model("native-model", true), model("second-model")], nextCursor: null };
        case "account/read":
          return { account: null, requiresOpenaiAuth: false };
        case "configRequirements/read":
          return { requirements: null };
        case "skills/list":
          return { data: [] };
        case "mcpServerStatus/list":
          return { data: [], nextCursor: null };
        case "plugin/list":
          return { marketplaces: [], marketplaceLoadErrors: [], featuredPluginIds: [] };
        case "config/batchWrite": {
          const edits = (request.params as { edits: { keyPath: string; value: string }[] }).edits;
          for (const edit of edits)
            if (edit.keyPath === "model" || edit.keyPath === "model_reasoning_effort")
              config.config[edit.keyPath] = edit.value;
          return {
            status: "ok",
            version: "fixture-v2",
            filePath: "/isolated/config.toml",
            overriddenMetadata: null,
          };
        }
        default:
          throw new Error(`Forbidden fixture mutation: ${request.method}`);
      }
    },
  },
  settingService: { get: async () => ({}) },
  modelSelectionService: {
    getView: () => {
      legacyReads++;
      throw new Error("Legacy registry accessed");
    },
    onDidChange: () => {
      legacyReads++;
      throw new Error("Legacy registry subscribed");
    },
  },
  codezSessionService: projectDiscoveryLocalServices.codezSessionService,
} as unknown as IServiceAccessor;
initializeProjectDiscoveryFixture();
function Harness() {
  const { setLocale } = useCodezIntl();
  const [busy, setBusy] = useState(false);
  const [picker, setPicker] = useState<V4ComposerConfigPicker | null>(null);
  const [session, setSession] = useState<string | null>(null);
  const [pending, setPending] = useState<PendingInteraction | null>(null);
  const [output, setOutput] = useState<unknown>(null);
  const [rejectNext, setRejectNext] = useState(false);
  const [requestNumber, setRequestNumber] = useState(0);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [workspacePath, setWorkspacePath] = useState("/isolated/workspace");
  const read = useCodexModelCatalog({ workspacePath, enabled: true });
  const gate = useDraftModelReadinessGate({
    workspacePath,
    sessionId: session,
    modelSelectionService: services.modelSelectionService,
    codex: true,
  });
  const draft = useDraftConfigControl({
    workspacePath,
    sessionId: session,
    modelSelectionService: services.modelSelectionService,
    codex: true,
    codexCatalog: read.catalog,
    agentStartupAllowed: false,
    sessionConfig: session
      ? { model: "second-model", provider: "native-provider", thought: "high" }
      : null,
  });
  const submission = createComposerSubmissionConfig(draft.draftConfig, null, read.catalog);
  const conversation = {
    sendCommand: async (envelope: { commandId: string; payload: unknown }) => {
      interactionCommandCount += 1;
      setOutput(envelope);
      await new Promise((resolve) => setTimeout(resolve, 180));
      if (rejectNext) {
        setRejectNext(false);
        return {
          commandId: envelope.commandId,
          status: "rejected",
          reasonCode: "fixture.rejected",
        };
      }
      setPending(null);
      return { commandId: envelope.commandId, status: "accepted" };
    },
  } as unknown as V4ConversationContextValue;
  const ask = (kind: "permission" | "userInput") => {
    setRequestNumber((value) => value + 1);
    setPending(
      pendingInteractionSchema.parse({
        interactionId: `fixture-${requestNumber}`,
        kind,
        anchorRowId: null,
        createdAt: Date.now(),
        payload:
          kind === "userInput"
            ? {
                kind,
                prompt: "Questions",
                freeText: true,
                toolName: "AskUserQuestion",
                input: { questions },
              }
            : {
                kind,
                toolName: "Native fixture tool",
                toolCallId: "fixture-tool",
                summary: "Approve a harmless QA fixture",
                detail: { command: "echo fixture" },
                options: [
                  { optionId: "accept", label: "Allow once", kind: "allowOnce" },
                  { optionId: "acceptForSession", label: "Allow for this session", kind: "custom" },
                  { optionId: "decline", label: "Deny", kind: "deny" },
                  { optionId: "cancel", label: "Cancel turn", kind: "custom" },
                ],
              },
      }),
    );
  };
  return (
    <main className="mx-auto max-w-3xl space-y-6 p-6 text-foreground">
      <h1>Codex isolated interaction QA</h1>
      <AdditionalFixtures onInspect={setOutput} />
      <div className="flex flex-wrap gap-2">
        <Button onClick={() => setBusy(!busy)}>Toggle native busy</Button>
        <Button onClick={() => setSession(session ? null : "existing-native-session")}>
          {session ? "NewTask" : "Active conversation"}
        </Button>
        <Button
          onClick={() =>
            setWorkspacePath((current) =>
              current === "/isolated/workspace"
                ? "/isolated/other-workspace"
                : "/isolated/workspace",
            )
          }
        >
          Switch workspace
        </Button>
        <Button
          onClick={() => {
            config.config.model =
              config.config.model === "vendor/private" ? "native-model" : "vendor/private";
            config.config.model_reasoning_effort =
              config.config.model === "vendor/private" ? "custom-effort" : "medium";
            read.reload();
          }}
        >
          Toggle configured custom model
        </Button>
        <Button
          onClick={() => {
            modelFailure = !modelFailure;
            read.reload();
          }}
        >
          Toggle catalog failure
        </Button>
        <Button onClick={() => (providerCatalogFailure = !providerCatalogFailure)}>
          Toggle provider catalog failure
        </Button>
        <Button onClick={() => (rolesReadFailure = !rolesReadFailure)}>
          Toggle roles read failure
        </Button>
        <Button onClick={() => (rolesWriteFailure = !rolesWriteFailure)}>
          Toggle roles write failure
        </Button>
        <Button onClick={() => ask("userInput")}>Native questions</Button>
        <Button onClick={() => ask("permission")}>Native approval</Button>
        <Button onClick={() => setRejectNext(true)}>Reject next answer</Button>
        <Button
          onClick={() =>
            setOutput({
              inspection: ++inspection,
              requests,
              legacyReads,
              catalogReads,
              catalogWrites: catalogModelsFixture.writes,
              catalogModelVisibility: catalogModelsFixture.visibility,
              runtimeDisposals: catalogModelsFixture.disposals,
              interactionCommandCount,
            })
          }
        >
          Inspect RPC log
        </Button>
        <Button onClick={() => setSettingsOpen((open) => !open)}>Toggle settings</Button>
        <Button onClick={() => setLocale("zh-CN")}>Use Chinese locale fixture</Button>
        <Button onClick={() => setLocale("en-US")}>Use English locale fixture</Button>
      </div>
      <ProjectDiscoveryFixture />
      <CatalogLifetimeControls read={read} output={setOutput} />
      <UsageObservationRaceFixture />
      <MessageFeedbackFixture />
      <section aria-label="Composer" className="space-y-2">
        <V4ComposerModeSwitch
          workspacePath={workspacePath}
          draftConfig={draft.draftConfig}
          disabled={busy}
          activeConfigPicker={picker}
          onConfigPickerOpenChange={(value, open) => setPicker(open ? value : null)}
          onSwitchMode={(value) => {
            if (!busy) draft.handleDraftSwitchMode(value);
          }}
        />
        <CodexComposerModelControls
          read={read}
          selection={draft.draftConfig.modelSelection}
          disabled={false}
          busy={busy}
          onSelectModel={draft.handleDraftSelectModel}
          onSelectThought={draft.handleDraftSelectThought}
        />
        <Button
          disabled={!submission}
          onClick={async () => {
            if (await gate.ensureReadyForSend())
              setOutput(
                createComposerSubmissionConfig(
                  draft.draftConfigRef.current,
                  null,
                  await read.readCurrent(),
                ),
              );
          }}
        >
          Send fixture
        </Button>
        <output data-testid="legacy-reads">Legacy registry reads: {legacyReads}</output>
      </section>
      <div className="pb-8">
        <ConversationQueuePanel
          nativeCodex
          queue={queueStateSchema.parse({
            autoDrain: false,
            pauseReason: "stopped",
            items: [
              {
                sourceCommandId: "c1",
                clientId: "qa",
                queueItemId: "q1",
                kind: "sendText",
                text: "Queued fixture",
                attachments: [],
                dispatch: { state: "queued" },
                delivery: { requested: "queue", admitted: "queue" },
                order: { admissionSeq: 1, queuePosition: 0 },
                steer: { state: "notRequested" },
                admittedAt: 1,
              },
            ],
          })}
        />
      </div>
      {settingsOpen ? <CodexSettingsSection workspacePath={workspacePath} /> : null}
      <V4ConversationContext.Provider value={conversation}>
        <V4InteractionDialogs
          sessionId="fixture-session"
          workspacePath="/isolated/workspace"
          snapshot={
            {
              sessionId: "fixture-session",
              meta: { title: "Fixture conversation" },
              pendingInteractions: pending ? [pending] : [],
            } as unknown as ConversationSnapshot
          }
        />
      </V4ConversationContext.Provider>
      <pre
        data-testid="result"
        className="max-h-40 overflow-auto whitespace-pre-wrap break-all text-ui-xs"
      >
        {JSON.stringify(output)}
      </pre>
    </main>
  );
}
createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ServiceProvider services={services}>
      <PlatformProvider platform={platform}>
        <TabStoreProvider>
          <ProjectDiscoveryTabSeeder />
          <CodezIntlProvider initialLocale="en-US">
            <TooltipProvider>
              <Harness />
            </TooltipProvider>
          </CodezIntlProvider>
        </TabStoreProvider>
      </PlatformProvider>
    </ServiceProvider>
  </StrictMode>,
);
