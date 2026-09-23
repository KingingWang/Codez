import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactNode } from "react";
import type { IPlatformService } from "@codez/shared";
import { CodezIntlProvider } from "@/i18n/IntlProvider.js";
import { PlatformProvider } from "@/hooks/usePlatform.js";
import type { CodexSettingsController } from "@/hooks/useCodexSettings.js";
import { CodexAccountPanel } from "./CodexAccountPanel.js";
import { CodexConfigPanel } from "./CodexConfigPanel.js";
import { CodexSkillsPanel, CodexMcpPanel, CodexPluginsPanel } from "./CodexResourcesPanel.js";
import { codexVisibleConfig } from "./CodexSettingsParts.js";

const controller: CodexSettingsController = {
  formKey: "00000000-0000-4000-8000-000000000000",
  snapshot: {},
  loading: false,
  busy: false,
  enabled: true,
  error: undefined,
  request: async () => {
    throw new Error("Rendering must not issue a request");
  },
  refresh: async () => {},
  run: async () => false,
};
// Only the platform method used by this panel is available in the rendering fixture.
const platform = { openExternal: () => {} } as unknown as IPlatformService;
function render(children: ReactNode, locale: "en-US" | "zh-CN" = "en-US") {
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
