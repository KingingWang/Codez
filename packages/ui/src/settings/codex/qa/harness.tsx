// Browser-only fixture: real UI/hooks, injected Host authority, no filesystem or native credentials.
import { StrictMode, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import type { IServiceAccessor } from "@zcode/services";
import type { IPlatformService, CodexRequest } from "@zcode/shared";
import type { ConversationSnapshot, PendingInteraction } from "@zcode/shared/zcode-protocol-v4";
import { pendingInteractionSchema, queueStateSchema } from "@zcode/shared/zcode-protocol-v4";
import { ServiceProvider } from "@/hooks/useServices.js";
import { PlatformProvider } from "@/hooks/usePlatform.js";
import { TabStoreProvider, useTabStoreApi } from "@/store/TabStoreProvider.js";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";
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
import {
  createProjectDiscoveryLocalServices,
  initializeProjectDiscoveryFixture,
  ProjectDiscoveryFixture,
  seedProjectDiscoveryFixtureTabs,
} from "./project-discovery-fixture.js";
import "@/styles.css";

const model = (name: string, isDefault = false) => ({
  id: `id-${name}`,
  model: name,
  displayName: name,
  description: "QA fixture",
  hidden: false,
  isDefault,
  defaultReasoningEffort: "medium",
  supportedReasoningEfforts: [
    { reasoningEffort: "medium", description: "Balanced" },
    { reasoningEffort: "high", description: "Detailed" },
  ],
});
const projectDiscoveryLocalServices = createProjectDiscoveryLocalServices();
const requests: Array<CodexRequest & { workspacePath?: string }> = [];
let modelFailure = false;
let legacyReads = 0;
let interactionCommandCount = 0;
const config = {
  config: {
    model: "native-model",
    model_provider: "native-provider",
    model_reasoning_effort: "medium",
  },
  origins: {},
  layers: [
    { name: { type: "user", file: "/isolated/config.toml" }, version: "fixture-v1", config: {} },
  ],
};
const otherWorkspaceConfig = {
  config: {
    model: "workspace-model",
    model_provider: "native-provider",
    model_reasoning_effort: "medium",
  },
  origins: {},
  layers: [
    {
      name: { type: "user", file: "/isolated/other-config.toml" },
      version: "fixture-v1",
      config: {},
    },
  ],
};
const emptyEvent = () => ({ dispose() {} });
const services = {
  zcodeAgentService: {
    onAgentRuntimeRestarted: emptyEvent,
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
  zcodeSessionService: projectDiscoveryLocalServices.zcodeSessionService,
} as unknown as IServiceAccessor;
initializeProjectDiscoveryFixture();
const platform = {
  openExternal: () => {
    throw new Error("External navigation forbidden");
  },
  showTaskNotification() {},
} as unknown as IPlatformService;
const questions = [
  {
    id: "deployment-target",
    header: "Target",
    question: "Where should this run?",
    options: [
      { label: "Staging", description: "Isolated" },
      { label: "Production", description: "Not used" },
    ],
  },
  { id: "private-code", header: "Secret", question: "Enter fixture secret", isSecret: true },
];
function ProjectDiscoveryTabSeeder() {
  const tabStore = useTabStoreApi();
  const seededRef = useRef(false);
  if (!seededRef.current) {
    seededRef.current = true;
    seedProjectDiscoveryFixtureTabs(tabStore);
  }
  return null;
}

function Harness() {
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
        <Button onClick={() => ask("userInput")}>Native questions</Button>
        <Button onClick={() => ask("permission")}>Native approval</Button>
        <Button onClick={() => setRejectNext(true)}>Reject next answer</Button>
        <Button onClick={() => setOutput({ requests, legacyReads, interactionCommandCount })}>
          Inspect RPC log
        </Button>
        <Button onClick={() => setSettingsOpen((open) => !open)}>Toggle settings</Button>
      </div>
      <ProjectDiscoveryFixture />
      <CatalogLifetimeControls read={read} output={setOutput} />
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
          <ZCodeIntlProvider initialLocale="en-US">
            <TooltipProvider>
              <Harness />
            </TooltipProvider>
          </ZCodeIntlProvider>
        </TabStoreProvider>
      </PlatformProvider>
    </ServiceProvider>
  </StrictMode>,
);
