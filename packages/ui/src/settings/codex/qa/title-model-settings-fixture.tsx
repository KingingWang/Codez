// Browser-only fixture: actual Codex settings controls, isolated model catalog and settings.
import { useState } from "react";
import { createRoot } from "react-dom/client";
import { appSettingsSchema, type AppSettings, type CodexModel } from "@codez/shared";
import type { IServiceAccessor } from "@codez/services";
import type { CodexSettingsController } from "@/hooks/useCodexSettings.js";
import { CodezIntlProvider } from "@/i18n/IntlProvider.js";
import { TooltipProvider } from "@/components/ui/tooltip.js";
import { Button } from "@/components/ui/button.js";
import { CodexConfigPanel } from "@/settings/codex/CodexConfigPanel.js";
import { CodexTitleModelSettings } from "@/settings/codex/CodexTitleModelSettings.js";
import type { CodexModelCatalog } from "@/settings/codex/codexModelCatalog.js";
import "@/styles.css";

const models: CodexModel[] = [
  {
    id: "luna",
    model: "gpt-5.6-luna",
    displayName: "GPT-5.6 Luna",
    description: "Lightweight title model",
    hidden: false,
    isDefault: false,
    defaultReasoningEffort: "low",
    supportedReasoningEfforts: [{ reasoningEffort: "low", description: "Low" }],
  },
  {
    id: "main",
    model: "gpt-5.6-codex",
    displayName: "GPT-5.6 Codex",
    description: "Main coding model",
    hidden: false,
    isDefault: true,
    defaultReasoningEffort: "medium",
    supportedReasoningEfforts: [{ reasoningEffort: "medium", description: "Medium" }],
  },
  {
    id: "nano",
    model: "acme-nano",
    displayName: "Acme Nano",
    description: "Fixture custom-provider model",
    hidden: false,
    isDefault: false,
    defaultReasoningEffort: "low",
    supportedReasoningEfforts: [{ reasoningEffort: "low", description: "Low" }],
  },
];
const catalog: CodexModelCatalog = {
  providerId: "openai",
  models,
  groups: [
    { providerId: "openai", providerName: "OpenAI", models: models.slice(0, 2) },
    { providerId: "acme", providerName: "Acme", models: models.slice(2) },
  ],
  preferredSelection: { providerId: "openai", modelId: "gpt-5.6-codex" },
};
const controller: CodexSettingsController = {
  formKey: "00000000-0000-4000-8000-000000000001",
  enabled: true,
  busy: false,
  loading: false,
  remote: false,
  error: undefined,
  services: {} as IServiceAccessor,
  snapshot: {
    models: { data: { data: models, nextCursor: null } },
    config: {
      data: {
        config: {
          model: "gpt-5.6-codex",
          model_provider: "openai",
          model_reasoning_effort: "medium",
          approval_policy: "on-request",
          sandbox_mode: "workspace-write",
        },
        origins: {},
        layers: [
          {
            name: { type: "user", file: "/isolated/config.toml" },
            version: "fixture-1",
            config: {},
          },
        ],
      },
    },
    requirements: {
      data: {
        requirements: {
          allowedApprovalPolicies: ["on-request", "never"],
          allowedSandboxModes: ["read-only", "workspace-write"],
        },
      },
    },
  },
  request: async () => {
    throw new Error("Isolated fixture does not write native configuration");
  },
  refresh: async () => {},
  run: async () => false,
};

function Harness() {
  const [settings, setSettings] = useState<AppSettings>(() => appSettingsSchema.parse({}));
  const [identity, setIdentity] = useState("remote:A");
  const [writes, setWrites] = useState(0);
  const update = async (patch: Partial<AppSettings>) => {
    setWrites((count) => count + 1);
    setSettings((previous) => appSettingsSchema.parse({ ...previous, ...patch }));
  };
  return (
    <main className="min-h-screen bg-background p-4 text-foreground sm:p-8">
      <div className="mx-auto max-w-4xl space-y-4">
        <header className="space-y-2">
          <p className="text-ui-sm text-foreground-subtle">设置 / Codex</p>
          <h1 className="text-ui-lg font-medium">Codex</h1>
          <p className="text-ui-sm text-foreground-subtle">
            当前工作区的 Codex 原生账号与生效设置。
          </p>
        </header>
        <nav aria-label="Codex settings" className="flex flex-wrap gap-1">
          <Button variant="ghost" size="sm">
            账号
          </Button>
          <Button variant="secondary" size="sm" aria-current="page">
            模型与权限
          </Button>
          <Button variant="ghost" size="sm">
            配置
          </Button>
          <Button variant="ghost" size="sm">
            MCP 服务器
          </Button>
        </nav>
        <p className="text-ui-sm text-foreground-subtle">工作区：{identity} · /isolated/project</p>
        <CodexConfigPanel controller={controller} />
        <CodexTitleModelSettings
          key={identity}
          settings={settings}
          catalog={catalog}
          workspacePath="/isolated/project"
          workspaceIdentity={identity}
          update={update}
        />
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" size="sm" onClick={() => setIdentity("remote:A")}>
            工作区 A
          </Button>
          <Button variant="outline" size="sm" onClick={() => setIdentity("remote:B")}>
            工作区 B
          </Button>
        </div>
        <output data-testid="title-settings-state" className="sr-only">
          {JSON.stringify({ settings, identity, writes })}
        </output>
      </div>
    </main>
  );
}

createRoot(document.getElementById("title-settings-root")!).render(
  <CodezIntlProvider initialLocale="zh-CN">
    <TooltipProvider>
      <Harness />
    </TooltipProvider>
  </CodezIntlProvider>,
);
