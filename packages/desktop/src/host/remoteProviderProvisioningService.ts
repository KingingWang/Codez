import { randomUUID } from "node:crypto";
import {
  providerProvisioningErrorCodeSchema,
  type ProviderProvisioningResult,
  type ProviderProvisioningErrorCode,
  type CodexNativeProviderKeyEntry,
} from "@codez/shared";
import type {
  ICredentialService,
  IProviderProvisioningTargetService,
  IServiceAccessor,
} from "@codez/services";
import {
  getProviderProvisioningSource,
  codexNativeProviderKeyCredentialKey,
  readCodexNativeProviderKeyEntries,
  type ProviderProvisioningSource,
} from "@codez/services/node";
import type { ServiceCollection } from "@codez/services";

export interface RemoteProviderProvisioningExecutor {
  syncLocalToRemote(): Promise<ProviderProvisioningResult>;
  installLocalRuntimeKeys(): Promise<void>;
  /** Codex 原生临时 Key：进入本连接的轮换屏障（停止旧 Agent、托管供应商 fail-closed）。 */
  beginCodexKeyRotation(): Promise<void>;
  /** Codex 原生临时 Key：现读本机注册表+凭据安装到远端内存并解除屏障。 */
  installCodexRuntimeKeys(): Promise<void>;
}

const executors = new WeakMap<ServiceCollection, RemoteProviderProvisioningExecutor>();

/** Window Host 私有执行能力；不会随 ServiceCollection 暴露到 Renderer RPC。 */
export function getRemoteProviderProvisioningExecutor(
  services: ServiceCollection,
): RemoteProviderProvisioningExecutor | undefined {
  return executors.get(services);
}

export function registerRemoteProviderProvisioningExecutor(
  services: ServiceCollection,
  executor: RemoteProviderProvisioningExecutor,
): void {
  executors.set(services, executor);
}

