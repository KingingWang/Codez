import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveServerLayout } from "../src/runtime/paths.js";

const createServerHostServices = vi.fn();
const materializeCodezBuiltinProviderConfig = vi.fn();
const disposeServiceResourcesAndWait = vi.fn();
const createCoreHttpServer = vi.fn();
const createIngressToken = vi.fn();
const resolveCoreServerId = vi.fn();
const installParentDisconnectHandler = vi.fn();
const createTaskActivityTracker = vi.fn();
const environmentConfigRoot = "/tmp/codez-server-core-test/.codez/v2";

vi.mock("@codez/services/node", () => ({
  CODEZ_BUILTIN_PROVIDER_CONFIG_FILE_ENV: "CODEZ_BUILTIN_PROVIDER_CONFIG_FILE",
  createServerHostServices,
  createTopicResourcePeers: () => ({ getChannel: vi.fn() }),
  disposeServiceResourcesAndWait,
  getAppConfigDir: () => environmentConfigRoot,
  materializeCodezBuiltinProviderConfig,
}));
vi.mock("../src/server-core/http.js", () => ({ createCoreHttpServer }));
vi.mock("../src/server-core/ingressToken.js", () => ({ createIngressToken }));
vi.mock("../src/server-core/serverIdentity.js", () => ({ resolveCoreServerId }));
vi.mock("../src/server-core/parentDisconnect.js", () => ({ installParentDisconnectHandler }));
vi.mock("../src/server-core/taskActivityTracker.js", () => ({ createTaskActivityTracker }));

const { runServerCore } = await import("../src/server-core/core.js");

const ENV_KEYS = [
  "CODEZ_SERVER_ROOT",
  "CODEZ_SERVER_RUNTIME_ROOT",
  "CODEZ_SERVER_RELEASE_ID",
  "CODEZ_BUILTIN_PROVIDER_CONFIG_FILE",
] as const;
const PROCESS_EVENTS = ["message", "SIGTERM", "SIGINT"] as const;
// 以通用 EventEmitter 视角操作 process，绕开 process.on/listeners 针对具体事件名的重载。
const processEmitter: NodeJS.EventEmitter = process;

describe("runServerCore startup wiring", () => {
  const layout = resolveServerLayout("/tmp/codez-server-core-test/.codez/server");
  const materializedPath = join(
    environmentConfigRoot,
    "runtime",
    "provider",
    "bundled",
    "codez-builtin.json",
  );
  const savedEnv = new Map<string, string | undefined>();
  const listenersBefore = new Map<string, Function[]>();

  beforeEach(() => {
    vi.useFakeTimers();
    for (const key of ENV_KEYS) {
      savedEnv.set(key, process.env[key]);
      delete process.env[key];
    }
    for (const event of PROCESS_EVENTS) {
      listenersBefore.set(event, processEmitter.listeners(event));
    }
    process.env.CODEZ_SERVER_ROOT = layout.serverRoot;
    vi.stubGlobal("__CODEZ_BUILTIN_PROVIDER_CONFIG_JSON__", '{"providers":{}}');
    materializeCodezBuiltinProviderConfig.mockResolvedValue(materializedPath);
    createServerHostServices.mockResolvedValue({
      services: { getOptional: vi.fn(() => undefined) },
      workspaceIdentityMapper: {},
      migrationFailedPathCount: 0,
    });
    createCoreHttpServer.mockResolvedValue({
      host: "127.0.0.1",
      port: 4321,
      close: vi.fn(async () => undefined),
    });
    createIngressToken.mockResolvedValue("ingress-token");
    resolveCoreServerId.mockResolvedValue("server-installation-id");
    installParentDisconnectHandler.mockReturnValue(() => undefined);
    createTaskActivityTracker.mockReturnValue({
      readRunningTaskCount: () => 0,
      onDidChangeRunningTaskCount: () => ({ dispose: () => undefined }),
      dispose: () => undefined,
    });
  });

  afterEach(() => {
    // runServerCore 会注册 shutdown 监听并启动心跳 interval；测试不走 process.exit 路径，
    // 手工回收本用例新增的监听与定时器，避免污染同一 worker 内的其它用例。
    for (const event of PROCESS_EVENTS) {
      const before = new Set(listenersBefore.get(event) ?? []);
      for (const listener of processEmitter.listeners(event)) {
        if (!before.has(listener)) {
          processEmitter.removeListener(event, listener as (...args: unknown[]) => void);
        }
      }
    }
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    for (const key of ENV_KEYS) {
      const value = savedEnv.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    vi.resetAllMocks();
  });

  it("materializes the built-in provider config under the environment config root, not the release runtime", async () => {
    process.env.CODEZ_SERVER_RUNTIME_ROOT = join(layout.releasesDir, "release-1", "runtime");
    process.env.CODEZ_SERVER_RELEASE_ID = "release-1";

    await runServerCore(7);

    expect(materializeCodezBuiltinProviderConfig).toHaveBeenCalledTimes(1);
    expect(materializeCodezBuiltinProviderConfig).toHaveBeenCalledWith({
      environmentConfigRoot,
      content: '{"providers":{}}',
    });
    expect(createServerHostServices).toHaveBeenCalledWith({
      codezBuiltinProviderConfigFilePath: materializedPath,
      sourceServerId: "server-installation-id",
      providerProvisioningTargetEnabled: true,
      ephemeralRuntimeKeysEnabled: true,
      topicResourceRelayChannel: expect.any(Function),
    });
    expect(createIngressToken).toHaveBeenCalledWith(layout);
  });

  it("waits for owner host initialization before opening RPC", async () => {
    const result = {
      services: { getOptional: () => undefined },
      workspaceIdentityMapper: {},
      migrationFailedPathCount: 0,
    };
    let release!: () => void;
    createServerHostServices.mockImplementation(
      () =>
        new Promise((resolve) => {
          release = () => resolve(result);
        }),
    );
    const starting = runServerCore(1);
    await vi.waitFor(() => expect(createServerHostServices).toHaveBeenCalledOnce());
    expect(createCoreHttpServer).not.toHaveBeenCalled();
    release();
    await starting;
    expect(createCoreHttpServer).toHaveBeenCalledWith(
      result.services,
      expect.objectContaining({
        serverId: "server-installation-id",
        workspaceIdentityMapper: result.workspaceIdentityMapper,
      }),
    );
  });

  it("keeps the server closed when migration fails", async () => {
    createServerHostServices.mockRejectedValue(new Error("migration failed"));
    await expect(runServerCore(1)).rejects.toThrow("migration failed");
    expect(createCoreHttpServer).not.toHaveBeenCalled();
  });

  it("prefers an explicitly configured built-in provider config file", async () => {
    process.env.CODEZ_BUILTIN_PROVIDER_CONFIG_FILE = "/explicit/codez-builtin.json";

    await runServerCore(1);

    expect(materializeCodezBuiltinProviderConfig).not.toHaveBeenCalled();
    expect(createServerHostServices).toHaveBeenCalledWith(
      expect.objectContaining({
        codezBuiltinProviderConfigFilePath: "/explicit/codez-builtin.json",
        providerProvisioningTargetEnabled: true,
      }),
    );
  });

  it("fails fast when neither an embedded nor an explicit built-in config is available", async () => {
    vi.stubGlobal("__CODEZ_BUILTIN_PROVIDER_CONFIG_JSON__", undefined);

    await expect(runServerCore(1)).rejects.toThrow(
      /Codez Built-in Provider Config.*CODEZ_BUILTIN_PROVIDER_CONFIG_FILE/u,
    );
    expect(createServerHostServices).not.toHaveBeenCalled();
  });
});
