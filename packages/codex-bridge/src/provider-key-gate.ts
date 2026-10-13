import { CODEZ_CODEX_BLOCKED_PROVIDER_IDS_ENV_KEY } from "@codez/shared";
import type { CodexRpcPort } from "./contract.js";

/**
 * Codex 原生自定义供应商「本机临时 Key」的模型请求门禁
 * （spec: specs/codex-provider-runtime-env-key.md）。
 *
 * Host 在 spawn 时把「引用了 App 托管 env_key 但本机凭据缺失/轮换中」的供应商 id
 * 注入进程环境；本门禁在 turn 准入时 fail-closed，保证缺 Key 的供应商在任何模型
 * 网络请求之前就被拒绝，而不是依赖原生运行时的环境变量缺失报错。
 * 进程环境对共享 OS 账户不是隔离边界；这里只负责「未安装不发起请求」。
 */
export interface CodexProviderKeyGate {
  /** providerId 缺省时回退到 config.toml 的默认 model_provider（带缓存）。 */
  assertTurnAllowed(providerId: string | undefined): Promise<void>;
  /** 本进程完成 config 写入后调用；缓存的默认供应商随之失效。 */
  invalidateConfig(): void;
}

export function parseBlockedCodexProviderIds(
  env: NodeJS.ProcessEnv = process.env,
): ReadonlySet<string> {
  const raw = env[CODEZ_CODEX_BLOCKED_PROVIDER_IDS_ENV_KEY]?.trim();
  if (!raw) return new Set();
  return new Set(
    raw
      .split(",")
      .map((id) => id.trim())
      .filter(Boolean),
  );
}

export function createCodexProviderKeyGate(options: {
  rpc: CodexRpcPort;
  blockedProviderIds: ReadonlySet<string>;
}): CodexProviderKeyGate {
  let defaultProviderCache: Promise<string | undefined> | undefined;
  const readDefaultProvider = (): Promise<string | undefined> => {
    defaultProviderCache ??= options.rpc
      .request("config/read")
      .then((response) => {
        const config = (
          response as { config?: Record<string, unknown> } | undefined
        )?.config;
        const id = config?.model_provider;
        return typeof id === "string" && id.trim() ? id.trim() : undefined;
      })
      .catch(() => undefined);
    return defaultProviderCache;
  };
  return {
    async assertTurnAllowed(providerId) {
      if (options.blockedProviderIds.size === 0) return;
      const id = providerId?.trim() || (await readDefaultProvider());
      if (id && options.blockedProviderIds.has(id)) {
        throw new Error(
          `The API key for model provider "${id}" is stored on this desktop but not installed ` +
            `in this environment yet. Open Settings → Codex → Providers to enter it, then retry.`,
        );
      }
    },
    invalidateConfig() {
      defaultProviderCache = undefined;
    },
  };
}
