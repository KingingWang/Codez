// Browser-only QA fixture: real AutomationEditView, injected service states, no production hooks.
import { useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import type { IServiceAccessor } from "@codez/services";
import type { IPlatformService } from "@codez/shared";
import type { ModelSelectionView } from "@codez/provider";
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
const services = {
  modelSelectionService: {
    getView: () => {
      readAttempts++;
      if (phase === "delayed")
        return new Promise((_resolve, reject) => {
          releaseRead = () => {
            releaseRead = null;
            reject(new Error("Fixture model read failed"));
          };
        });
      if (phase === "error") return Promise.reject(new Error("Fixture model read failed"));
      return Promise.resolve(modelView);
    },
    onDidChange: emptyEvent,
  },
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
      <Button onClick={() => setOutput({ writes, readAttempts })}>Inspect fixture</Button>
      <AutomationEditView
        editing={null}
        initialDraft={initialDraft}
        defaultWorkspacePath="/isolated/automation-workspace"
        saving={false}
        onSubmit={async () => {
          writes++;
          setOutput({ submitted: true, writes, readAttempts });
          return true;
        }}
        onBack={() => setOutput({ submitted: false, writes, readAttempts })}
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
