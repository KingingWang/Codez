// Browser-only QA fixture: real AutomationEditView/hooks, injected services, no user data.
import { useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import type { IServiceAccessor } from "@codez/services";
import type { IPlatformService } from "@codez/shared";
import type { ModelSelectionView, ModelSelectionViewInput } from "@codez/provider";
import { ServiceProvider } from "@/hooks/useServices.js";
import { PlatformProvider } from "@/hooks/usePlatform.js";
import { TabStoreProvider, useTabStoreApi } from "@/store/TabStoreProvider.js";
import { CodezIntlProvider } from "@/i18n/IntlProvider.js";
import { TooltipProvider } from "@/components/ui/tooltip.js";
import { AutomationEditView } from "@/settings/AutomationEditView.js";
import { Button } from "@/components/ui/button.js";
import "@/styles.css";

const emptyEvent = () => ({ dispose() {} });
const modelView = {
  revision: 1,
  providers: [],
  preferredSelection: { providerId: "glm", modelId: "fixture-model" },
  effectiveSelection: { providerId: "glm", modelId: "fixture-model" },
} satisfies ModelSelectionView;
let phase = "delayed";
let readAttempts = 0;
let writes = 0;
let releaseRead: (() => void) | null = null;
const firstWorkspace = "/isolated/automation-workspace";
const secondWorkspace = "/isolated/second-workspace";
const listeners = new Set<(view: ModelSelectionView) => void>();
const delayedRefresh: Array<() => void> = [];
const delayedSecond: Array<() => void> = [];
let secondReady = false;
function fixtureModelConfig(reasoningValues: string[]) {
  return {
    enabled: true,
    properties: {
      requiresMfjsToolSchema: false,
      contextWindow: 1,
      inputFormat: {
        supportsText: true,
        supportsImage: false,
        supportsVideo: false,
        supportsAudio: false,
        supportsPdf: false,
      },
      outputFormat: { supportsText: true },
      supportsToolCall: true,
      supportsJsonSchemaOutput: false,
      supportsNativeWebSearch: false,
      supportsMidConversationSystem: false,
    },
    optionSpecs: {
      reasoningLevel: { values: reasoningValues, map: "{}" },
      maxOutputTokens: { max: 1, map: "{}" },
    },
  };
}
function viewForInput(input: ModelSelectionViewInput): ModelSelectionView {
  const selection =
    input.workspace?.workspacePath === secondWorkspace
      ? { providerId: "glm", modelId: "second-model" }
      : modelView.preferredSelection;
  return {
    ...modelView,
    workspace: input.workspace,
    providers:
      input.workspace?.workspacePath === secondWorkspace
        ? [
            {
              providerId: "glm",
              providerName: "Fixture Codex",
              config: {
                access: { type: "api-key", apiKey: "" },
                api: { type: "openai-chat-completions", baseUrl: "http://127.0.0.1/qa" },
              },
              models: [
                { modelId: "second-model", config: fixtureModelConfig([]) },
                {
                  modelId: "alternative-model",
                  config: fixtureModelConfig(["high"]),
                },
              ],
            },
          ]
        : [],
    preferredSelection: selection,
    effectiveSelection: input.selection ?? null,
  };
}
const services = {
  modelSelectionService: {
    getView: (input?: ModelSelectionViewInput) => {
      readAttempts++;
      // 回归依据：无 workspace 的 fixture 曾放行空 Host View，掩盖真实 GUI 参数漏传。
      if (
        !input?.workspace ||
        ![firstWorkspace, secondWorkspace].includes(input.workspace.workspacePath)
      )
        return Promise.reject(new Error("Fixture requires the selected workspace"));
      if (input.workspace.workspacePath === secondWorkspace && !secondReady)
        return new Promise((resolve) => delayedSecond.push(() => resolve(viewForInput(input))));
      if (phase === "refresh-delayed")
        return new Promise((resolve) =>
          delayedRefresh.push(() => resolve({ ...viewForInput(input), revision: 2 })),
        );
      if (phase === "delayed")
        return new Promise((_resolve, reject) => {
          releaseRead = () => {
            releaseRead = null;
            reject(new Error("Fixture model read failed"));
          };
        });
      if (phase === "error") return Promise.reject(new Error("Fixture model read failed"));
      return Promise.resolve(viewForInput(input));
    },
    onDidChange: (listener: (view: ModelSelectionView) => void) => {
      listeners.add(listener);
      return { dispose: () => listeners.delete(listener) };
    },
  },
  projectService: {
    readProjects: async () => [
      {
        id: "fixture-project",
        hostId: "local",
        name: "Fixture project",
        roots: [{ rootPath: firstWorkspace, position: 0, isPrimary: true }],
        deleted: false,
      },
      {
        id: "second-project",
        hostId: "local",
        name: "Second project",
        roots: [{ rootPath: secondWorkspace, position: 0, isPrimary: true }],
        deleted: false,
      },
    ],
  },
  broadcastService: { onMessage: emptyEvent },
  settingService: { get: async () => ({}) },
} as unknown as IServiceAccessor;
const platform = {
  openExternal: () => {
    throw new Error("External navigation forbidden");
  },
  showTaskNotification() {},
} as unknown as IPlatformService;
function SeedWorkspace() {
  const tabStore = useTabStoreApi();
  const seededRef = useRef(false);
  if (!seededRef.current) {
    seededRef.current = true;
    tabStore.getState().addTab("/isolated/automation-workspace");
  }
  return null;
}
function Harness() {
  const [output, setOutput] = useState<unknown>(null);
  return (
    <main className="min-h-screen bg-background p-6 text-foreground">
      <h1 className="text-ui-base">Automation model read QA</h1>
      <Button
        onClick={() => {
          phase = "error";
          releaseRead?.();
        }}
      >
        Reject delayed read
      </Button>
      <Button onClick={() => (phase = "ready")}>Resolve next read</Button>
      <Button
        onClick={() => {
          phase = "refresh-delayed";
          for (const listener of listeners)
            listener({ ...modelView, revision: 2, workspace: { workspacePath: firstWorkspace } });
        }}
      >
        Delay old workspace refresh
      </Button>
      <Button
        onClick={() => {
          phase = "ready";
          for (const release of delayedRefresh.splice(0)) release();
        }}
      >
        Release old workspace
      </Button>
      <Button
        onClick={() => {
          secondReady = true;
          for (const release of delayedSecond.splice(0)) release();
        }}
      >
        Release second workspace
      </Button>
      <Button onClick={() => setOutput({ writes, readAttempts })}>Inspect fixture</Button>
      <AutomationEditView
        editing={null}
        initialDraft={initialDraft}
        defaultWorkspacePath="/isolated/automation-workspace"
        saving={false}
        onSubmit={async (submission) => {
          writes++;
          setOutput({ submitted: true, writes, readAttempts, submission });
          return true;
        }}
        onBack={() =>
          setOutput((previous: unknown) => ({
            ...(previous && typeof previous === "object" ? previous : {}),
            returned: true,
            writes,
            readAttempts,
          }))
        }
      />
      <pre data-testid="result" className="whitespace-pre-wrap break-words">
        {JSON.stringify(output)}
      </pre>
    </main>
  );
}
const initialDraft = { title: "Isolated automation", cronExpr: "0 9 * * *", prompt: "" };
createRoot(document.getElementById("automation-root")!).render(
  <ServiceProvider services={services}>
    <PlatformProvider platform={platform}>
      <TabStoreProvider>
        <SeedWorkspace />
        <CodezIntlProvider initialLocale="en-US">
          <TooltipProvider>
            <Harness />
          </TooltipProvider>
        </CodezIntlProvider>
      </TabStoreProvider>
    </PlatformProvider>
  </ServiceProvider>,
);
