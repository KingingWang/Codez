import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { Emitter } from "@codez/rpc";
import { appSettingsSchema, resolveWorkspaceKey, type CodezProtocolMessage } from "@codez/shared";
import { createLocalServices, disposeServiceResourcesAndWait } from "../src/node.js";
import { ProviderRuntime } from "../src/model-provider/providerRuntime.js";
import { setDataBaseDir } from "../src/paths.js";
import { ICodezAgentService } from "../src/codez-agent/codezAgent.js";
import {
  CodezAgentProcessManager,
  type CodezAgentProcessManagerOptions,
} from "../src/codez-agent/codezAgentProcessManager.js";
import { CodezProtocolClient } from "../src/codez-agent/codezProtocolClient.js";
import type { ISettingService } from "../src/setting/setting.js";

// spec: codex-desktop-native-browser-cua「Remote workspace relay」：
// desktop-attached-remote 只有被窗口 Host 授予能力后才向 bridge 注入 relay 注册；
// 注册指向 remote-local endpoint/token，窗口 token 不出现在任何 env 中。
test("remote host injects the relay registration only after the desktop grants capability", async (t) => {
  const savedEnv = { ...process.env };
  delete process.env.CODEZ_AGENT_SERVER_COMMAND;
  delete process.env.CODEZ_DESKTOP_RUNTIME;
  const root = await mkdtemp(join(tmpdir(), "codez-remote-relay-startup-"));
  setDataBaseDir(root);
  process.env.CODEZ_DESKTOP_HOME_DIR = root;
  const bridgeRoot = join(root, "remote", "codex");
  await mkdir(bridgeRoot, { recursive: true });
  await writeFile(join(bridgeRoot, "bridge.cjs"), "");
  await writeFile(join(bridgeRoot, "codex"), "");
  process.env.CODEZ_CODEX_BRIDGE_PATH = join(bridgeRoot, "bridge.cjs");

  t.mock.method(ProviderRuntime.prototype, "start", async () => {
    throw new Error("legacy provider preparation deliberately unavailable");
  });
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

  const services = createLocalServices({
    settingService: settings,
    runtimeProcessEnvPatch: { PATH: process.env.PATH ?? "" },
    codezBuiltinProviderConfigFilePath: fileURLToPath(
      new URL("../../../config/provider/codez-builtin.json", import.meta.url),
    ),
    serviceAuthorityMode: "desktop-attached-remote",
    agentRuntimeContext: { runtimeSurface: "remote_workspace_host" },
    // 故意携带旧式本地清单：远端必须忽略它，只在 relay 授予后自建 remote-local 注册。
    desktopCodexMcpServers: [
      {
        name: "codez-desktop-browser-cua",
        command: "/opt/codez/bridge",
        args: ["/opt/codez/bridge.cjs", "native-browser-cua-mcp"],
        env: { CODEZ_NATIVE_BROWSER_CUA_TOKEN_FILE: "/tmp/window-token" },
      },
    ],
    prepareLegacyAccountConnections: async () => {
      throw new Error("must not prepare legacy accounts for Codex");
    },
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
    const workspace = { workspacePath: root, workspaceIdentity: "remote-identity" };

    // 授予前：无注册、可用性为 0。
    await agent.codexRequest({ ...workspace, request: { method: "account/read" } });
    assert.equal(spawnEnv?.CODEZ_DESKTOP_MCP_SERVERS, "");
    assert.equal(spawnEnv?.CODEZ_NATIVE_BROWSER_CUA_BROWSER_AVAILABLE, "0");

    // 授予：注册指向 relay 描述符，命令是本进程 node + 部署的 bridge.cjs。
    await agent.updateDesktopBrowserControl({ enabled: true });
    await agent.codexRequest({ ...workspace, request: { method: "account/read" } });
    const registration = JSON.parse(spawnEnv?.CODEZ_DESKTOP_MCP_SERVERS ?? "") as Array<{
      name: string;
      command: string;
      args: string[];
      env: Record<string, string>;
    }>;
    assert.equal(registration.length, 1);
    assert.equal(registration[0]!.name, "codez-desktop-browser-cua");
    assert.equal(registration[0]!.command, process.execPath);
    assert.deepEqual(registration[0]!.args, [
      join(bridgeRoot, "bridge.cjs"),
      "native-browser-cua-mcp",
    ]);
    const relayEnv = registration[0]!.env;
    assert.ok(relayEnv.CODEZ_NATIVE_BROWSER_CUA_ENDPOINT?.includes("relay"));
    assert.ok(relayEnv.CODEZ_NATIVE_BROWSER_CUA_TOKEN_FILE?.includes("relay"));
    assert.equal(
      JSON.stringify(registration).includes("window-token"),
      false,
      "window token must never appear in the remote registration",
    );
    assert.equal(spawnEnv?.CODEZ_NATIVE_BROWSER_CUA_BROWSER_AVAILABLE, "1");
    assert.equal(spawnEnv?.CODEZ_NATIVE_BROWSER_CUA_CUA_AVAILABLE, "0");

    // 撤销：注册与可用性立即消失。
    await agent.updateDesktopBrowserControl({ enabled: false });
    await agent.codexRequest({ ...workspace, request: { method: "account/read" } });
    assert.equal(spawnEnv?.CODEZ_DESKTOP_MCP_SERVERS, "");
    assert.equal(spawnEnv?.CODEZ_NATIVE_BROWSER_CUA_BROWSER_AVAILABLE, "0");
  } finally {
    await disposeServiceResourcesAndWait(services);
    setDataBaseDir(null);
    process.env = savedEnv;
    await rm(root, { recursive: true, force: true });
  }
});
