import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactNode } from "react";
import type { IPlatformService } from "@codez/shared";
import type { ICodezAgentService, IServiceAccessor } from "@codez/services";
import { CodezIntlProvider } from "@/i18n/IntlProvider.js";
import { PlatformProvider } from "@/hooks/usePlatform.js";
import { ServiceProvider } from "@/hooks/useServices.js";
import { TabStoreProvider } from "@/store/TabStoreProvider.js";
import { TooltipProvider } from "@/components/ui/tooltip.js";
import type { CodexSettingsController } from "@/hooks/useCodexSettings.js";
import { CodexAccountPanel } from "./CodexAccountPanel.js";
import { CodexConfigPanel } from "./CodexConfigPanel.js";
import { CodexTitleModelSettings } from "./CodexTitleModelSettings.js";
import { appSettingsSchema, codexModelSchema } from "@codez/shared";
import { CodexHooksPanel } from "./CodexHooksPanel.js";
import { CodexMcpPanel } from "./CodexMcpPanel.js";
import { CodexSkillsPanel, CodexPluginsPanel } from "./CodexResourcesPanel.js";
import { CodexHistoryPanel, HistoryRunRow } from "./CodexHistoryPanel.js";
import { CodexMemoryPanel } from "./CodexMemoryPanel.js";
import { CodexProvidersPanel } from "./CodexProvidersPanel.js";
import { CodexSettingsSection } from "./CodexSettingsSection.js";
import { codexVisibleConfig } from "./CodexSettingsParts.js";
import { formatCodexTemplate, useCodexMessages } from "./messages.js";
import { codexCapabilityGate, projectCodexCapabilities } from "@/capabilities/codexCapabilities.js";

const controller: CodexSettingsController = {
  formKey: "00000000-0000-4000-8000-000000000000",
  snapshot: {},
  loading: false,
  busy: false,
  enabled: true,
  error: undefined,
  services: {} as IServiceAccessor,
  remote: false,
  request: async () => {
    throw new Error("Rendering must not issue a request");
  },
  refresh: async () => {},
  run: async () => false,
};
// Only the platform method used by this panel is available in the rendering fixture.
const descriptor = {
  runtimeInstalled: true,
  serviceRunning: true,
  executable: "/fixture/electron",
  bridgePath: "/fixture/bridge.cjs",
  endpoint: "/tmp/codez-native-browser-cua-test.sock",
  tokenFile: "/user/codez-native-browser-cua-test.token",
  browserAvailable: true,
  cuaAvailable: false,
  cuaReason: "codez-cua.runtime_unavailable",
};
const platform = {
  openExternal: () => {},
  executeDesktopCommand: async () => descriptor,
} as unknown as IPlatformService;
const mockServices = {
  settingService: {
    get: async () => ({}),
    update: async () => {},
  },
  codezAgentService: {
    onAgentRuntimeRestarted: () => ({ dispose() {} }),
    readCodexCatalog: async () => ({ path: null, models: [] }),
    readCodexCatalogModels: async () => ({ path: null, models: [] }),
    listAgentRoles: async () => ({ roles: [], diagnostics: [] }),
    codexRequest: async () => ({}),
  },
} as unknown as IServiceAccessor;
function render(children: ReactNode, locale: "en-US" | "zh-CN" = "en-US"): string {
  return renderToStaticMarkup(
    <ServiceProvider services={mockServices}>
      <TabStoreProvider>
        <CodezIntlProvider initialLocale={locale}>
          <PlatformProvider platform={platform}>
            <TooltipProvider>{children}</TooltipProvider>
          </PlatformProvider>
        </CodezIntlProvider>
      </TabStoreProvider>
    </ServiceProvider>,
  );
}

function CodexMessageProbe({ name }: { name: keyof ReturnType<typeof useCodexMessages> }) {
  const text = useCodexMessages();
  return <output data-testid={`codex-message-${name}`}>{text[name]}</output>;
}

