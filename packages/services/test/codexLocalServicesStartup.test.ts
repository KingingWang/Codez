import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { Emitter } from "@zcode/rpc";
import { appSettingsSchema, resolveWorkspaceKey, type ZCodeProtocolMessage } from "@zcode/shared";
import { createLocalServices, disposeServiceResourcesAndWait } from "../src/node.js";
import { ProviderRuntime } from "../src/model-provider/providerRuntime.js";
import type { ISettingService } from "../src/setting/setting.js";
import { setDataBaseDir } from "../src/paths.js";
import { IZCodeAgentService } from "../src/zcode-agent/zcodeAgent.js";
import {
  ZCodeAgentProcessManager,
  type ZCodeAgentProcessManagerOptions,
} from "../src/zcode-agent/zcodeAgentProcessManager.js";
import { ZCodeProtocolClient } from "../src/zcode-agent/zcodeProtocolClient.js";

test("only default local Codex startup skips legacy provider/account/tool prerequisites", async (t) => {
  const savedEnv = { ...process.env };
  delete process.env.ZCODE_AGENT_SERVER_COMMAND;
  // CI 明确选择 Codex 产品；此测试逐项验证默认/显式分流，不能继承外层 runtime override。
  delete process.env.ZCODE_DESKTOP_RUNTIME;
  process.env.ZCODE_DESKTOP_CONTEXT_PROMPT_ENABLED = "1";
  let starts = 0;
  let networkCalls = 0;
  let accountPreparations = 0;
  const legacyError = new Error("legacy provider preparation deliberately unavailable");
  t.mock.method(ProviderRuntime.prototype, "start", async () => {
    starts += 1;
    throw legacyError;
  });
  let spawnEnv: Record<string, string> | undefined;
  const messages = new Emitter<ZCodeProtocolMessage>();
  const closes = new Emitter<{ reason?: string }>();
  const wireMethods: string[] = [];
  const client = new ZCodeProtocolClient({
    kind: "memory",
    onMessage: messages.event,
    onClose: closes.event,
    async send(message) {
      if ("method" in message && "id" in message) {
        wireMethods.push(message.method);
        messages.fire({ id: message.id, result: { native: true } });
      }
    },
    dispose() {
      messages.dispose();
      closes.dispose();
    },
  });
  t.mock.method(
    ZCodeAgentProcessManager.prototype,
    "getClient",
    async function (
      this: ZCodeAgentProcessManager,
      workspace: { workspacePath: string; workspaceIdentity?: string },
    ) {
      // Exercise the callback actually installed by createLocalServices without launching an engine.
      const manager = this as unknown as Pick<ZCodeAgentProcessManagerOptions, "resolveSpawnEnv">;
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
      const root = await mkdtemp(join(tmpdir(), "zcode-codex-host-"));
      setDataBaseDir(root);
      process.env.ZCODE_DESKTOP_HOME_DIR = root;
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
      if (mode === "explicit-env") process.env.ZCODE_AGENT_SERVER_COMMAND = "/legacy/agent";
      else delete process.env.ZCODE_AGENT_SERVER_COMMAND;
      if (mode === "deployed-codex")
        process.env.ZCODE_CODEX_BRIDGE_PATH = "/remote/codex/bridge.cjs";
      else delete process.env.ZCODE_CODEX_BRIDGE_PATH;
      wireMethods.length = 0;
      const before = starts;
      const services = createLocalServices({
        settingService: settings,
        runtimeProcessEnvPatch: { PATH: savedEnv.PATH ?? "" },
        zcodeBuiltinProviderConfigFilePath: fileURLToPath(
          new URL("../../../config/provider/zcode-builtin.json", import.meta.url),
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
        ...(mode === "custom-resolver" ? { zcodeAgentCommandResolver: () => null } : {}),
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
        const agent = services.get(IZCodeAgentService);
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
          assert.deepEqual(spawnEnv, {
            HTTP_PROXY: "http://127.0.0.1:19080",
            HTTPS_PROXY: "http://127.0.0.1:19080",
            ALL_PROXY: "http://127.0.0.1:19080",
            ZCODE_HTTP_PROXY: "http://127.0.0.1:19080",
            NO_PROXY: "localhost",
            no_proxy: "localhost",
            ZCODE_NO_PROXY: "localhost",
            NODE_EXTRA_CA_CERTS: join(root, "example-ca.pem"),
            ZCODE_AGENT_CA_CERT: join(root, "example-ca.pem"),
          });
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
