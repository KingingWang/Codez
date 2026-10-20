import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { IModelSelectionService, ICodezAgentService } from "@codez/services";
import {
  disposeServiceResourcesAndWait,
  resolveDefaultCodezAgentCommand,
  setDataBaseDir,
  type CodezAgentCommand,
  type CodezAgentCommandResolverContext,
} from "@codez/services/node";
import {
  SERVICE_AUTHORITY_MODE_ENV,
  CODEZ_DESKTOP_CONTEXT_PROMPT_ENABLED_ENV,
  CODEZ_REMOTE_HTTP_PROXY_ENV_KEY,
  CODEZ_REMOTE_NO_PROXY_ENV_KEY,
  CODEZ_REMOTE_RUNTIME_NETWORK_AUTHORITY_ENV_KEY,
} from "@codez/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createStdioServices, resolveRemoteAgentNetworkFromEnv } from "../src/stdioServices.js";

const originalHome = process.env.HOME;
const originalCommand = process.env.CODEZ_AGENT_SERVER_COMMAND;
const originalArgsJson = process.env.CODEZ_AGENT_SERVER_ARGS_JSON;
const originalDesktopContextPromptEnabled = process.env[CODEZ_DESKTOP_CONTEXT_PROMPT_ENABLED_ENV];

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
    return;
  }
  process.env[name] = value;
}

