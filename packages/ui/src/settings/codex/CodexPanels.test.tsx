import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactNode } from "react";
import type { IPlatformService } from "@codez/shared";
import type { ICodezAgentService, IServiceAccessor } from "@codez/services";
import { CodezIntlProvider } from "@/i18n/IntlProvider.js";
import { PlatformProvider } from "@/hooks/usePlatform.js";
import type { CodexSettingsController } from "@/hooks/useCodexSettings.js";
import { CodexAccountPanel } from "./CodexAccountPanel.js";
import { CodexConfigPanel } from "./CodexConfigPanel.js";
import { CodexSkillsPanel, CodexMcpPanel, CodexPluginsPanel } from "./CodexResourcesPanel.js";
import { CodexHistoryPanel, HistoryRunRow } from "./CodexHistoryPanel.js";
import { codexVisibleConfig } from "./CodexSettingsParts.js";
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
function render(children: ReactNode, locale: "en-US" | "zh-CN" = "en-US"): string {
  return renderToStaticMarkup(
    <CodezIntlProvider initialLocale={locale}>
      <PlatformProvider platform={platform}>{children}</PlatformProvider>
    </CodezIntlProvider>,
  );
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
