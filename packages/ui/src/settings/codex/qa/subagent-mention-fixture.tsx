// Browser-only regression fixture: real ChatPromptEditor/Lexical/native role hook.
// The service object is the isolated Host authority; no user files or credentials are touched.
import { StrictMode, useState } from "react";
import { createRoot } from "react-dom/client";
import type { IServiceAccessor } from "@codez/services";
import type { CodezAgentRoleSummary, IPlatformService } from "@codez/shared";
import { ServiceProvider } from "@/hooks/useServices.js";
import { PlatformProvider } from "@/hooks/usePlatform.js";
import { TabStoreProvider } from "@/store/TabStoreProvider.js";
import {
  bindRemoteWorkspaceIdentity,
  registerRemoteWorkspaceSession,
} from "@/store/remoteWorkspaceSessionStore.js";
import { CodezIntlProvider } from "@/i18n/IntlProvider.js";
import { TooltipProvider } from "@/components/ui/tooltip.js";
import { Button } from "@/components/ui/button.js";
import { ChatPromptEditor } from "@/prompt-editor/ChatPromptEditor.js";
import { platform } from "./harnessConfig.js";
import "@/styles.css";

const WORKSPACE_PATH = "/isolated/codex-subagent-mentions";
const WORKSPACE_IDENTITY = "identity-csm01";

let roles: CodezAgentRoleSummary[] = [
  {
    scope: "user",
    name: "user-one",
    description: "User role one",
    developerInstructions: "User one private instructions",
    fileName: "user-one.toml",
  },
  {
    scope: "user",
    name: "user-two",
    description: "User role two",
    developerInstructions: "User two private instructions",
    fileName: "user-two.toml",
  },
  {
    scope: "user",
    name: "shared-name",
    description: "User duplicate",
    developerInstructions: "User duplicate private instructions",
    fileName: "shared-name.toml",
  },
  {
    scope: "project",
    name: "project-reviewer",
    description: "Reviews isolated project facts",
    developerInstructions: "Project reviewer private instructions",
    fileName: "project-reviewer.toml",
  },
  {
    scope: "project",
    name: "Project-Reviewer",
    description: "Case-sensitive sibling",
    developerInstructions: "Case-sensitive sibling instructions",
    fileName: "Project-Reviewer.toml",
  },
  {
    scope: "project",
    name: "shared-name",
    description: "Project duplicate wins",
    developerInstructions: "Project duplicate private instructions",
    fileName: "shared-name.toml",
  },
  {
    scope: "project",
    name: "invalid-blank-instructions",
    description: "Must be filtered",
    developerInstructions: " ",
    fileName: "invalid-blank-instructions.toml",
  },
  {
    scope: "project",
    name: "invalid-blank-description",
    description: "",
    developerInstructions: "Valid but explicitly blank description",
    fileName: "invalid-blank-description.toml",
  },
];

const fixtureState = {
  roleReads: 0,
  legacyReads: 0,
  listAgentRolesParams: [] as unknown[],
};

const emptyEvent = () => ({ dispose() {} });

const services = {
  clientConfigService: {
    async getSnapshot() {
      return { pluginStoreOrder: null };
    },
  },
  codezAgentService: {
    onAgentRuntimeRestarted: emptyEvent,
    async getSkillReferenceCatalog() {
      return { skills: [], authority: "workspace" };
    },
    async listAgentRoles(params: { workspacePath: string; workspaceIdentity?: string }) {
      fixtureState.roleReads += 1;
      fixtureState.listAgentRolesParams.push(structuredClone(params));
      return { roles: structuredClone(roles), diagnostics: [] };
    },
  },
  subagentsService: {
    async list() {
      fixtureState.legacyReads += 1;
      throw new Error("Legacy subagentsService.list is forbidden for native Codex");
    },
  },
} as unknown as IServiceAccessor;

registerRemoteWorkspaceSession({
  sessionId: "fixture-remote-session",
  services,
});
bindRemoteWorkspaceIdentity(WORKSPACE_IDENTITY, "fixture-remote-session");

function SubagentMentionFixture() {
  const [submitted, setSubmitted] = useState<unknown>(null);
  const [inspection, setInspection] = useState<unknown>(null);

  return (
    <main className="min-h-screen bg-background p-6 text-foreground">
      <h1 className="text-ui-lg font-semibold">Codex subagent mentions QA</h1>
      <ChatPromptEditor
        nativeCodex
        workspacePath={WORKSPACE_PATH}
        workspaceIdentity={WORKSPACE_IDENTITY}
        taskId={null}
        placeholder="Type / to search Codex roles"
        submitLabel="Send fixture message"
        showSlashButton
        inputTestId="codex-subagent-input"
        onSubmit={(text) => {
          setSubmitted({ text });
          return false;
        }}
      />
      <div className="mt-4 flex flex-wrap gap-2">
        <Button
          onClick={() => {
            roles = roles.map((role) =>
              role.name === "project-reviewer"
                ? { ...role, description: "Refreshed project role description" }
                : role,
            );
          }}
        >
          Change project role
        </Button>
        <Button
          onClick={() =>
            setInspection({
              roleReads: fixtureState.roleReads,
              legacyReads: fixtureState.legacyReads,
              listAgentRolesParams: fixtureState.listAgentRolesParams,
            })
          }
        >
          Inspect fixture
        </Button>
      </div>
      <pre data-testid="fixture-submitted" className="mt-4 whitespace-pre-wrap break-words">
        {JSON.stringify(submitted)}
      </pre>
      <pre data-testid="fixture-inspection" className="mt-2 whitespace-pre-wrap break-words">
        {JSON.stringify(inspection)}
      </pre>
    </main>
  );
}

createRoot(document.getElementById("subagent-mentions-root")!).render(
  <StrictMode>
    <ServiceProvider services={services}>
      <PlatformProvider platform={platform as unknown as IPlatformService}>
        <TabStoreProvider>
          <CodezIntlProvider initialLocale="en-US">
            <TooltipProvider>
              <SubagentMentionFixture />
            </TooltipProvider>
          </CodezIntlProvider>
        </TabStoreProvider>
      </PlatformProvider>
    </ServiceProvider>
  </StrictMode>,
);
