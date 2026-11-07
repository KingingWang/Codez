// 合成 Host 只提供事实；真实 Composer、Draft 与目录校验负责本次验收行为。
import { useEffect, useMemo, useState } from "react";
import type { IServiceAccessor } from "@/codex-settings-qa-ui/contract.js";
import type { ConversationSnapshot } from "@codez/shared/codez-protocol-v4";
import { ServiceProvider } from "@/hooks/useServices.js";
import {
  bindRemoteWorkspaceIdentity,
  registerRemoteWorkspaceSession,
  unregisterRemoteWorkspaceSession,
} from "@/store/remoteWorkspaceSessionStore.js";
import { buildServerRemoteWorkspaceIdentity } from "@codez/shared";
import { useCodexModelCatalog } from "@/hooks/useCodexModelCatalog.js";
import { ConversationComposer } from "@/v4/ConversationComposer.js";
import { useDraftConfigControl } from "@/v4/composer/useDraftConfigControl.js";
import { createComposerSubmissionConfig } from "@/v4/composer/composerSubmissionConfig.js";
import { ConversationQueuePanel } from "@/v4/ConversationQueuePanel.js";
import { queueStateSchema } from "@codez/shared/codez-protocol-v4";
import { Button } from "@/components/ui/button.js";
import { model } from "./harnessConfig.js";
import { MessageFeedbackFixture } from "./message-feedback-fixture.js";

const params = new URLSearchParams(location.search);
const mobile = params.get("surface") === "mobile";
const workspacePath = "/isolated/native-parity";
const config = { provider: "provider-a", model: "model-a", thought: "high", mode: "custom" };
const sessionId = "sess_00000000-0000-4000-8000-000000000001";
const identities = ["qa-host-a", "qa-host-b"].map((serverId) =>
  buildServerRemoteWorkspaceIdentity({ serverId, workspacePath }),
);

export function NativeComposerParityFixture({ services }: { services: IServiceAccessor }) {
  const [catalogFailure, setCatalogFailure] = useState(false);
  const [legacyCalls, setLegacyCalls] = useState(0);
  const [fixtureServices] = useState<IServiceAccessor>(() => ({
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
    modelSelectionService: {
      ...services.modelSelectionService,
      getView() {
        setLegacyCalls((count) => count + 1);
        throw new Error("Native Composer must not read legacy selection");
      },
      onDidChange() {
        setLegacyCalls((count) => count + 1);
        throw new Error("Native Composer must not subscribe legacy selection");
      },
    },
    codezAgentService: {
      ...services.codezAgentService,
      async readCodexCatalog() {
        return {
          path: "/isolated/catalog.json",
          models: [
            { slug: "model-a", provider: "provider-a" },
            { slug: "model-b", provider: "provider-b" },
          ],
        };
      },
      async codexRequest({ request }) {
        if (request.method === "config/read")
          return {
            config: {
              model_provider: "provider-a",
              model: "model-a",
              model_reasoning_effort: "high",
            },
            origins: {},
            layers: [],
          };
        if (request.method === "model/list")
          return { data: [model("model-a", true), model("model-b")], nextCursor: null };
        if (["skills/list", "plugin/list", "mcpServerStatus/list"].includes(request.method))
          return { data: [], marketplaces: [], nextCursor: null };
        throw new Error(`Forbidden parity fixture request: ${request.method}`);
      },
    },
  }));
  const activeServices = useMemo(
    () =>
      catalogFailure
        ? {
            ...fixtureServices,
            codezAgentService: {
              ...fixtureServices.codezAgentService,
              async codexRequest(params) {
                if (params.request.method === "model/list")
                  throw new Error("Parity catalog unavailable");
                return fixtureServices.codezAgentService.codexRequest(params);
              },
            },
          }
        : fixtureServices,
    [catalogFailure, fixtureServices],
  );
  useEffect(() => {
    identities.forEach((identity, index) => {
      const remoteSessionId = `qa-parity-attachment-${index}`;
      registerRemoteWorkspaceSession({
        sessionId: remoteSessionId,
        workspacePath,
        workspaceIdentity: identity,
        services: activeServices,
      });
      bindRemoteWorkspaceIdentity(identity, remoteSessionId);
    });
    return () =>
      identities.forEach((_, index) =>
        unregisterRemoteWorkspaceSession(`qa-parity-attachment-${index}`),
      );
  }, [activeServices]);
  return (
    <ServiceProvider
      services={activeServices}
      composerClientNamespace={`qa-native-parity-${mobile}`}
    >
      <ParityComposer services={activeServices} legacyCalls={legacyCalls} />
      <Button onClick={() => setCatalogFailure((value) => !value)}>Toggle catalog failure</Button>
      <MessageFeedbackFixture />
    </ServiceProvider>
  );
}