export function createRemoteProviderProvisioningExecutor(options: {
  source?: ProviderProvisioningSource;
  target?: IProviderProvisioningTargetService;
  /** Server remote owns its own runtime; only SSH/WSL/Docker accept ephemeral keys. */
  allowRuntimeApiKeys?: boolean;
  /**
   * Codex 原生临时 Key 的本机读取面（spec: codex-provider-runtime-env-key）。
   * Key 值只在本 Host 现读现传，不经 Main 或其它窗口。
   */
  codexKeys?: {
    environmentKey: string;
    credentialService: Pick<ICredentialService, "load">;
  };
}): RemoteProviderProvisioningExecutor {
  let runtimeKeysInstalled = false;
  let codexKeysInstalled = false;
  let runtimeKeyInstallTail = Promise.resolve();
  let codexKeyTail = Promise.resolve();
  const syncLocalToRemote = async (): Promise<ProviderProvisioningResult> => {
    const syncId = randomUUID();
    if (!options.source || !options.target) {
      return unsupportedResult(syncId, "Local/Remote Provider Provisioning capability 不可用");
    }
    let errorCode: ProviderProvisioningErrorCode = "source-read-failed";
    try {
      const envelope = await options.source.read(syncId);
      if (options.allowRuntimeApiKeys === false && envelope.schemaVersion === 3) {
        return unsupportedResult(syncId, "Server remote 不支持临时环境变量 Key");
      }
      errorCode = "target-call-failed";
      const { errorCode: remoteErrorCode, ...result } = await options.target.apply(envelope);
      // 成功结果不携带诊断字段，避免未知错误码使 Main 丢弃本已成功的回包。
      if (result.status === "applied" || result.status === "already-applied") return result;
      // 旧目标没有阶段码，任意远端也可能返回自由文本；只能透传本地 allowlist。
      const parsedCode = providerProvisioningErrorCodeSchema.safeParse(remoteErrorCode);
      return {
        ...result,
        errorCode: parsedCode.success ? parsedCode.data : "target-apply-failed",
      };
    } catch (error) {
      return {
        syncId,
        status: "failed",
        personalProviderCount: 0,
        credentialCount: 0,
        errorMessage: error instanceof Error ? error.message : String(error),
        errorCode,
        rolledBack: true,
      } satisfies ProviderProvisioningResult;
    }
  };

  const installCurrentRuntimeKeys = async (): Promise<void> => {
    if (!options.source || !options.target) {
      throw new Error("Local/Remote Provider Provisioning capability 不可用");
    }
    if (
      options.allowRuntimeApiKeys === false &&
      (await options.source.read(randomUUID())).schemaVersion === 3
    ) {
      throw new Error("Server remote 不支持临时环境变量 Key");
    }
    const installation = await options.source.readRuntimeApiKeys();
    // 配置文件模式首连兼容旧 Target；曾安装临时 Key 的在线连接仍须发送空集合清除内存。
    if (installation.keys.length === 0 && !runtimeKeysInstalled) return;
    if (!options.target.installRuntimeApiKeys) {
      throw new Error("远端不支持临时环境变量 Key");
    }
    await options.target.installRuntimeApiKeys(installation);
    runtimeKeysInstalled = installation.keys.length > 0;
  };
  const installLocalRuntimeKeys = (): Promise<void> => {
    // Source 现读必须也在串行区内；否则早一次远端 RPC 的迟到完成可覆盖新 Key。
    const operation = runtimeKeyInstallTail.then(installCurrentRuntimeKeys);
    runtimeKeyInstallTail = operation.catch(() => undefined);
    return operation;
  };

  const readCodexKeyPayload = async (): Promise<CodexNativeProviderKeyEntry[]> => {
    const codexKeys = options.codexKeys;
    if (!codexKeys) throw new Error("当前 Environment 不支持 Codex 临时 Key");
    const entries = await readCodexNativeProviderKeyEntries(codexKeys.environmentKey);
    const keys: CodexNativeProviderKeyEntry[] = [];
    for (const [providerId, entry] of Object.entries(entries)) {
      // 缺凭据不是错误：发送 null，让远端显式屏蔽继承变量并 fail-closed 该供应商。
      const value =
        (
          await codexKeys.credentialService.load(
            codexNativeProviderKeyCredentialKey(codexKeys.environmentKey, providerId),
          )
        )?.trim() || null;
      keys.push({ providerId, envName: entry.envName, value });
    }
    return keys;
  };

  const beginCodexKeyRotation = (): Promise<void> => {
    const operation = codexKeyTail.then(async () => {
      if (!options.codexKeys) throw new Error("当前 Environment 不支持 Codex 临时 Key");
      const target = options.target;
      if (!target || typeof target.beginCodexProviderKeyRotation !== "function") {
        // 首次保存时注册表尚无条目，不能用「当前无托管引用」放行；屏障建立必须显式可用。
        throw new Error("远端 Codez 版本过旧，不支持 Codex 临时 Key，请升级远端");
      }
      try {
        await target.beginCodexProviderKeyRotation();
      } catch (error) {
        if (isLegacyCodexKeyCapabilityMissingError(error)) {
          throw new Error("远端 Codez 版本过旧，不支持 Codex 临时 Key，请升级远端", {
            cause: error,
          });
        }
        throw error;
      }
    });
    codexKeyTail = operation.catch(() => undefined);
    return operation;
  };

  const installCodexRuntimeKeys = (): Promise<void> => {
    // 读取注册表与凭据必须在串行区内，保证安装的是本次事务最新事实。
    const operation = codexKeyTail.then(async () => {
      // Server remote 等无本机读取面的连接：无托管事实可安装，静默 no-op。
      if (!options.codexKeys) return;
      const keys = await readCodexKeyPayload();
      // 首连/重连且本连接从未安装过 Codex 临时 Key 时，空集合不触发远端 RPC，兼容旧 Target。
      if (keys.length === 0 && !codexKeysInstalled) return;
      const target = options.target;
      if (!target || typeof target.installCodexProviderKeys !== "function") {
        codexKeysInstalled = false;
        return;
      }
      try {
        await target.installCodexProviderKeys({ keys });
        codexKeysInstalled = keys.length > 0;
      } catch (error) {
        // Bugfix: ProxyChannel.toService 对任意方法名都会构造代理函数，旧版或上游构建的远端
        // codez-server 缺少 installCodexProviderKeys 时会在首连第 3 步抛 Method not found，
        // 导致整个远程工作区连接与新建会话被拒绝。远端缺该能力时内存中本就不会持有任何临时 Key，
        // 首连/同步阶段降级跳过安装以保证工作区和设置页可打开；主动保存仍由 beginCodexKeyRotation 拦截。
        if (isLegacyCodexKeyCapabilityMissingError(error)) {
          codexKeysInstalled = false;
          return;
        }
        throw error;
      }
    });
    codexKeyTail = operation.catch(() => undefined);
    return operation;
  };

  return {
    syncLocalToRemote,
    installLocalRuntimeKeys,
    beginCodexKeyRotation,
    installCodexRuntimeKeys,
  };
}

export function createRemoteProviderProvisioningExecutorFromWorkspace(options: {
  connectionServices: IServiceAccessor;
  sourceServices?: ServiceCollection;
  allowRuntimeApiKeys?: boolean;
  codexKeys?: {
    environmentKey: string;
    credentialService: Pick<ICredentialService, "load">;
  };
}): RemoteProviderProvisioningExecutor {
  const source = options.sourceServices
    ? getProviderProvisioningSource(options.sourceServices)
    : undefined;
  const target = (
    options.connectionServices as IServiceAccessor & {
      providerProvisioningTargetService?: IProviderProvisioningTargetService;
    }
  ).providerProvisioningTargetService;
  return createRemoteProviderProvisioningExecutor({
    source,
    target,
    allowRuntimeApiKeys: options.allowRuntimeApiKeys,
    codexKeys: options.codexKeys,
  });
}

function unsupportedResult(syncId: string, errorMessage: string): ProviderProvisioningResult {
  return {
    syncId,
    status: "unsupported",
    personalProviderCount: 0,
    credentialCount: 0,
    errorMessage,
    errorCode: "capability-unavailable",
    rolledBack: false,
  };
}

function isLegacyCodexKeyCapabilityMissingError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return (
    message.includes("Method not found: beginCodexProviderKeyRotation") ||
    message.includes("Method not found: installCodexProviderKeys") ||
    message.includes("Unknown channel: provider-provisioning-target") ||
    message.includes("远端不支持 Codex 临时 Key")
  );
}
