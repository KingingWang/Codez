import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { Emitter } from "@codez/rpc";
import {
  appSettingsSchema,
  buildRemoteWorkspaceIdentity,
  codezProtocolMethods,
  resolveWorkspaceKey,
  type CodezProtocolMessage,
} from "@codez/shared";
import { createLocalServices, disposeServiceResourcesAndWait } from "../src/node.js";
import { ProviderRuntime } from "../src/model-provider/providerRuntime.js";
import type { ISettingService } from "../src/setting/setting.js";
import { setDataBaseDir } from "../src/paths.js";
import { ICodezAgentService } from "../src/codez-agent/codezAgent.js";
import { ICodexDesktopFileRewindService } from "../src/desktop-file-rewind.js";
import { ISystemService } from "../src/system/system.js";
import {
  CodezAgentProcessManager,
  type CodezAgentProcessManagerOptions,
} from "../src/codez-agent/codezAgentProcessManager.js";
import { CodezProtocolClient } from "../src/codez-agent/codezProtocolClient.js";

test("only default local Codex startup skips legacy provider/account/tool prerequisites", async (t) => {
  const savedEnv = { ...process.env };
  delete process.env.CODEZ_AGENT_SERVER_COMMAND;
  // CI 明确选择 Codex 产品；此测试逐项验证默认/显式分流，不能继承外层 runtime override。
  delete process.env.CODEZ_DESKTOP_RUNTIME;
  process.env.CODEZ_DESKTOP_CONTEXT_PROMPT_ENABLED = "1";
  let starts = 0;
  let networkCalls = 0;
  let accountPreparations = 0;
  const legacyError = new Error("legacy provider preparation deliberately unavailable");
  t.mock.method(ProviderRuntime.prototype, "start", async () => {
    starts += 1;
    throw legacyError;
  });
  let spawnEnv: Record<string, string> | undefined;
  const messages = new Emitter<CodezProtocolMessage>();
  const closes = new Emitter<{ reason?: string }>();
  const wireMethods: string[] = [];
  const client = new CodezProtocolClient({
    kind: "memory",
    onMessage: messages.event,
    onClose: closes.event,
    async send(message) {
      if (!("method" in message && "id" in message)) return;
      wireMethods.push(message.method);
      messages.fire({
        id: message.id,
        result:
          message.method === codezProtocolMethods.runtimeCapabilities
            ? {
                independentPlanState: true,
                codex: {
                  auxiliaryTextGeneration: "supported",
                  observedSessionUsage: "supported",
                  observedAppUsage: "unsupported",
                  sharedContextContentCopy: "unsupported",
                  scheduledPromptAutomations: "supported",
                  nativeBrowserCuaMcp: "unsupported",
                  readOnlyWorkflowHistory: "supported",
                  safeDesktopFileRewind: "supported",
                  legacyWorkflowRuns: "unsupported",
                },
              }
            : { native: true },
      });
    },
    dispose() {
      messages.dispose();
      closes.dispose();
    },
  });
  t.mock.method(
    CodezAgentProcessManager.prototype,
    "getClient",
    async function (
      this: CodezAgentProcessManager,
      workspace: { workspacePath: string; workspaceIdentity?: string },
    ) {
      // Exercise the callback actually installed by createLocalServices without launching an engine.
      const manager = this as unknown as Pick<CodezAgentProcessManagerOptions, "resolveSpawnEnv">;
      spawnEnv = await manager.resolveSpawnEnv?.({
        ...workspace,
        workspaceKey: resolveWorkspaceKey(workspace),
      });
      return client;
    },
  );
  try {
    for (const mode of [
      "codex",
      "deployed-codex",
      "explicit-env",
      "forced-legacy",
      "custom-resolver",
      "remote",
      "headless",
    ] as const) {
      const root = await mkdtemp(join(tmpdir(), "codez-codex-host-"));
      setDataBaseDir(root);
      process.env.CODEZ_DESKTOP_HOME_DIR = root;
      const settings: ISettingService = {
        async get() {
          return appSettingsSchema.parse({
            httpProxy: "http://127.0.0.1:19080",
            httpProxyNoProxy: "localhost",
            httpProxyCaCertPath: join(root, "example-ca.pem"),
          });
        },
        async update() {
          assert.fail("fixture settings are read-only");
        },
        async updateDataBaseDir() {
          assert.fail("fixture settings are read-only");
        },
        async ensureDefaultProject() {
          assert.fail("fixture must not create projects");
        },
      };
      if (mode === "forced-legacy") process.env.CODEZ_DESKTOP_RUNTIME = "legacy";
      else delete process.env.CODEZ_DESKTOP_RUNTIME;
      if (mode === "explicit-env") process.env.CODEZ_AGENT_SERVER_COMMAND = "/legacy/agent";
      else delete process.env.CODEZ_AGENT_SERVER_COMMAND;
      if (mode === "deployed-codex") {
        const bridgeRoot = join(root, "remote", "codex");
        await mkdir(bridgeRoot, { recursive: true });
        await writeFile(join(bridgeRoot, "bridge.cjs"), "");
        await writeFile(join(bridgeRoot, "codex"), "");
        process.env.CODEZ_CODEX_BRIDGE_PATH = join(bridgeRoot, "bridge.cjs");
      } else delete process.env.CODEZ_CODEX_BRIDGE_PATH;
      wireMethods.length = 0;
      const before = starts;
      const nativeBrowserCua =
        mode === "codex"
          ? { browserAvailable: true, cuaAvailable: false }
          : mode === "deployed-codex"
            ? { browserAvailable: false, cuaAvailable: false }
            : undefined;
      const services = createLocalServices({
        settingService: settings,
        runtimeProcessEnvPatch: { PATH: savedEnv.PATH ?? "" },
        codezBuiltinProviderConfigFilePath: fileURLToPath(
          new URL("../../../config/provider/codez-builtin.json", import.meta.url),
        ),
        ...(mode === "headless"
          ? {}
          : {
              serviceAuthorityMode:
                mode === "remote" || mode === "deployed-codex"
                  ? ("desktop-attached-remote" as const)
                  : ("desktop-local" as const),
              agentTelemetry: {
                runtimeSurface:
                  mode === "remote" || mode === "deployed-codex"
                    ? ("remote_workspace_host" as const)
                    : ("desktop_local_host" as const),
              },
            }),
        ...(mode === "custom-resolver" ? { codezAgentCommandResolver: () => null } : {}),
        ...(nativeBrowserCua ? { nativeBrowserCua } : {}),
        // 故意向每一种 Host 都传同一份清单：远端和旧运行时必须拒绝注入。
        desktopCodexMcpServers: [
          {
            name: "codez-desktop-browser-cua",
            command: "/opt/codez/bridge",
            args: ["/opt/codez/bridge.cjs", "native-browser-cua-mcp"],
            env: { CODEZ_NATIVE_BROWSER_CUA_TOKEN_FILE: "/tmp/window-token" },
          },
        ],
        prepareLegacyAccountConnections: async () => {
          accountPreparations += 1;
          throw new Error("must not prepare Zai account for Codex");
        },
        hostApiNetworkTransport: {
          fetch: async () => {
            networkCalls += 1;
            throw new Error("unexpected host API access");
          },
          dispose() {},
          async disposeAndWait() {},
        },
      });
      try {
        const systemInfo = await services.get(ISystemService).info();
        assert.equal(
          systemInfo.agentRuntimeMode,
          mode === "codex" || mode === "deployed-codex" ? "codex" : "legacy",
          "Host must expose the selected runtime, not the desktop product flavor",
        );
        const agent = services.get(ICodezAgentService);
        if (mode === "deployed-codex") {
          const hello = await agent.helloConversationV4();
          assert.equal(
            hello.capabilities.codex?.sharedContextContentCopy,
            "unsupported",
            "attached-remote unsupported share wrapper must not become Codex content-copy capability",
          );
        }
        const rewindOwner = services.getOptional(ICodexDesktopFileRewindService);
        assert.equal(
          Boolean(rewindOwner),
          mode === "codex",
          "safe rewind owner is Desktop-local/default bridge only",
        );
        wireMethods.length = 0;
        const request = agent.codexRequest({
          workspacePath: root,
          workspaceIdentity: "remote-identity-kept",
          request: { method: "account/read" },
        });
        if (mode === "codex" || mode === "deployed-codex") {
          assert.deepEqual(await request, { native: true });
          assert.equal(starts, before, "neither assembly nor spawn may start the legacy provider");
          assert.equal(networkCalls, 0);
          assert.equal(accountPreparations, 0);
          assert.deepEqual(
            wireMethods,
            ["codex/request"],
            "no legacy tool policy prerequisite RPCs",
          );
          assert.equal(process.env.PATH, savedEnv.PATH);
          assert.deepEqual(
            spawnEnv,
            mode === "codex"
              ? {
                  // 缺凭据名单无条件注入空串：显式屏蔽继承的同名变量（spec: codex-provider-runtime-env-key）。
                  CODEZ_CODEX_BLOCKED_PROVIDER_IDS: "",
                  HTTP_PROXY: "http://127.0.0.1:19080",
                  HTTPS_PROXY: "http://127.0.0.1:19080",
                  ALL_PROXY: "http://127.0.0.1:19080",
                  CODEZ_HTTP_PROXY: "http://127.0.0.1:19080",
                  NO_PROXY: "localhost",
                  no_proxy: "localhost",
                  CODEZ_NO_PROXY: "localhost",
                  NODE_EXTRA_CA_CERTS: join(root, "example-ca.pem"),
                  CODEZ_AGENT_CA_CERT: join(root, "example-ca.pem"),
                  CODEZ_NATIVE_BROWSER_CUA_BROWSER_AVAILABLE: "1",
                  CODEZ_NATIVE_BROWSER_CUA_CUA_AVAILABLE: "0",
                  CODEZ_DESKTOP_MCP_SERVERS: JSON.stringify([
                    {
                      name: "codez-desktop-browser-cua",
                      command: "/opt/codez/bridge",
                      args: ["/opt/codez/bridge.cjs", "native-browser-cua-mcp"],
                      env: { CODEZ_NATIVE_BROWSER_CUA_TOKEN_FILE: "/tmp/window-token" },
                    },
                  ]),
                }
              : {
                  CODEZ_CODEX_BLOCKED_PROVIDER_IDS: "",
                  HTTP_PROXY: "http://127.0.0.1:19080",
                  HTTPS_PROXY: "http://127.0.0.1:19080",
                  ALL_PROXY: "http://127.0.0.1:19080",
                  CODEZ_HTTP_PROXY: "http://127.0.0.1:19080",
                  NO_PROXY: "localhost",
                  no_proxy: "localhost",
                  CODEZ_NO_PROXY: "localhost",
                  NODE_EXTRA_CA_CERTS: join(root, "example-ca.pem"),
                  CODEZ_AGENT_CA_CERT: join(root, "example-ca.pem"),
                  CODEZ_NATIVE_BROWSER_CUA_BROWSER_AVAILABLE: "0",
                  CODEZ_NATIVE_BROWSER_CUA_CUA_AVAILABLE: "0",
                  CODEZ_DESKTOP_MCP_SERVERS: "",
                },
          );
          for (const key of Object.keys(spawnEnv ?? {})) {
            assert.equal(key.includes("CODEZ_NODE_REPL_BROWSER_BROKER"), false, key);
          }
        } else {
          await assert.rejects(request, (error) => error === legacyError);
          assert.ok(starts > before, `${mode} retains legacy startup prerequisites`);
        }
      } finally {
        await disposeServiceResourcesAndWait(services);
        setDataBaseDir(null);
        await rm(root, { recursive: true, force: true });
      }
    }
  } finally {
    client.dispose();
    process.env = savedEnv;
  }
});