test("account rendering distinguishes unauthenticated/no-auth and existing native account", () => {
  const unsigned = render(
    <CodexAccountPanel
      controller={{
        ...controller,
        snapshot: { account: { data: { account: null, requiresOpenaiAuth: false } } },
      }}
    />,
  );
  assert.match(unsigned, /Not signed in/);
  assert.match(unsigned, /does not require OpenAI sign-in/);
  assert.match(unsigned, /type="password"/);
  const signed = render(
    <CodexAccountPanel
      controller={{
        ...controller,
        snapshot: {
          account: {
            data: {
              account: { type: "chatgpt", email: "fixture@example.invalid", planType: "test" },
              requiresOpenaiAuth: true,
            },
          },
        },
      }}
    />,
  );
  assert.match(signed, /fixture@example.invalid/);
  assert.match(signed, /Sign out/);
});

test("missing configuration version visibly disables writes and errors remain actionable", () => {
  const html = render(
    <CodexConfigPanel
      advanced
      controller={{ ...controller, snapshot: { config: { error: "Native runtime unavailable" } } }}
    />,
  );
  assert.match(html, /Native runtime unavailable/);
  assert.match(html, /No writable user configuration layer/);
  assert.match(html, /disabled=""[^>]*>Write value/);
  assert.match(html, /disabled=""[^>]*>Write batch/);
});

test("empty capability table disables the effort picker but keeps model save writable", () => {
  // 空能力表 = 模型没有档位维度（spec：CodexSettings.spec.md）：档位选择禁用，
  // 保存仍可只写模型，不能因为档位校验把保存按钮永久禁用。
  const plain = codexModelSchema.parse({
    id: "plain-id",
    model: "plain-model",
    displayName: "Plain",
    description: "No reasoning dimension",
    hidden: false,
    isDefault: true,
    defaultReasoningEffort: "",
    supportedReasoningEfforts: [],
  });
  const html = render(
    <CodexConfigPanel
      controller={{
        ...controller,
        snapshot: {
          config: {
            data: {
              config: { model: "plain-model" },
              origins: {},
              layers: [
                { name: { type: "user", file: "/fixture/config.toml" }, version: "v1", config: {} },
              ],
            },
          },
          requirements: {
            data: { requirements: { allowedApprovalPolicies: null, allowedSandboxModes: null } },
          },
          models: { data: { data: [plain], nextCursor: null } },
        },
      }}
    />,
  );
  assert.match(html, /<button[^>]*disabled=""[^>]*aria-label="Reasoning effort"/);
  assert.match(html, /<button(?![^>]*disabled="")[^>]*>Save<\/button>/);
});

test("title model controls distinguish global default and inherited workspace value", () => {
  const catalog = {
    providerId: "openai",
    models: [],
    groups: [
      {
        providerId: "openai",
        providerName: "OpenAI",
        models: [
          {
            id: "title-model",
            model: "gpt-5.6-luna",
            displayName: "Luna",
            description: "Title model",
            hidden: false,
            isDefault: false,
            defaultReasoningEffort: "low",
            supportedReasoningEfforts: [],
          },
        ],
      },
    ],
    preferredSelection: null,
  };
  const html = render(
    <CodexTitleModelSettings
      settings={appSettingsSchema.parse({})}
      catalog={catalog}
      workspacePath="/project"
      update={async () => {}}
    />,
  );
  assert.match(html, /Global title model/);
  assert.match(html, /This workspace/);
  assert.match(html, /Inherit global default/);
  assert.match(html, /Luna/);
});

test("invalid JSON drafts report the syntax detail in the active locale", () => {
  const en = render(<CodexMessageProbe name="invalidJsonSyntax" />);
  const zh = render(<CodexMessageProbe name="invalidJsonSyntax" />, "zh-CN");
  // 两个语言包都要保留 {message} 占位符，否则用户看不到 JSON 语法错误的具体上下文。
  assert.match(en, /Invalid JSON: \{message\}/);
  assert.match(zh, /JSON 无效：\{message\}/);
  assert.equal(
    formatCodexTemplate("Invalid JSON: {message}", { message: "Unexpected token }" }),
    "Invalid JSON: Unexpected token }",
  );
  // 单次扫描：值里的占位符不被二次展开，未知占位符原样保留，替换语法按字面量输出。
  assert.equal(formatCodexTemplate("{a}-{b}", { a: "{b}", b: "X" }), "{b}-X");
  assert.equal(formatCodexTemplate("{a}-{unknown}", { a: "1" }), "1-{unknown}");
  assert.equal(formatCodexTemplate("{message}", { message: "$&" }), "$&");
});

