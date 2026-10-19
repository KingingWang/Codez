import {
  ProviderConfigService,
  type ProviderConfigLayerSnapshot,
  type ProviderConfigLayerUpdate,
} from "@codez/provider";
import { NodeCodezBuiltinProviderConfigSource } from "./codez-builtin-provider-config-source.js";
import {
  EndpointScopedCodezBuiltinSource,
  type EndpointScopedCodezBuiltinSourceOptions,
} from "./endpoint-scoped-codez-builtin-source.js";
import {
  CodezBuiltinRemoteSynchronizer,
  type CodezBuiltinRemoteSynchronizerOptions,
  type CodezBuiltinRefreshResult,
} from "./codez-builtin-remote-synchronizer.js";
import {
  NodePersonalProviderConfigRepository,
  type PersonalProviderConfigRecoveryEvent,
} from "./personal-provider-config-repository.js";

export interface NodeProviderConfigRuntimeOptions {
  readonly codezBuiltinFilePath: string;
  readonly codezBuiltinActiveFilePath?: string;
  readonly codezBuiltinRemote?: Omit<CodezBuiltinRemoteSynchronizerOptions, "source">;
  readonly codezBuiltinEnvironment?: Omit<
    EndpointScopedCodezBuiltinSourceOptions,
    "bundledFilePath"
  >;
  readonly onCodezBuiltinRefreshError?: (error: unknown) => void;
  readonly onPersonalConfigRecovery?: (event: PersonalProviderConfigRecoveryEvent) => void;
  readonly onPersonalConfigPollingError?: (error: unknown) => void;
  readonly personalFilePath: string;
  readonly personalPollingIntervalMs?: number | false;
  readonly importLegacy?: (
    codezBuiltin: ProviderConfigLayerSnapshot,
  ) => Promise<ProviderConfigLayerUpdate | null>;
  readonly watch?: boolean;
}

/** 组装一个 Node.js 进程内共享的 Codez Built-in/Personal Config 运行边界。 */
export class NodeProviderConfigRuntime {
  readonly configService: ProviderConfigService;
  readonly #codezBuiltinSource:
    | NodeCodezBuiltinProviderConfigSource
    | EndpointScopedCodezBuiltinSource;
  readonly #personalRepository: NodePersonalProviderConfigRepository;
  readonly #remoteSynchronizer?: CodezBuiltinRemoteSynchronizer;
  readonly #onRemoteRefreshError?: (error: unknown) => void;
  #startPromise: Promise<void> | null = null;
  #disposed = false;
  readonly #checkListeners = new Set<() => Promise<void>>();
  #checkTimer: ReturnType<typeof setInterval> | null = null;
  #checkInFlight: Promise<void> | null = null;

  constructor(options: NodeProviderConfigRuntimeOptions) {
    this.#codezBuiltinSource = options.codezBuiltinEnvironment
      ? new EndpointScopedCodezBuiltinSource({
          bundledFilePath: options.codezBuiltinFilePath,
          ...options.codezBuiltinEnvironment,
        })
      : new NodeCodezBuiltinProviderConfigSource({
          bundledFilePath: options.codezBuiltinFilePath,
          activeFilePath: options.codezBuiltinActiveFilePath,
          watch: options.watch,
        });
    this.#remoteSynchronizer =
      options.codezBuiltinRemote &&
      this.#codezBuiltinSource instanceof NodeCodezBuiltinProviderConfigSource
        ? new CodezBuiltinRemoteSynchronizer({
            source: this.#codezBuiltinSource,
            ...options.codezBuiltinRemote,
          })
        : undefined;
    this.#onRemoteRefreshError = options.onCodezBuiltinRefreshError;
    this.#personalRepository = new NodePersonalProviderConfigRepository({
      filePath: options.personalFilePath,
      onRecovery: options.onPersonalConfigRecovery,
      onPollingError: options.onPersonalConfigPollingError,
      pollingIntervalMs: options.personalPollingIntervalMs,
      ...(options.importLegacy
        ? {
            importLegacy: async () => options.importLegacy!(await this.#codezBuiltinSource.read()),
          }
        : {}),
    });
    this.configService = new ProviderConfigService({
      codezBuiltinSource: this.#codezBuiltinSource,
      personalRepository: this.#personalRepository,
    });
  }

  resolveCodezBuiltinActiveFilePath(): Promise<string> {
    return this.#codezBuiltinSource instanceof NodeCodezBuiltinProviderConfigSource
      ? Promise.resolve(this.#codezBuiltinSource.activeFilePath)
      : this.#codezBuiltinSource.resolveActiveFilePath();
  }

  get personalRepository(): import("@codez/provider").PersonalProviderConfigRepository {
    return this.#personalRepository;
  }

  /** Environment 同一周期检查中恢复未对齐依赖，不被下载 TTL 或失败挡住。 */
  onDidCheckCodezBuiltin(listener: () => Promise<void>): () => void {
    this.#checkListeners.add(listener);
    return () => this.#checkListeners.delete(listener);
  }

  start(): Promise<void> {
    if (this.#disposed) throw new Error("NodeProviderConfigRuntime 已 dispose");
    if (this.#startPromise) return this.#startPromise;
    const startPromise = this.configService.read().then(() => {
      if (this.#disposed) return;
      void this.#checkBackground();
      // Managed Worker 无下载配置也无恢复 owner，不建立周期任务。
      if (
        this.#remoteSynchronizer ||
        this.#codezBuiltinSource instanceof EndpointScopedCodezBuiltinSource ||
        this.#checkListeners.size > 0
      ) {
        this.#checkTimer = setInterval(() => {
          void this.#checkBackground();
        }, 60_000);
        this.#checkTimer.unref?.();
      }
    });
    this.#startPromise = startPromise;
    void startPromise.catch(() => {
      if (this.#startPromise === startPromise) this.#startPromise = null;
    });
    return startPromise;
  }

  refreshCodezBuiltin(options?: { readonly force?: boolean }): Promise<CodezBuiltinRefreshResult> {
    if (this.#disposed) return Promise.resolve("disposed");
    if (this.#codezBuiltinSource instanceof EndpointScopedCodezBuiltinSource) {
      return this.#codezBuiltinSource.refresh(options);
    }
    return this.#remoteSynchronizer?.refresh(options) ?? Promise.resolve("skipped");
  }

  #checkBackground(): Promise<void> {
    if (this.#disposed) return Promise.resolve();
    if (this.#checkInFlight) return this.#checkInFlight;
    const check = Promise.allSettled([
      this.refreshCodezBuiltin(),
      ...[...this.#checkListeners].map((listener) => Promise.resolve().then(listener)),
    ])
      .then((results) => {
        if (this.#disposed) return;
        for (const result of results)
          if (result.status === "rejected") this.#onRemoteRefreshError?.(result.reason);
      })
      .finally(() => {
        if (this.#checkInFlight === check) this.#checkInFlight = null;
      });
    this.#checkInFlight = check;
    return check;
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    if (this.#checkTimer) clearInterval(this.#checkTimer);
    this.#checkTimer = null;
    this.#checkListeners.clear();
    this.#remoteSynchronizer?.dispose();
    this.configService.dispose();
    this.#personalRepository.dispose();
    this.#codezBuiltinSource.dispose();
  }
}

export function createNodeProviderConfigRuntime(
  options: NodeProviderConfigRuntimeOptions,
): NodeProviderConfigRuntime {
  return new NodeProviderConfigRuntime(options);
}
