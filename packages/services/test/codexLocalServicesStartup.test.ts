import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { Emitter } from "@codez/rpc";
import {
  appSettingsSchema,
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
              agentRuntimeContext: {
                runtimeSurface:
                  mode === "remote" || mode === "deployed-codex"
                    ? ("remote_workspace_host" as const)
                    : ("desktop_local_host" as const),
              },
            }),
        ...(mode === "custom-resolver" ? { codezAgentCommandResolver: () => null } : {}),
        ...(nativeBrowserCua ? { nativeBrowserCua } : {}),
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
                }
              : {
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