test("skills and MCP discovery errors are not silently rendered as empty inventories", () => {
  const skills = render(
    <CodexSkillsPanel
      controller={{
        ...controller,
        snapshot: {
          skills: {
            data: {
              data: [
                {
                  cwd: "/fixture",
                  skills: [],
                  errors: [{ path: "/fixture/SKILL.md", message: "Invalid skill metadata" }],
                },
              ],
            },
          },
        },
      }}
    />,
  );
  assert.match(skills, /Invalid skill metadata/);
  const mcp = render(
    <CodexMcpPanel
      controller={{
        ...controller,
        snapshot: {
          mcp: {
            data: {
              data: [
                {
                  name: "fixture-mcp",
                  runtimeStatus: "failed",
                  authStatus: "notLoggedIn",
                  tools: {},
                  toolsError: "Discovery failed",
                },
              ],
              nextCursor: null,
            },
          },
        },
      }}
    />,
  );
  assert.match(mcp, /Discovery failed/);
  assert.match(mcp, /failed.*notLoggedIn/);
});

test("plugin policy/consent restrictions disable install with explanation", () => {
  const html = render(
    <CodexPluginsPanel
      controller={{
        ...controller,
        snapshot: {
          plugins: {
            data: {
              marketplaces: [
                {
                  name: "fixture",
                  path: null,
                  plugins: [
                    {
                      id: "fixture",
                      name: "fixture-plugin",
                      installed: false,
                      enabled: false,
                      availability: "AVAILABLE",
                      installPolicy: "AVAILABLE",
                      mustShowInstallationInterstitial: true,
                    },
                  ],
                },
              ],
              marketplaceLoadErrors: [],
              featuredPluginIds: [],
            },
          },
        },
      }}
    />,
  );
  assert.match(html, /Native consent is required/);
  assert.match(html, /disabled=""[^>]*>Install/);
});

test("Codex skill and plugin controls name their native targets without changing visible labels", () => {
  const skills = render(
    <CodexSkillsPanel
      controller={{
        ...controller,
        snapshot: {
          skills: {
            data: {
              data: [
                {
                  cwd: "/fixture",
                  errors: [],
                  skills: [
                    {
                      name: "imagegen",
                      description: "",
                      path: "/fixture/system/imagegen/SKILL.md",
                      scope: "system",
                      enabled: true,
                      pluginId: null,
                    },
                    {
                      name: "imagegen",
                      description: "",
                      path: "/fixture/user/imagegen/SKILL.md",
                      scope: "user",
                      enabled: true,
                      pluginId: null,
                    },
                  ],
                },
              ],
            },
          },
        },
      }}
    />,
  );
  assert.match(
    skills,
    /aria-label="Disable imagegen \(system: \/fixture\/system\/imagegen\/SKILL\.md\)"/,
  );
  assert.match(
    skills,
    /aria-label="Disable imagegen \(user: \/fixture\/user\/imagegen\/SKILL\.md\)"/,
  );
  const plugin = {
    id: "shared-plugin",
    name: "github",
    installed: false,
    enabled: false,
    availability: "AVAILABLE" as const,
    installPolicy: "AVAILABLE" as const,
    mustShowInstallationInterstitial: false,
  };
  const marketplaces = ["market-one", "market-two"].map((name) => ({
    name,
    path: null,
    plugins: [plugin],
  }));
  const plugins = render(
    <CodexPluginsPanel
      controller={{
        ...controller,
        snapshot: {
          plugins: {
            data: { marketplaces, marketplaceLoadErrors: [], featuredPluginIds: [] },
          },
        },
      }}
    />,
  );
  for (const marketplace of marketplaces) {
    assert.ok(plugins.includes(`aria-label="Update marketplace ${marketplace.name}"`));
    assert.ok(plugins.includes(`aria-label="Remove ${marketplace.name}"`));
    assert.ok(plugins.includes(`aria-label="Install github (${marketplace.name}, shared-plugin)"`));
  }
  const zh = render(
    <CodexPluginsPanel
      controller={{
        ...controller,
        snapshot: {
          plugins: {
            data: { marketplaces, marketplaceLoadErrors: [], featuredPluginIds: [] },
          },
        },
      }}
    />,
    "zh-CN",
  );
  assert.ok(zh.includes('aria-label="安装 github (market-one, shared-plugin)"'));
});