describe("stdio Desktop presentation surface", () => {
  const tempHomes: string[] = [];

  afterEach(async () => {
    setDataBaseDir(null);
    restoreEnv("HOME", originalHome);
    restoreEnv("CODEZ_AGENT_SERVER_COMMAND", originalCommand);
    restoreEnv("CODEZ_AGENT_SERVER_ARGS_JSON", originalArgsJson);
    restoreEnv(CODEZ_DESKTOP_CONTEXT_PROMPT_ENABLED_ENV, originalDesktopContextPromptEnabled);
    vi.restoreAllMocks();
    await Promise.all(
      tempHomes.splice(0).map((home) => rm(home, { recursive: true, force: true })),
    );
  });

  it("只从 Host 权威标记读取一次性 WSL Agent 网络配置", () => {
    expect(
      resolveRemoteAgentNetworkFromEnv({
        [CODEZ_REMOTE_HTTP_PROXY_ENV_KEY]: " http://172.21.240.1:7890 ",
        [CODEZ_REMOTE_NO_PROXY_ENV_KEY]: " localhost,127.0.0.1 ",
      }),
    ).toBeUndefined();
    expect(
      resolveRemoteAgentNetworkFromEnv({
        [CODEZ_REMOTE_RUNTIME_NETWORK_AUTHORITY_ENV_KEY]: "1",
        [CODEZ_REMOTE_HTTP_PROXY_ENV_KEY]: " http://172.21.240.1:7890 ",
        [CODEZ_REMOTE_NO_PROXY_ENV_KEY]: " localhost,127.0.0.1 ",
      }),
    ).toEqual({
      httpProxy: "http://172.21.240.1:7890",
      noProxy: "localhost,127.0.0.1",
    });
  });

  it("让 Desktop attached remote authority 贯穿 stdio 装配并生成 Desktop Agent 命令", async () => {
    const home = await mkdtemp(join(tmpdir(), "codez-stdio-desktop-surface-"));
    tempHomes.push(home);
    process.env.HOME = home;
    setDataBaseDir(home);
    // Bugfix: 开发机可能导出 CODEZ_DESKTOP_CONTEXT_PROMPT_ENABLED=0（如本机 Codez 安装的 shell 集成），
    // 会把 desktop-attached-remote 推导出的 presentationSurface 灭成 undefined，
    // 让「surface 贯穿装配」断言变成环境敏感；显式置 1 恢复用例封闭性。
    process.env[CODEZ_DESKTOP_CONTEXT_PROMPT_ENABLED_ENV] = "1";
    process.env.CODEZ_AGENT_SERVER_COMMAND = process.execPath;
    process.env.CODEZ_AGENT_SERVER_ARGS_JSON = JSON.stringify([
      "codez.cjs",
      "app-server",
      "--stdio",
    ]);
    const codezBuiltinProviderConfigFilePath = join(home, "codez-builtin.json");
    const personalConfigFilePath = join(home, ".codez", "v2", "provider_config.json");
    await mkdir(join(home, ".codez", "v2"), { recursive: true });
    await writeFile(
      personalConfigFilePath,
      JSON.stringify({
        schemaVersion: 1,
        config: {
          providerConfigRules: {
            providerRules: [
              {
                providerId: "test-provider",
                templateId: "test-template",
                providerName: "Test Provider",
                config: {
                  group: "standard-personal",
                  access: { type: "api-key", apiKey: "test-key" },
                  personalModelIds: ["test-model"],
                },
              },
            ],
          },
          // 使用正式信封与分组；旧中间态会在装配前被拒绝，无法覆盖本例的远端行为。
          modelConfigRules: { providerModelRules: [], manualProviderModelRules: [] },
        },
      }),
      "utf8",
    );
    await writeFile(
      codezBuiltinProviderConfigFilePath,
      JSON.stringify({
        schemaVersion: 1,
        revision: 1,
        config: {
          providerConfigRules: {
            providerRules: [],
            templateRules: [
              {
                templateId: "test-template",
                templateNameMap: { "en-US": "Test Provider" },
                config: {
                  access: { type: "api-key" },
                  api: {
                    type: "openai-chat-completions",
                    baseUrl: "https://example.com/v1",
                  },
                  builtinModelIds: ["test-model"],
                },
              },
            ],
          },
          modelConfigRules: {
            modelRules: [],
            modelApiRules: [],
            providerSiteRules: [],
            builtinProviderModelRules: [],
            templateModelRules: [
              {
                templateId: "test-template",
                modelId: "test-model",
                config: {
                  enabled: true,

                  properties: {
                    requiresMfjsToolSchema: false,
                    contextWindow: 128000,
                    inputFormat: {
                      supportsText: true,
                      supportsImage: false,
                      supportsVideo: false,
                      supportsAudio: false,
                      supportsPdf: false,
                    },
                    outputFormat: { supportsText: true },
                    supportsToolCall: true,
                    supportsJsonSchemaOutput: true,
                    supportsNativeWebSearch: false,
                    supportsMidConversationSystem: false,
                  },
                  optionSpecs: {
                    reasoningLevel: {
                      values: ["disabled"],
                      map: "{}",
                    },
                    maxOutputTokens: {
                      max: 8192,
                      map: "{'max_completion_tokens': maxOutputTokens}",
                    },
                  },
                },
              },
            ],
          },
        },
      }),
      "utf8",
    );

    let resolvedCommand: CodezAgentCommand | null = null;
    const commandResolver = vi.fn((context: CodezAgentCommandResolverContext) => {
      resolvedCommand = resolveDefaultCodezAgentCommand(context);
      // 集成测试只验证入口装配与最终命令，不启动长驻 Agent 子进程。
      return null;
    });
    const bootstrap = createStdioServices({
      env: {
        [SERVICE_AUTHORITY_MODE_ENV]: "desktop-attached-remote",
      },
      codezBuiltinProviderConfigFilePath,
      codezAgentCommandResolver: commandResolver,
    });

    try {
      await expect(bootstrap.services.get(IModelSelectionService).getView()).resolves.toMatchObject(
        {
          revision: 1,
          providers: [
            {
              providerId: "test-provider",
              models: [{ modelId: "test-model" }],
            },
          ],
        },
      );
      await expect(
        bootstrap.services.get(ICodezAgentService).initialize({
          workspaceIdentity: "ssh://host/workspace/project",
          workspacePath: "/workspace/project",
        }),
      ).resolves.toMatchObject({
        available: false,
        reason: expect.stringContaining("Codez agent server command is not configured"),
      });

      expect(bootstrap.authorityModeParseResult.mode).toBe("desktop-attached-remote");
      expect(commandResolver).toHaveBeenCalledWith(
        expect.objectContaining({
          presentationSurface: "desktop",
          workspaceIdentity: "ssh://host/workspace/project",
          workspaceKey: "ssh://host/workspace/project",
          workspacePath: "/workspace/project",
        }),
      );
      expect(resolvedCommand).toEqual({
        args: ["codez.cjs", "app-server", "--stdio", "--surface", "desktop"],
        command: process.execPath,
        cwd: "/workspace/project",
      });
    } finally {
      // 等待服务异步落盘与回收结束，避免清理临时目录时后台重新创建文件。
      await disposeServiceResourcesAndWait(bootstrap.services);
      setDataBaseDir(null);
    }
  });
});
