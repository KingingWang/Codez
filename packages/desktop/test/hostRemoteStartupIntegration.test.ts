import { runStartupReconnectBatch } from "../src/host/sourceServerStartupReconnect.js";
import { connectSourceServerTarget } from "../src/host/connectSourceServerTarget.js";
import { buildRemoteEnvironmentKey } from "@codez/shared";
import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { describe, expect, it, vi } from "vitest";

/** Host 入口依赖 Electron utilityProcess；执行真实函数体，平台与连接端口在本边界注入。 */
async function loadHostSource() {
  const file = new URL("../src/host/index.ts", import.meta.url);
  return ts.createSourceFile(
    file.pathname,
    await readFile(file, "utf8"),
    ts.ScriptTarget.Latest,
    true,
  );
}

function compile(source: string) {
  return ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022 } })
    .outputText;
}

interface RemoteServices {
  generation: number;
  clientConfig?: object;
}
interface ReconnectEvent {
  sourceServerId: string;
  serverInfo: { serverId: string; capabilities: { processResourceTelemetry?: boolean } };
  services: RemoteServices;
}
interface RemoteHandle {
  services: RemoteServices;
  onDidReconnect(listener: () => void): void;
  dispose(): Promise<void>;
}

describe("Window Host 的 Source 重连与数据库启动整合", () => {
  it.each([true, false, undefined])(
    "Source 遥测初始声明为 %s 时按能力门控，重连换代刷新能力并释放旧订阅",
    async (initialTelemetryCapability) => {
      const source = await loadHostSource();
      const node = source.statements.find(
        (item): item is ts.FunctionDeclaration =>
          ts.isFunctionDeclaration(item) &&
          item.name?.text === "createWindowRemoteConnectionHandle",
      );
      if (!node) throw new Error("Host connection factory is missing");
      const registrations: {
        generation: number;
        disposed: boolean;
        config?: object;
        telemetrySupported: boolean;
      }[] = [];
      let reconnect: ((event: ReconnectEvent) => void) | undefined;
      const info = {
        serverId: "source-1",
        capabilities: { processResourceTelemetry: initialTelemetryCapability },
      };
      const reconnectedInfo = {
        serverId: "source-1",
        capabilities: { processResourceTelemetry: true },
      };
      const clientConfig = { config: "host" };
      const remoteAgent = {
        updateDesktopBrowserControl: async () => {},
        onDynamicDesktopBrowserCommandRequest: () => () => ({ dispose() {} }),
      };
      const manager = {
        connect: async () => ({
          services: { generation: 1, codezAgentService: remoteAgent },
          serverInfo: info,
          sourceServerId: "source-1",
        }),
        onDidChangeState: () => ({ dispose() {} }),
        onDidInvalidateConnection: () => ({ dispose() {} }),
        onDidReconnect: (listener: (event: ReconnectEvent) => void) => {
          reconnect = listener;
          return { dispose() {} };
        },
      };
      const createHandle = runInNewContext(
        `${compile(node.getText(source))};createWindowRemoteConnectionHandle;`,
        {
          connectSourceServerTarget,
          buildRemoteEnvironmentKey,
          nativeBrowserCuaMcpState: {
            brokerTarget: () => undefined,
            subscribe: () => () => {},
          },
          activeServices: { get: () => clientConfig },
          IClientConfigService: {},
          sourceServerDirectory: {
            ensureProfile: async () => ({ profileId: "profile-1" }),
            snapshot: async () => ({ servers: [] }),
          },
          ensureSourceServerConnectionManager: async () => manager,
          sourceServerDisplayNameById: new Map(),
          parentPort: {},
          logger: { warn() {} },
          remoteMediaRangePreviewEnabled: false,
          createServerRemoteWorkspaceServiceCollection: (params: {
            connectionServices: RemoteServices;
            clientConfigService: object;
          }) => ({
            generation: params.connectionServices.generation,
            clientConfig: params.clientConfigService,
          }),
          resolveResourceTelemetryEnvironmentKey: () => "environment",
          registerHostServiceResourceTelemetry: (params: {
            services: RemoteServices;
            telemetrySupported: boolean;
          }) => {
            const registration = {
              generation: params.services.generation,
              disposed: false,
              config: params.services.clientConfig,
              telemetrySupported: params.telemetrySupported,
            };
            registrations.push(registration);
            return {
              dispose() {
                registration.disposed = true;
              },
            };
          },
          disposeHostRemoteConnection: async (connection: { dispose(): void }) =>
            connection.dispose(),
        },
      ) as (params: {
        target: { kind: "ssh"; host: string; username: string };
        signal: AbortSignal;
        remoteAssets: object;
      }) => Promise<RemoteHandle>;
      const handle = await createHandle({
        target: { kind: "ssh", host: "example.test", username: "dev" },
        signal: new AbortController().signal,
        remoteAssets: {},
      });
      const generations: number[] = [];
      handle.onDidReconnect(() => generations.push(handle.services.generation));
      reconnect?.({
        sourceServerId: "source-1",
        serverInfo: reconnectedInfo,
        services: { generation: 2, codezAgentService: remoteAgent },
      });

      expect(generations).toEqual([2]);
      expect(registrations).toEqual([
        {
          generation: 1,
          disposed: true,
          config: clientConfig,
          telemetrySupported: initialTelemetryCapability === true,
        },
        { generation: 2, disposed: false, config: clientConfig, telemetrySupported: true },
      ]);
      await handle.dispose();
      expect(registrations.every((registration) => registration.disposed)).toBe(true);
      reconnect?.({
        sourceServerId: "source-1",
        serverInfo: reconnectedInfo,
        services: { generation: 3 },
      });
      expect(handle.services.generation).toBe(2);
      expect(registrations).toHaveLength(2);
    },
  );

  it("数据库准备前不创建业务服务；Source 初始化保留但后台迁移不阻塞 base attachment 和 ready", async () => {
    const source = await loadHostSource();
    let initNode: ts.IfStatement | undefined;
    function findInit(node: ts.Node): void {
      if (
        ts.isIfStatement(node) &&
        node.expression.getText(source) === "msg.type === HostMessageTypes.InitLocal"
      ) {
        initNode = node;
      } else {
        ts.forEachChild(node, findInit);
      }
    }
    findInit(source);
    if (!initNode) throw new Error("Host InitLocal handler is missing");
    const events: string[] = [];
    const { promise: prepared, resolve: finishPreparation } = Promise.withResolvers<void>();
    const services = {
      getOptional: () => undefined,
      get: () => ({ get: async () => ({ remoteStartupAutoReconnectEnabled: false }) }),
      register() {
        return this;
      },
    };
    const createLocalServices = vi.fn((params: { resolveBotProjectConnection: unknown }) => {
      events.push("local-services");
      expect(params.resolveBotProjectConnection).toBeTypeOf("function");
      return services;
    });
    const run = runInNewContext(
      `${compile(`async function run() { ${initNode.getText(source)} }`)};run;`,
      {
        databaseStartup: undefined,
        // 上游 3.17.1 的 InitLocal handler 开头会把 msg.browserBackendIdentity 写回模块级 let；
        // 抽出来的 handler 在新上下文里执行，缺这个绑定会直接 ReferenceError，
        // 后续 createHostDatabaseStartup / createLocalServices 全都不会发生。
        browserBackendIdentity: undefined,
        // 同理：上游在 initializeServices 里新增注册「数据同步状态」与「provider provisioning 状态」，
        // 这两个 token、工厂与模块级状态都不在抽取出的 handler 作用域内，必须显式注入，
        // 否则启动屏障（数据库准备前不创建业务服务）根本走不到断言点。
        IDeviceSyncStateService: "IDeviceSyncStateService",
        IProviderProvisioningStatusService: "IProviderProvisioningStatusService",
        createDeviceSyncStateService: () => ({}),
        hostProviderProvisioningStatus: { service: {} },
        getAppConfigDir: () => "/config",
        join: (...parts: string[]) => parts.join("/"),
        nativeBrowserCuaMcpState: { set() {}, get: () => undefined },
        activeSessionRealtimePort: null,
        activeServices: null,
        activeHostApiNetworkTransport: null,
        sourceServerDirectory: null,
        sourceServerArtifactPolicy: null,
        sourceServerConnectionManager: null,
        sourceServerManagementService: null,
        sourceSettingsStateSubscription: null,
        hasDisposedHostResources: false,
        disposeHostResourcesInFlight: null,
        msg: { type: "init-local", remoteAssets: {} },
        HostMessageTypes: { InitLocal: "init-local" },
        HostResponseTypes: { DatabaseStartupState: "db-state" },
        port: { once() {}, close() {} },
        logger: { info() {}, warn() {}, error() {} },
        pendingStartupAttachments: new Map(),
        parentPort: {
          postMessage: (message: { state: { phase: string } }) => events.push(message.state.phase),
        },
        process,
        createHostDatabaseStartup: (options: {
          initializeServices(): Promise<void>;
          publish(state: { phase: string }): void;
        }) => ({
          coordinator: {
            start: async () => {
              events.push("prepare");
              await prepared;
              await options.initializeServices();
              options.publish({ phase: "ready" });
            },
          },
        }),
        createTaskRealtimeBridgeForHostInit: () => null,
        createE2ERepoWikiGenerationFixtureFromEnv: () => undefined,
        // 同理：initializeServices 现在会解构 setWorkspaceProjection，并立刻
        // void settingService.get() 读取持久化语言作为 X-Client-Language 兜底；
        // 桩必须给出可调用的 get，否则启动屏障在 initializeServices 处直接 TypeError。
        createSettingServiceWithMigrations: () => ({
          service: { get: async () => ({}) },
          prepareLegacyAccountConnections() {},
          setWorkspaceProjection() {},
        }),
        // 同理：initializeServices 现在把模块级函数 shareCredentialKeyWithDataRoot 作为依赖
        // 传给 createSettingServiceWithMigrations（数据目录迁移时共享凭据密钥）。抽出来的
        // handler 在新上下文里没有这个模块绑定，求值实参就会 ReferenceError。
        shareCredentialKeyWithDataRoot: async () => {},
        // 同理：initializeServices 会把持久化语言写回模块级 let persistedApplicationLocale，
        // establishOwner 里还要用预装工具目录解析链（dataRoot + release + runtimeEnv + flavor）。
        // 这些都是 index.ts 的模块级绑定，抽取出的 handler 在新上下文里必须显式注入。
        persistedApplicationLocale: undefined,
        getCodezDataRootDir: () => "/data-root",
        resolveCodezRuntimeEnv: () => ({}),
        resolvePreinstalledToolsRelease: () => "production",
        resolvePreinstalledToolsBinDir: () => "/data-root/bin",
        CODEZ_PRODUCT_FLAVOR: "production",
        createHostApiNetworkTransport: () => ({ fetch() {} }),
        initializeHostApiNetworkTransportOwner: async (params: { establishOwner(): unknown }) =>
          params.establishOwner(),
        createLocalServices,
        resolveBotProjectConnection() {},
        authorizeLocalMediaPreviewPath() {},
        runtimeProcessLifecycleReporter: {},
        runtimeTaskReporter: {},
        repoWikiTaskReporter: {},
        createFullFeedbackLogArchiveViaMain() {},
        dispatchManualAutomationRun() {},
        browserControlMainBridge: {},
        cuaOperationStateReporter: {},
        pluginSandboxRegistrationBridge: { register() {} },
        ICodezTaskService: {},
        ISettingService: {},
        ICredentialService: {},
        ISourceServerManagementService: {},
        IRemoteProjectService: {},
        createRemoteProjectConnectionAdmission: () => async () => {},
        notifyProjectChange() {},
        runStartupReconnectBatch,
        SourceServerDirectory: class {
          constructor() {
            events.push("source-directory");
          }
          initialize() {
            events.push("source-background");
            return new Promise(() => {});
          }
        },
        SourceServerConnectionManager: class {
          constructor() {
            events.push("source-manager");
          }
          onDidChangeState() {
            return { dispose() {} };
          }
        },
        createSourceServerManagementService: () => ({}),
        wireLocalResourceTelemetry() {
          events.push("local-telemetry");
        },
        windowHostAttachmentRegistry: {
          attach() {
            events.push("base-attachment");
          },
        },
        randomUUID: () => "id",
        logWindowHostTopology() {},
        // 同理：InitLocal handler 的 establishOwner/createLocalServices 参数表还引用了一批
        // index.ts 模块级绑定（项目身份登记、扩展宿主、App Control 发现、远端项目身份解析等）。
        // 本用例只验证「数据库准备前不创建业务服务 + Source 初始化不阻塞 base attachment/ready」
        // 的启动屏障顺序，因此给惰性桩，避免逐个 ReferenceError 打断在断言点之前。
        appControlNavigation: null,
        // createLocalServices 会把 credentialCipherBridge.cipher 作为 credentialCipherProvider 传入。
        credentialCipherBridge: { cipher: {}, dispose() {}, receive() {} },
        managerProjectIdentityRegistrations: new Map(),
        registryProjectIdentityRegistrations: new Map(),
        quitBlockerReporter: {},
        replyLanguage: undefined,
        windowHostControllerRuntime: {
          readTaskRows: async () => [],
          subscribeTaskRows: () => ({ dispose() {} }),
        },
        windowHostExtensions: null,
        windowRemoteConnectionRegistry: {
          connectSource: async () => undefined,
          getOnlineSource: () => undefined,
          listConnections: () => [],
          listSessions: () => [],
        },
        ICodezAgentService: {},
        IExtensionGrantsService: {},
        IExtensionViewsService: {},
        IExtensionsService: {},
        IModelSelectionService: {},
        IPluginManagementService: {},
        IProjectService: {},
        bindRemoteProjectIdentities: () => {},
        buildRemoteHostWorkspaceIdentity: () => "",
        buildServerRemoteWorkspaceIdentity: () => "",
        createAppControlDiscoverySourceResolver: () => () => undefined,
        createReportingRemoteCodezTaskService: () => ({}),
        // handler 里 windowHostExtensions = createWindowHostExtensions(...)，随后调用
        // announceReady()（服务就绪后请 Main 牵线扩展进程），桩必须带这个方法。
        createWindowHostExtensions: () => ({
          announceReady() {},
          service: {},
          grantsService: {},
          viewsService: {},
          dispose() {},
        }),
        findRemoteProjectHostIdForProfile: () => undefined,
        getPluginUserOptionsReader: () => async () => ({}),
        parseRemoteWorkspaceIdentity: () => undefined,
        pushDynamicWorkflowUserModeToRemoteHosts: async () => {},
        releaseRemoteProjectProfileHost: async () => {},
        remoteHostIdFromWorkspaceIdentity: () => undefined,
        remoteProjectHostIdForProfile: () => "",
        remoteProjectHostIdForTarget: () => "",
        resolveBotRemoteWorkspace: () => undefined,
        resolveHostClientLanguage: () => undefined,
        resolveServerProjectService: () => undefined,
        resolveSourceServerReleaseAsset: () => undefined,
        shouldDetachSourceSettingsAttachment: () => false,
        warmUpCodezAgent: async () => {},
      },
    ) as () => Promise<void>;
    const complete = run();
    expect(createLocalServices).not.toHaveBeenCalled();
    expect(events).toEqual(["prepare"]);
    finishPreparation();
    await complete;
    expect(createLocalServices).toHaveBeenCalledOnce();
    expect(events).toEqual([
      "prepare",
      "local-services",
      "source-directory",
      "source-manager",
      "local-telemetry",
      "base-attachment",
      "source-background",
      "ready",
    ]);
  });
});