test("Codex copy follows the application locale and configuration presentation excludes secrets", () => {
  const html = render(<CodexSkillsPanel controller={controller} />, "zh-CN");
  assert.match(html, /技能/);
  assert.deepEqual(
    codexVisibleConfig({
      model: "fixture",
      api_key: "secret",
      developer_instructions: "secret instructions",
      mcp_servers: { fixture: { env: { TOKEN: "secret" } } },
    }),
    { model: "fixture" },
  );
});

test("native Browser/CUA card renders the global toggle and reflects the disabled state", () => {
  const enabled = render(
    <CodexMcpPanel
      controller={controller}
      remote={false}
      nativeBrowserCuaCapability="degraded"
      nativeBrowserControlEnabled={true}
      onNativeBrowserControlEnabledChange={() => {}}
    />,
  );
  assert.match(enabled, /Allow agents to control the built-in browser/);
  assert.match(enabled, /role="switch"[^>]*aria-checked="true"/);

  const disabledHtml = render(
    <CodexMcpPanel
      controller={controller}
      remote={false}
      nativeBrowserCuaCapability="degraded"
      nativeBrowserControlEnabled={false}
      onNativeBrowserControlEnabledChange={() => {}}
    />,
  );
  assert.match(disabledHtml, /role="switch"[^>]*aria-checked="false"/);
  assert.match(disabledHtml, /Browser control is off/);

  // 未注入回调（测试/非设置上下文）不渲染开关。
  const withoutToggle = render(
    <CodexMcpPanel controller={controller} remote={false} nativeBrowserCuaCapability="degraded" />,
  );
  assert.doesNotMatch(withoutToggle, /Allow agents to control the built-in browser/);
});

test("native Browser/CUA section gates unsupported capability and reports degraded Browser-only state", () => {
  const unsupported = render(
    <CodexMcpPanel
      controller={controller}
      remote={false}
      nativeBrowserCuaCapability="unsupported"
    />,
  );
  assert.match(unsupported, /Native Desktop browser is unavailable on this Host/);
  assert.doesNotMatch(unsupported, /<button[^>]*>Remove legacy global registration<\/button>/);
  const remote = render(
    <CodexMcpPanel controller={controller} remote nativeBrowserCuaCapability="degraded" />,
  );
  assert.doesNotMatch(remote, /<button[^>]*>Remove legacy global registration<\/button>/);
  const supported = render(
    <CodexMcpPanel
      controller={controller}
      nativeBrowserCuaCapability="degraded"
      descriptorOverride={descriptor}
    />,
  );
  assert.match(supported, /Native Desktop browser · Browser-only/);
  assert.match(supported, /Computer Use is unavailable/);
  assert.match(supported, /Active for this Desktop window/);
  assert.doesNotMatch(supported, /Configure native server|Install to Codex/);
  assert.doesNotMatch(supported, /<button[^>]*>Remove legacy global registration<\/button>/);
});

