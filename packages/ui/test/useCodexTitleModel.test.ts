// @vitest-environment jsdom
import { createElement, type ReactNode } from "react";
import { act, render, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { appSettingsSchema, type AppSettings, type CodexTitleModel } from "@codez/shared";
import type { IServiceAccessor } from "@codez/services";
import { TooltipProvider } from "@/components/ui/tooltip.js";
import { CodezIntlProvider } from "@/i18n/IntlProvider.js";
import { ServiceProvider } from "@/hooks/useServices.js";
import { useCodexTitleModel } from "@/hooks/useCodexTitleModel.js";
import { CodexSettingsSection } from "@/settings/codex/CodexSettingsSection.js";
import {
  registerBaseWorkspaceServices,
  registerRemoteWorkspaceSession,
  useRemoteWorkspaceSessionStore,
} from "@/store/remoteWorkspaceSessionStore.js";

const titleModelSettingsCapture = vi.hoisted(() => ({
  latest: null as {
    settings: AppSettings | null;
    workspacePath: string;
    workspaceIdentity?: string;
    update: (patch: Partial<AppSettings>) => Promise<void>;
  } | null,
}));

vi.mock("@/hooks/usePlatform.js", () => ({
  usePlatform: () => ({}),
}));

vi.mock("@/hooks/useCodexSettings.js", () => ({
  useCodexSettings: () => ({
    formKey: "00000000-0000-4000-8000-000000000000",
    snapshot: {},
    loading: false,
    busy: false,
    enabled: true,
    error: undefined,
    services: {} as IServiceAccessor,
    remote: true,
    request: vi.fn(async () => ({})),
    refresh: vi.fn(async () => {}),
    run: vi.fn(async () => false),
  }),
}));

vi.mock("@/hooks/useCodexModelCatalog.js", () => ({
  useCodexModelCatalog: () => ({
    status: "ready" as const,
    catalog: {
      providerId: "ollama2",
      models: [],
      groups: [],
      preferredSelection: null,
    },
    reload: vi.fn(),
    readCurrent: vi.fn(),
  }),
}));

vi.mock("@/settings/codex/useCodexNativeBrowserCua.js", () => ({
  useCodexNativeBrowserCuaCapability: () => "unsupported" as const,
}));

vi.mock("@/settings/codex/CodexAccountPanel.js", () => ({
  CodexAccountPanel: () => null,
}));

vi.mock("@/settings/codex/CodexConfigPanel.js", () => ({
  CodexConfigPanel: () => null,
}));

vi.mock("@/settings/codex/CodexTitleModelSettings.js", () => ({
  CodexTitleModelSettings: (props: {
    settings: AppSettings | null;
    workspacePath: string;
    workspaceIdentity?: string;
    update: (patch: Partial<AppSettings>) => Promise<void>;
  }) => {
    titleModelSettingsCapture.latest = props;
    return null;
  },
}));

function createMockHostServices(initial: Partial<AppSettings>): {
  services: IServiceAccessor;
  getMock: ReturnType<typeof vi.fn>;
  updateMock: ReturnType<typeof vi.fn>;
} {
  let state = appSettingsSchema.parse(initial);
  const getMock = vi.fn(async () => state);
  const updateMock = vi.fn(async (patch: Partial<AppSettings>) => {
    state = appSettingsSchema.parse({ ...state, ...patch });
  });
  const services = {
    settingService: {
      get: getMock,
      update: updateMock,
    },
    botsService: {
      syncAppRuntimePreferences: vi.fn(async () => {}),
    },
    broadcastService: {
      send: vi.fn(async () => {}),
    },
    codezAgentService: {
      syncAppRuntimePreferences: vi.fn(async () => {}),
    },
  } as unknown as IServiceAccessor;
  return { services, getMock, updateMock };
}

function resetRemoteWorkspaceStore() {
  useRemoteWorkspaceSessionStore.setState({
    baseServices: null,
    sessionsById: {},
    sessionIdByWorkspacePath: {},
    sessionIdByWorkspaceIdentity: {},
  });
}

describe("Codex session title preference authority across remote workspaces", () => {
  beforeEach(() => {
    resetRemoteWorkspaceStore();
    titleModelSettingsCapture.latest = null;
  });

  afterEach(() => {
    resetRemoteWorkspaceStore();
  });

  it("reads the controller's global default and remote workspaceIdentity override instead of the remote host's setting.json", async () => {
    const controllerGlobal: CodexTitleModel = {
      providerId: "ollama2",
      modelId: "deepseek-v4-flash",
    };
    const remoteOverrideB: CodexTitleModel = {
      providerId: "ollama1",
      modelId: "kimi-k3",
    };
    const controllerHost = createMockHostServices({
      codexTitleDefaultModel: controllerGlobal,
      codexTitleWorkspaceModels: {
        "remote:ssh:dev-b:/root/workspace/ai/Codez": remoteOverrideB,
      },
    });
    const remoteHost = createMockHostServices({
      codexTitleDefaultModel: {
        providerId: "openai",
        modelId: "gpt-5.6-luna",
      },
    });
    registerBaseWorkspaceServices(controllerHost.services);
    registerRemoteWorkspaceSession({
      sessionId: "remote-sess-1",
      target: { kind: "ssh", host: "dev-a", username: "root", port: 22 },
      services: remoteHost.services,
    });

    const wrapper = ({ children }: { children: ReactNode }) =>
      createElement(ServiceProvider, { services: remoteHost.services }, children);

    const inheritingHook = renderHook(
      () =>
        useCodexTitleModel("/root/workspace/ai/Codez", "remote:ssh:dev-a:/root/workspace/ai/Codez"),
      { wrapper },
    );
    await expect(inheritingHook.result.current()).resolves.toEqual(controllerGlobal);

    const overriddenHook = renderHook(
      () =>
        useCodexTitleModel("/root/workspace/ai/Codez", "remote:ssh:dev-b:/root/workspace/ai/Codez"),
      { wrapper },
    );
    await expect(overriddenHook.result.current()).resolves.toEqual(remoteOverrideB);

    expect(controllerHost.getMock).toHaveBeenCalledTimes(2);
    expect(remoteHost.getMock).not.toHaveBeenCalled();
  });

  it("reads and persists CodexSettingsSection title model preferences on the controller host when rendered under a remote workspace ServiceProvider", async () => {
    const controllerGlobal: CodexTitleModel = {
      providerId: "ollama2",
      modelId: "deepseek-v4-flash",
    };
    const nextOverride: CodexTitleModel = {
      providerId: "ollama1",
      modelId: "glm-5.3",
    };
    const remoteIdentity = "remote:ssh:dev-a:/root/workspace/ai/Codez";
    const controllerHost = createMockHostServices({
      codexTitleDefaultModel: controllerGlobal,
    });
    const remoteHost = createMockHostServices({
      codexTitleDefaultModel: {
        providerId: "openai",
        modelId: "gpt-5.6-luna",
      },
    });
    registerBaseWorkspaceServices(controllerHost.services);

    render(
      createElement(
        ServiceProvider,
        { services: remoteHost.services },
        createElement(
          CodezIntlProvider,
          { initialLocale: "zh-CN" },
          createElement(
            TooltipProvider,
            null,
            createElement(CodexSettingsSection, {
              embeddedInSettingsPage: true,
              initialPanel: "models",
              workspacePath: "/root/workspace/ai/Codez",
              workspaceIdentity: remoteIdentity,
              remoteSessionId: "remote-sess-1",
            }),
          ),
        ),
      ),
    );

    await waitFor(() => {
      expect(titleModelSettingsCapture.latest?.settings?.codexTitleDefaultModel).toEqual(
        controllerGlobal,
      );
    });
    expect(remoteHost.getMock).not.toHaveBeenCalled();

    await act(async () => {
      await titleModelSettingsCapture.latest?.update({
        codexTitleWorkspaceModels: {
          [remoteIdentity]: nextOverride,
        },
      });
    });

    expect(controllerHost.updateMock).toHaveBeenCalledWith({
      codexTitleWorkspaceModels: {
        [remoteIdentity]: nextOverride,
      },
    });
    expect(remoteHost.updateMock).not.toHaveBeenCalled();
    await waitFor(() => {
      expect(
        titleModelSettingsCapture.latest?.settings?.codexTitleWorkspaceModels?.[remoteIdentity],
      ).toEqual(nextOverride);
    });
  });
});