test("local Codex injects CUA broker credentials only when Computer Use is enabled and never for remote workspaces", async (t) => {
  const savedEnv = { ...process.env };
  delete process.env.CODEZ_AGENT_SERVER_COMMAND;
  delete process.env.CODEZ_DESKTOP_RUNTIME;
  delete process.env.CODEZ_CODEX_BRIDGE_PATH;
  process.env.CODEZ_DESKTOP_CONTEXT_PROMPT_ENABLED = "1";
  let spawnEnv: Record<string, string> | undefined;
  const messages = new Emitter<CodezProtocolMessage>();
  const closes = new Emitter<{ reason?: string }>();
  const client = new CodezProtocolClient({
    kind: "memory",
    onMessage: messages.event,
    onClose: closes.event,
    async send(message) {
      if (!("method" in message && "id" in message)) return;
      messages.fire({ id: message.id, result: { native: true } });
    },
    dispose() {
      messages.dispose();
      closes.dispose();
    },
  });
  t.mock.method(
    CodezAgentProcessManager.prototype,
    "getClient",
    async function (
      this: CodezAgentProcessManager,
      workspace: { workspacePath: string; workspaceIdentity?: string },
    ) {
      const manager = this as unknown as Pick<CodezAgentProcessManagerOptions, "resolveSpawnEnv">;
      spawnEnv = await manager.resolveSpawnEnv?.({
        ...workspace,
        workspaceKey: resolveWorkspaceKey(workspace),
      });
      return client;
    },
  );
  const root = await mkdtemp(join(tmpdir(), "codez-codex-local-cua-"));
  setDataBaseDir(root);
  process.env.CODEZ_DESKTOP_HOME_DIR = root;
  process.env.CODEZ_HOME = join(root, ".codez");
  const cliConfigDir = join(root, ".codez", "cli");
  await mkdir(cliConfigDir, { recursive: true });
  await writeFile(
    join(cliConfigDir, "config.json"),
    JSON.stringify({
      plugins: {
        enabled: true,
        enabledPlugins: {
          "computer-use@codez-plugins-official": true,
        },
      },
    }),
  );
  const settings: ISettingService = {
    async get() {
      return appSettingsSchema.parse({});
    },
    async update() {
      assert.fail("fixture settings are read-only");
    },
    async updateDataBaseDir() {
      assert.fail("fixture settings are read-only");
    },
    async ensureDefaultProject() {
      assert.fail("fixture must not create projects");
    },
  };
  let helperStarts = 0;
  const services = createLocalServices({
    settingService: settings,
    runtimeProcessEnvPatch: { PATH: savedEnv.PATH ?? "" },
    codezBuiltinProviderConfigFilePath: fileURLToPath(
      new URL("../../../config/provider/codez-builtin.json", import.meta.url),
    ),
    serviceAuthorityMode: "desktop-local",
    agentTelemetry: { runtimeSurface: "desktop_local_host" },
    nativeBrowserCua: { browserAvailable: true, cuaAvailable: false },
    desktopCodexMcpServers: [
      {
        name: "codez-desktop-browser-cua",
        command: "/opt/codez/bridge",
        args: ["/opt/codez/bridge.cjs", "native-browser-cua-mcp"],
        env: { CODEZ_NATIVE_BROWSER_CUA_TOKEN_FILE: "/tmp/window-token" },
      },
    ],
    createDefaultCuaProductHelper: () => ({
      host: {
        running: true,
        socketPath: "/tmp/local-cua.sock",
        pipSocketPath: "/tmp/local-cua.pip.sock",
        pluginAuthority: "local-cua-secret",
        generation: 5,
        async start() {
          helperStarts += 1;
          return {
            socketPath: "/tmp/local-cua.sock",
            pipSocketPath: "/tmp/local-cua.pip.sock",
            launchSocketPath: "/tmp/local-cua.sock",
            pluginAuthority: "local-cua-secret",
            helperAppPath: "/tmp/helper",
            bundleId: "dev.codez.cua-helper",
            pid: 99,
            generation: 5,
          };
        },
        async stop() {},
        async restart() {
          return this.start();
        },
        async restartAfterCurrentStart() {
          return this.start();
        },
        async checkHealth() {
          return { bundleId: "dev.codez.cua-helper", pid: 99 };
        },
      },
      resolver: {
        async resolveMcpServers(servers) {
          return servers;
        },
        async restart() {},
        async restartAfterPermissionGrant() {},
      },
    }),
    hostApiNetworkTransport: {
      fetch: async () => {
        throw new Error("unexpected host API access");
      },
      dispose() {},
      async disposeAndWait() {},
    },
  });
  try {
    const agent = services.get(ICodezAgentService);
    // 1. Local workspace with Computer Use enabled receives CUA credentials in MCP server env.
    await agent.codexRequest({
      workspacePath: root,
      request: { method: "account/read" },
    });
    assert.equal(helperStarts, 1);
    assert.equal(spawnEnv?.CODEZ_NATIVE_BROWSER_CUA_BROWSER_AVAILABLE, "1");
    assert.equal(spawnEnv?.CODEZ_NATIVE_BROWSER_CUA_CUA_AVAILABLE, "1");
    assert.deepEqual(JSON.parse(spawnEnv?.CODEZ_DESKTOP_MCP_SERVERS ?? "[]"), [
      {
        name: "codez-desktop-browser-cua",
        command: "/opt/codez/bridge",
        args: ["/opt/codez/bridge.cjs", "native-browser-cua-mcp"],
        env: {
          CODEZ_NATIVE_BROWSER_CUA_TOKEN_FILE: "/tmp/window-token",
          CODEZ_CUA_PERMISSION_BROKER_SOCKET: "/tmp/local-cua.sock",
          CODEZ_CUA_PLUGIN_AUTHORITY: "local-cua-secret",
          CODEZ_CUA_PERMISSION_BROKER_GENERATION: "5",
        },
      },
    ]);

    // 2. Remote workspace identity on the same Host never receives local CUA credentials.
    await agent.codexRequest({
      workspacePath: root,
      workspaceIdentity: buildRemoteWorkspaceIdentity("/home/user/repo", {
        kind: "ssh",
        host: "remote-host",
        port: 22,
        username: "user",
      }),
      request: { method: "account/read" },
    });
    assert.equal(spawnEnv?.CODEZ_NATIVE_BROWSER_CUA_CUA_AVAILABLE, "0");
    assert.deepEqual(JSON.parse(spawnEnv?.CODEZ_DESKTOP_MCP_SERVERS ?? "[]"), [
      {
        name: "codez-desktop-browser-cua",
        command: "/opt/codez/bridge",
        args: ["/opt/codez/bridge.cjs", "native-browser-cua-mcp"],
        env: {
          CODEZ_NATIVE_BROWSER_CUA_TOKEN_FILE: "/tmp/window-token",
        },
      },
    ]);
  } finally {
    await disposeServiceResourcesAndWait(services);
    setDataBaseDir(null);
    client.dispose();
    process.env = savedEnv;
    await rm(root, { recursive: true, force: true });
  }
});