test("native Browser/CUA cleanup is explicit and customized legacy entries remain visible", () => {
  const exactConfig = {
    config: {
      mcp_servers: {
        "other-mcp": { command: "/fixture/other" },
        "codez-desktop-browser-cua": {
          command: descriptor.executable,
          args: [descriptor.bridgePath, "native-browser-cua-mcp"],
          env: {
            ELECTRON_RUN_AS_NODE: "1",
            CODEZ_NATIVE_BROWSER_CUA_ENDPOINT: descriptor.endpoint,
            CODEZ_NATIVE_BROWSER_CUA_TOKEN_FILE: descriptor.tokenFile,
          },
        },
      },
    },
    origins: {},
    layers: [
      {
        name: { type: "user", file: "/fixture/config.toml" },
        version: "v1",
        config: {
          mcp_servers: {
            "codez-desktop-browser-cua": {
              command: descriptor.executable,
              args: [descriptor.bridgePath, "native-browser-cua-mcp"],
              env: {
                ELECTRON_RUN_AS_NODE: "1",
                CODEZ_NATIVE_BROWSER_CUA_ENDPOINT: descriptor.endpoint,
                CODEZ_NATIVE_BROWSER_CUA_TOKEN_FILE: descriptor.tokenFile,
              },
            },
          },
        },
      },
    ],
  };
  const exact = render(
    <CodexMcpPanel
      controller={{ ...controller, snapshot: { config: { data: exactConfig } } }}
      nativeBrowserCuaCapability="degraded"
      descriptorOverride={descriptor}
    />,
  );
  assert.match(exact, /Remove legacy global registration/);
  const customized = render(
    <CodexMcpPanel
      controller={{
        ...controller,
        snapshot: {
          config: {
            data: {
              ...exactConfig,
              config: {
                mcp_servers: {
                  ...exactConfig.config.mcp_servers,
                  "codez-desktop-browser-cua": {
                    ...exactConfig.config.mcp_servers["codez-desktop-browser-cua"],
                    customKey: "user-edit",
                  },
                },
              },
              layers: [
                {
                  ...exactConfig.layers[0]!,
                  config: {
                    mcp_servers: {
                      "codez-desktop-browser-cua": {
                        ...exactConfig.config.mcp_servers["codez-desktop-browser-cua"],
                        customKey: "user-edit",
                      },
                    },
                  },
                },
              ],
            },
          },
        },
      }}
      nativeBrowserCuaCapability="degraded"
      descriptorOverride={descriptor}
    />,
  );
  assert.match(customized, /still shared because it does not match/);
  assert.match(customized, /left unchanged/);
  assert.doesNotMatch(customized, /<button[^>]*>Remove legacy global registration<\/button>/);
});

test("native Browser/CUA card preserves Codex config read errors", () => {
  const html = render(
    <CodexMcpPanel
      controller={{
        ...controller,
        snapshot: { config: { error: "Codex config read failed" } },
      }}
      nativeBrowserCuaCapability="degraded"
      descriptorOverride={descriptor}
    />,
  );
  assert.match(html, /Active for this Desktop window/);
  assert.match(html, /Codex config read failed/);
  assert.doesNotMatch(html, /<button[^>]*>Remove legacy global registration<\/button>/);
});

test("native Browser/CUA card renders with a same-name entry before descriptor readiness", () => {
  const html = render(
    <CodexMcpPanel
      controller={{
        ...controller,
        snapshot: {
          config: {
            data: {
              config: {
                mcp_servers: { "codez-desktop-browser-cua": { command: "/fixture/custom" } },
              },
              origins: {},
              layers: [],
            },
          },
        },
      }}
      nativeBrowserCuaCapability="degraded"
    />,
  );
  assert.match(html, /Native Desktop browser/);
  assert.match(html, /may still be shared and was left unchanged/);
  assert.doesNotMatch(html, /<button[^>]*>Remove legacy global registration<\/button>/);
});

const historyRun = {
  runId: "codex-turn:native-thread:turn-1",
  threadId: "native-thread",
  turnId: "turn-1",
  status: "completed" as const,
  startedAtMs: 1_000,
  completedAtMs: 2_000,
  durationMs: 1_000,
  toolChain: [
    {
      kind: "command" as const,
      itemId: "item-1",
      label: "pnpm test",
      status: "completed" as const,
    },
    {
      kind: "fileChange" as const,
      itemId: "item-2",
      label: "src/index.ts",
      status: "completed" as const,
    },
  ],
  fileChangeSummary: { files: 1, additions: 2, deletions: 1, paths: ["src/index.ts"] },
  result: "Native final answer",
  artifacts: [{ kind: "fileChange" as const, path: "src/index.ts" }],
};

function historyService(overrides?: {
  capability?: string;
  result?: boolean;
}): Pick<
  import("@codez/services").ICodezAgentService,
  "helloConversationV4" | "codexHistoryRunsV4"
> {
  return {
    helloConversationV4: async () =>
      ({
        capabilities: {
          codex: { readOnlyWorkflowHistory: overrides?.capability ?? "supported" },
        },
      }) as Awaited<ReturnType<ICodezAgentService["helloConversationV4"]>>,
    codexHistoryRunsV4: async () => {
      if (overrides?.result === false) throw new Error("history read failed");
      return {
        runs: [historyRun],
        atSeq: 1,
        atRevision: 1,
        atLogEpoch: "epoch",
        source: "native-thread",
      };
    },
  };
}