function ParityComposer({
  services,
  legacyCalls,
}: {
  services: IServiceAccessor;
  legacyCalls: number;
}) {
  const [phase, setPhase] = useState<"idle" | "running" | "prewarming" | "stopping">("idle");
  const [hostPending, setHostPending] = useState(false);
  const [identity, setIdentity] = useState(identities[0]!);
  const [commands, setCommands] = useState<unknown[]>([]);
  const read = useCodexModelCatalog({
    workspacePath,
    workspaceIdentity: identity,
    enabled: !hostPending,
  });
  const draft = useDraftConfigControl({
    workspacePath,
    workspaceIdentity: identity,
    sessionId,
    sessionConfig: config,
    modelSelectionService: services.modelSelectionService,
    codex: true,
    codexCatalog: read.catalog,
    agentStartupAllowed: false,
  });
  const freeze = () =>
    createComposerSubmissionConfig(draft.draftConfigRef.current, null, read.catalog, true);
  const submission = freeze();
  const snapshot = {
    sessionId,
    config,
    control: {
      phase: phase === "stopping" ? "idle" : phase,
      canStop: phase === "running",
      stopState: phase === "stopping" ? "stopping" : "none",
      activeWorks: [],
    },
    inputRouting: { mode: phase === "running" ? "queue" : "startNow" },
    rows: { totalCount: 1 },
    queue: queueStateSchema.parse({ items: [], autoDrain: false }),
  } as unknown as ConversationSnapshot;
  return (
    <main className="mx-auto max-w-3xl space-y-4 p-3">
      <div className="flex flex-wrap gap-2">
        {(["idle", "running", "prewarming", "stopping"] as const).map((value) => (
          <Button key={value} onClick={() => setPhase(value)}>
            {value}
          </Button>
        ))}
        <Button onClick={() => setHostPending((value) => !value)}>Toggle Host pending</Button>
        <Button
          onClick={() =>
            setIdentity((value) => (value === identities[0] ? identities[1]! : identities[0]!))
          }
        >
          Switch scope
        </Button>
        <Button
          onClick={() => {
            const frozen = freeze();
            if (frozen) setCommands((value) => [...value, { type: "editUserQuery", ...frozen }]);
          }}
        >
          Edit resend fixture
        </Button>
      </div>
      <ConversationComposer
        snapshot={snapshot}
        sessionId={sessionId}
        workspacePath={workspacePath}
        workspaceIdentity={identity}
        isWebRemoteControl={mobile}
        nativeCodexSession
        codexModelCatalog={read}
        draftConfig={draft.draftConfig}
        composerDraft={draft.composerDraft}
        composerDraftScopeToken={draft.composerDraftScopeToken}
        stageComposerContent={draft.stageComposerContent}
        captureComposerContentLifecycleCommit={draft.captureComposerContentLifecycleCommit}
        captureComposerSubmissionDraftTransaction={draft.captureComposerSubmissionDraftTransaction}
        updateComposerContent={draft.updateComposerContent}
        persistComposerContent={draft.persistComposerContent}
        replaceComposerDraft={draft.replaceComposerDraft}
        submissionReady={Boolean(submission) && !hostPending}
        createSubmissionFromComposer={freeze}
        disabled={hostPending}
        telemetryVisible={false}
        attachmentPut={async () => {
          throw new Error("No attachments in parity fixture");
        }}
        onStop={() => setPhase("stopping")}
        onSelectModel={(provider, model) => draft.handleDraftSelectModel(provider, model)}
        onSelectThought={draft.handleDraftSelectThought}
        onSwitchMode={(value) => draft.handleDraftSwitchMode(value as "custom")}
        onSendText={async (text, options) => {
          setCommands((value) => [...value, { type: "sendText", text, ...options?.submission }]);
          return "sent";
        }}
      />
      <ConversationQueuePanel
        nativeCodex
        queue={queueStateSchema.parse({
          autoDrain: false,
          pauseReason: "stopped",
          items: [
            {
              sourceCommandId: "qa-queued",
              clientId: "qa",
              queueItemId: "qa-queue-item",
              kind: "sendText",
              text: "E2E_NATIVE_PARITY queued",
              attachments: [],
              dispatch: { state: "queued" },
              delivery: { requested: "queue", admitted: "queue" },
              order: { admissionSeq: 1, queuePosition: 0 },
              steer: { state: "notRequested" },
              admittedAt: 1,
            },
          ],
        })}
        onDeleteItem={() => {}}
        onEditItem={() => {}}
        onResume={async () => {
          throw new Error("Native queue must not offer legacy resume");
        }}
      />
      <output data-testid="parity-draft">{JSON.stringify(draft.draftConfig)}</output>
      <output data-testid="parity-intent">
        {JSON.stringify(draft.composerDraft.modelSelection)}
      </output>
      <pre data-testid="parity-commands">{JSON.stringify(commands)}</pre>
      <output data-testid="parity-legacy">{legacyCalls}</output>
      <output data-testid="parity-status">{read.status}</output>
    </main>
  );
}