function CodexHistoryRowFixture({ run }: { run: typeof historyRun }) {
  return (
    <ul>
      <HistoryRunRow run={run} />
    </ul>
  );
}

test("Codex thread history renders observed facts without inventing usage or DWF controls", () => {
  const html = render(<CodexHistoryRowFixture run={historyRun} />);
  assert.match(html, /Completed/);
  assert.match(html, /pnpm test → src\/index\.ts/);
  assert.match(html, /1 files · \+2 \/ -1/);
  assert.match(html, /Native final answer/);
  assert.match(html, /Per-turn usage unavailable/);
  assert.match(html, /Artifacts:\s*<\/span>src\/index\.ts/);
});

test("Codex thread history is read-only and fails closed without an active native thread", () => {
  const html = render(
    <CodexHistoryPanel agentService={historyService()} sessionId="" workspacePath="/workspace" />,
  );
  assert.match(html, /Codex thread history/);
  assert.match(html, /not a complete legacy workflow equivalent/);
  assert.match(html, /Open a native Codex thread/);
  assert.doesNotMatch(html, /<button[^>]*>(Start|Resume|Cancel)/i);
  const unsupported = projectCodexCapabilities({
    available: true,
    codex: { readOnlyWorkflowHistory: "unsupported" },
  }).readOnlyWorkflowHistory;
  assert.equal(codexCapabilityGate(unsupported).disabled, true);
});

test("providers panel renders provider facts without ever exposing the bearer token", () => {
  const markup = render(
    <CodexProvidersPanel
      controller={{
        ...controller,
        snapshot: {
          config: {
            data: {
              config: {
                model_provider: "ollama1",
                model: "kimi-k3",
                model_providers: {
                  ollama1: {
                    name: "Ollama One",
                    base_url: "http://127.0.0.1:39080/v1",
                    wire_api: "chat",
                    experimental_bearer_token: "sk-panel-secret",
                  },
                  "openai-my": { base_url: "http://127.0.0.1:39081/v1", wire_api: "responses" },
                  "claude-my": {
                    name: "Claude Custom",
                    base_url: "https://api.anthropic.com/v1",
                    wire_api: "anthropic",
                  },
                },
              },
              origins: {},
              layers: [
                {
                  name: { type: "user", file: "/fixture/config.toml", profile: null },
                  version: "v1",
                  config: {},
                  disabledReason: null,
                },
              ],
            },
          },
        },
      }}
      workspacePath="/fixture/workspace"
    />,
  );
  assert.match(markup, /Ollama One/);
  assert.match(markup, /openai-my/);
  assert.match(markup, /claude-my · anthropic/);
  assert.match(markup, /http:\/\/127\.0\.0\.1:39081\/v1/);
  assert.match(markup, /Set as default/);
  assert.match(markup, /Add provider/);
  assert.match(markup, /Catalog models/);
  const deleteButtons = markup.match(/<button[^>]*>Delete<\/button>/g) ?? [];
  assert.equal(deleteButtons.length, 3);
  assert.ok(
    deleteButtons.every((button) => button.includes('disabled=""')),
    "While the catalog is unread, even a non-default provider cannot be safely deleted",
  );
  // 安全不变量：config/read 返回的明文 token 绝不出现在任何渲染产物中。
  assert.equal(markup.includes("sk-panel-secret"), false);
  // 中文文案随 locale 切换。
  const zh = render(
    <CodexProvidersPanel
      controller={{ ...controller, snapshot: {} }}
      workspacePath="/fixture/workspace"
    />,
    "zh-CN",
  );
  assert.match(zh, /模型供应商/);
  assert.match(zh, /添加供应商/);
});

test("memory panel hides duplicate section heading in standalone SettingsPage mode and renders SettingsGroupCard rows", () => {
  const config = {
    config: {
      features: { memories: true },
      memories: { use_memories: true },
    },
    origins: {},
    layers: [
      {
        name: { type: "user" as const, file: "/fixture/config.toml", profile: null },
        version: "v1",
        config: {},
      },
    ],
  };
  const standaloneZh = render(
    <CodexMemoryPanel
      hideSectionTitle
      controller={{
        ...controller,
        snapshot: { config: { data: config } },
      }}
    />,
    "zh-CN",
  );
  // 外层 SettingsPage 已展示“记忆”大标题时，内部卡片不再重复渲染 <h3>记忆</h3>。
  assert.doesNotMatch(standaloneZh, /<h3[^>]*>记忆<\/h3>/);
  assert.match(standaloneZh, /启用记忆/);
  assert.match(standaloneZh, /<h3[^>]*>高级<\/h3>/);
  assert.match(standaloneZh, /1 - 128 · 留空恢复原生默认值。（默认：2）/);

  const standaloneEn = render(
    <CodexMemoryPanel
      hideSectionTitle
      controller={{
        ...controller,
        snapshot: { config: { data: config } },
      }}
    />,
    "en-US",
  );
  assert.doesNotMatch(standaloneEn, /<h3[^>]*>Memory<\/h3>/);
  assert.match(standaloneEn, /Enable memory/);
  assert.match(
    standaloneEn,
    /1 - 128 · Leave empty to restore the native default\. \(Default: 2\)/,
  );
});

test("embedded SettingsPage mode eliminates duplicate top navigation for standalone sections and shows segmented tabs for Codex", () => {
  const standaloneMemory = render(
    <CodexSettingsSection
      embeddedInSettingsPage
      initialPanel="memory"
      workspacePath="/fixture/workspace"
    />,
    "zh-CN",
  );
  // 独立分区模式不重复渲染顶部横向导航栏或 Codex 外壳标题。
  assert.doesNotMatch(standaloneMemory, /<nav[^>]*aria-label="Codex"/);
  assert.doesNotMatch(standaloneMemory, /role="tablist"/);
  assert.doesNotMatch(standaloneMemory, /<h2[^>]*>Codex<\/h2>/);

  const embeddedCodex = render(
    <CodexSettingsSection
      embeddedInSettingsPage
      initialPanel="account"
      workspacePath="/fixture/workspace"
    />,
    "zh-CN",
  );
  // Codex 入口仅渲染 4 个专属二级分段标签，不重复展示侧栏已有的记忆/插件/MCP/技能/子智能体。
  assert.match(embeddedCodex, /role="tablist"/);
  assert.match(embeddedCodex, /账户/);
  assert.match(embeddedCodex, /模型与权限/);
  assert.match(embeddedCodex, /配置/);
  assert.match(embeddedCodex, /线程历史/);
  assert.doesNotMatch(embeddedCodex, /role="tab"[^>]*>记忆<\/button>/);
  assert.doesNotMatch(embeddedCodex, /role="tab"[^>]*>插件与市场<\/button>/);
});

test("CodexHooksPanel renders hook groups, trust actions, and localized labels", () => {
  const html = render(
    <CodexHooksPanel
      hideSectionTitle
      workspacePath="/fixture/workspace"
      controller={{
        ...controller,
        snapshot: {
          config: {
            data: {
              config: { features: { hooks: true } },
              origins: {},
              layers: [],
            },
          },
          hooks: {
            data: {
              data: [
                {
                  cwd: "/fixture/workspace",
                  warnings: ["sample warning"],
                  errors: [],
                  hooks: [
                    {
                      key: "proj-hook",
                      eventName: "preToolUse",
                      matcher: "Bash",
                      timeoutSec: 60,
                      statusMessage: "checking tool",
                      sourcePath: "/fixture/workspace/.codex/hooks.json",
                      source: "project",
                      pluginId: null,
                      displayOrder: 0,
                      enabled: true,
                      isManaged: false,
                      currentHash: "sha256:1",
                      trustStatus: "untrusted",
                      handlerType: "command",
                      command: "./scripts/check.sh",
                    },
                  ],
                },
              ],
            },
          },
        },
      }}
    />,
    "zh-CN",
  );
  assert.match(html, /启用钩子/);
  assert.match(html, /项目钩子（\.codex\/hooks\.json）/);
  assert.match(html, /PreToolUse/);
  assert.match(html, /\.\/scripts\/check\.sh/);
  assert.match(html, /待信任/);
  assert.match(html, /信任全部待审核项（1）/);
  assert.match(html, /sample warning/);
});
