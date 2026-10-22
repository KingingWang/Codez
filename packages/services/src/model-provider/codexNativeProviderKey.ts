/* eslint-disable max-lines -- 注册表、凭据与保存事务的不变量集中在同一模块，拆开会让回滚路径失真。 */
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parse as parseToml } from "smol-toml";
import { atomicWritePrivateTextFile, withFileLock } from "@codez/shared/node";
import {
  CODEX_NATIVE_PROVIDER_KEY_ENV_PREFIX,
  type CodexNativeProviderKeyEntry,
} from "@codez/shared";
import type { ICredentialService } from "../credential/credential.js";
import { getAppConfigDir } from "../paths.js";
import { createServiceLogger } from "../logger/serviceLogger.js";
import type { ICodexNativeProviderKeyService } from "./codexNativeProviderKeyService.js";

const logger = createServiceLogger("codex-native-provider-key");

/** 本地 Environment 的固定身份；远端用 buildRemoteEnvironmentKey(target)。 */
export const CODEX_NATIVE_PROVIDER_LOCAL_ENVIRONMENT_KEY = "local";

const REGISTRY_FILE_NAME = "codex-native-provider-keys.json";
const REGISTRY_SCHEMA_VERSION = 1 as const;

function shortHash(input: string): string {
  return createHash("sha256")
    .update(input)
    .digest("hex")
    .slice(0, 16)
    .toUpperCase();
}

/** 变量名只由 providerId 派生：同一供应商在任意 Environment 中同名，进程彼此隔离。 */
export function codexNativeProviderKeyEnvName(providerId: string): string {
  return `${CODEX_NATIVE_PROVIDER_KEY_ENV_PREFIX}${shortHash(providerId)}`;
}

export function codexNativeProviderKeyCredentialKey(
  environmentKey: string,
  providerId: string,
): string {
  return `codex-native-provider-key:${shortHash(environmentKey)}:${providerId}`;
}

interface RegistryFile {
  schemaVersion: typeof REGISTRY_SCHEMA_VERSION;
  /** key = shortHash(environmentKey)，避免把含分隔符的远端身份直接写进 JSON 键。 */
  environments: Record<string, Record<string, { envName: string }>>;
}

function emptyRegistry(): RegistryFile {
  return { schemaVersion: REGISTRY_SCHEMA_VERSION, environments: {} };
}

function registryFilePath(): string {
  return join(getAppConfigDir(), REGISTRY_FILE_NAME);
}

function parseRegistry(raw: string): RegistryFile {
  const value = JSON.parse(raw) as unknown;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("registry root must be an object");
  }
  const record = value as Record<string, unknown>;
  if (record.schemaVersion !== REGISTRY_SCHEMA_VERSION) {
    throw new Error(
      `unsupported registry schemaVersion: ${String(record.schemaVersion)}`,
    );
  }
  const environments = record.environments;
  if (
    typeof environments !== "object" ||
    environments === null ||
    Array.isArray(environments)
  ) {
    throw new Error("registry environments must be an object");
  }
  for (const providers of Object.values(
    environments as Record<string, unknown>,
  )) {
    if (
      typeof providers !== "object" ||
      providers === null ||
      Array.isArray(providers)
    ) {
      throw new Error("registry environment entry must be an object");
    }
    for (const entry of Object.values(providers as Record<string, unknown>)) {
      const envName = (entry as Record<string, unknown>)?.envName;
      if (
        typeof envName !== "string" ||
        !envName.startsWith(CODEX_NATIVE_PROVIDER_KEY_ENV_PREFIX)
      ) {
        throw new Error("registry provider entry has invalid envName");
      }
    }
  }
  return record as unknown as RegistryFile;
}

async function readRegistry(
  filePath = registryFilePath(),
): Promise<RegistryFile> {
  let raw: string;
  try {
    raw = await readFile(filePath, "utf-8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT")
      return emptyRegistry();
    throw error;
  }
  try {
    return parseRegistry(raw);
  } catch (error) {
    // 与 Credential Store 同策略：损坏时拒绝自动覆盖，避免误丢其它 Environment 的引用。
    logger.warn(
      undefined,
      "codex native provider key registry is corrupt; refusing to rewrite",
      {
        message: error instanceof Error ? error.message : String(error),
      },
    );
    throw new Error(`Codex provider key registry is corrupt: ${filePath}`, {
      cause: error,
    });
  }
}

async function mutateRegistry<T>(
  mutate: (file: RegistryFile) => { result: T; changed: boolean },
): Promise<T> {
  const filePath = registryFilePath();
  return withFileLock(filePath, async () => {
    const current = await readRegistry(filePath);
    const { result, changed } = mutate(current);
    if (changed) {
      await atomicWritePrivateTextFile(
        filePath,
        `${JSON.stringify(current, null, 2)}\n`,
      );
    }
    return result;
  });
}

/** 当前 Environment 下全部 App 托管引用（providerId → { envName }）。 */
export async function readCodexNativeProviderKeyEntries(
  environmentKey: string,
): Promise<Readonly<Record<string, { envName: string }>>> {
  const registry = await readRegistry();
  return { ...registry.environments[shortHash(environmentKey)] };
}

function credentialScope(environmentKey: string): string {
  return shortHash(environmentKey);
}

export interface CodexNativeProviderSpawnEnv {
  /** value 为 undefined 表示显式屏蔽继承的同名变量（Node spawn 会跳过 undefined）。 */
  env: Record<string, string | undefined>;
  blockedProviderIds: string[];
}

/**
 * 本地 spawn 边界：现读注册表与本机凭据。缺凭据时注入 undefined 并上报 blocked，
 * 既不能回退到旧明文，也不能让同名继承变量冒充 App 托管凭据。
 */
export async function resolveCodexNativeProviderSpawnEnv(options: {
  credentialService: Pick<ICredentialService, "load">;
  environmentKey: string;
}): Promise<CodexNativeProviderSpawnEnv> {
  const entries = await readCodexNativeProviderKeyEntries(
    options.environmentKey,
  );
  const env: Record<string, string | undefined> = {};
  const blockedProviderIds: string[] = [];
  for (const [providerId, entry] of Object.entries(entries)) {
    const value = (
      await options.credentialService.load(
        codexNativeProviderKeyCredentialKey(options.environmentKey, providerId),
      )
    )?.trim();
    env[entry.envName] = value || undefined;
    if (!value) blockedProviderIds.push(providerId);
  }
  return { env, blockedProviderIds };
}

/** 远端 spawn 边界：数据源是 Window Host 经可信 RPC 安装到本进程内存的事实。 */
export function codexNativeProviderSpawnEnvFromInstalled(
  installed: ReadonlyMap<string, { providerId: string; value: string | null }>,
  rotationActive: boolean,
): CodexNativeProviderSpawnEnv {
  const env: Record<string, string | undefined> = {};
  const blockedProviderIds: string[] = [];
  for (const [envName, entry] of installed) {
    env[envName] = entry.value ?? undefined;
    // 轮换期间全部托管供应商 fail-closed：旧 Agent 已停止，新进程不得携带任何旧值接单。
    if (rotationActive || !entry.value)
      blockedProviderIds.push(entry.providerId);
  }
  return { env, blockedProviderIds };
}

/**
 * 远端安装校验：只保留远端 config.toml 仍以 env_key 引用该变量的条目。
 * 配置文件缺失/条目被外部改写时引用自然失效（静默跳过），不写入任何磁盘状态。
 */
export async function filterCodexNativeKeysByConfigFile(
  keys: readonly CodexNativeProviderKeyEntry[],
  configTomlPath: string,
): Promise<CodexNativeProviderKeyEntry[]> {
  let raw: string;
  try {
    raw = await readFile(configTomlPath, "utf-8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return [];
    throw error;
  }
  const parsed = parseToml(raw) as Record<string, unknown>;
  const table = parsed.model_providers;
  if (typeof table !== "object" || table === null || Array.isArray(table))
    return [];
  const providers = table as Record<string, unknown>;
  return keys.filter((key) => {
    const entry = providers[key.providerId];
    if (typeof entry !== "object" || entry === null || Array.isArray(entry))
      return false;
    return (entry as Record<string, unknown>).env_key === key.envName;
  });
}

type Credentials = Pick<ICredentialService, "load" | "save" | "delete">;

interface PendingKeyChange {
  mode: "runtime-env" | "config-file" | "delete";
  oldCredential: string | null;
  oldRegistryEntry: { envName: string } | null;
  began: boolean;
}

export interface CodexNativeProviderKeyServiceOptions {
  environmentKey: string;
  credentialService: Credentials;
  /** 远程：Main 扇出逐连接停止旧 Agent 并拒绝新模型输入；本地为空。 */
  beginRotation?: () => Promise<void>;
  /** 提交与回滚都要调用：安装当前注册表+凭据事实并解除远程屏障。 */
  installKeys?: (commit: boolean) => Promise<void>;
  /** 本地：提交成功后重造活动 Codex runtime，让新进程读取新凭据。 */
  disposeLocalRuntimes?: () => Promise<void>;
}

/**
 * 保存事务的单一所有者。顺序：begin（远程屏障）→ 凭据/注册表 → 调用方写
 * config.toml → finish(commit) 逐连接安装并解除屏障。任何一步失败都经
 * finish(commit=false) 恢复旧凭据；恢复本身失败时聚合两个错误，不静默选择一边。
 */
export function createCodexNativeProviderKeyService(
  options: CodexNativeProviderKeyServiceOptions,
): ICodexNativeProviderKeyService {
  const pendingByProvider = new Map<string, PendingKeyChange>();
  const scope = credentialScope(options.environmentKey);
  const credentialKey = (providerId: string) =>
    codexNativeProviderKeyCredentialKey(options.environmentKey, providerId);

  const restoreCredential = async (
    providerId: string,
    value: string | null,
  ): Promise<void> => {
    if (value === null)
      await options.credentialService.delete(credentialKey(providerId));
    else await options.credentialService.save(credentialKey(providerId), value);
  };

  const writeRegistryEntry = async (
    providerId: string,
    entry: { envName: string } | null,
  ): Promise<void> => {
    await mutateRegistry((file) => {
      const providers = { ...file.environments[scope] };
      const had = providerId in providers;
      if (entry === null) delete providers[providerId];
      else providers[providerId] = entry;
      const changed =
        entry === null
          ? had
          : !had || providers[providerId]?.envName !== entry.envName;
      if (changed) {
        if (Object.keys(providers).length === 0)
          delete file.environments[scope];
        else file.environments[scope] = providers;
      }
      return { result: undefined, changed };
    });
  };

  const readRegistryEntry = async (
    providerId: string,
  ): Promise<{ envName: string } | null> => {
    const registry = await readRegistry();
    return registry.environments[scope]?.[providerId] ?? null;
  };

  return {
    async getKeyState({ providerId }) {
      const entry = await readRegistryEntry(providerId);
      const value = entry
        ? (
            await options.credentialService.load(credentialKey(providerId))
          )?.trim()
        : undefined;
      return {
        configured: Boolean(entry && value),
        envName: codexNativeProviderKeyEnvName(providerId),
      };
    },

    async prepareKeySource({ providerId, mode, apiKey }) {
      if (pendingByProvider.has(providerId)) {
        throw new Error(`供应商 ${providerId} 的 Key 正在另一个保存流程中`);
      }
      const envName = codexNativeProviderKeyEnvName(providerId);
      const oldCredential = await options.credentialService.load(
        credentialKey(providerId),
      );
      const oldRegistryEntry = await readRegistryEntry(providerId);
      const nextKey = apiKey?.trim() || oldCredential?.trim() || null;
      if (mode === "runtime-env" && !nextKey) {
        throw new Error("请先输入 API Key；本机没有可复用的已保存 Key");
      }
      const pending: PendingKeyChange = {
        mode,
        oldCredential: oldCredential?.trim() ? oldCredential : null,
        oldRegistryEntry,
        began: false,
      };
      pendingByProvider.set(providerId, pending);
      try {
        if (options.beginRotation) {
          await options.beginRotation();
          pending.began = true;
        }
        try {
          if (mode === "runtime-env") {
            await options.credentialService.save(
              credentialKey(providerId),
              nextKey!,
            );
            await writeRegistryEntry(providerId, { envName });
          } else if (mode === "config-file") {
            await options.credentialService.delete(credentialKey(providerId));
            await writeRegistryEntry(providerId, null);
          }
        } catch (writeError) {
          // 凭据与注册表分属两次写：中途失败必须原地恢复，避免「注册表有引用、
          // 凭据已删」的半状态把供应商永久锁进 blocked。
          await restoreCredential(providerId, pending.oldCredential).catch(
            () => undefined,
          );
          await writeRegistryEntry(providerId, pending.oldRegistryEntry).catch(
            () => undefined,
          );
          throw writeError;
        }
        // delete 模式把凭据/注册表删除推迟到 finish(commit)：config 删除失败时零写入。
        return { envName: mode === "runtime-env" ? envName : undefined };
      } catch (error) {
        pendingByProvider.delete(providerId);
        if (pending.began) {
          // begin 成功但写凭据失败：必须解除远程屏障，否则全部托管供应商持续 fail-closed。
          await options.installKeys?.(false).catch((installError: unknown) => {
            logger.warn(
              undefined,
              "failed to release codex key rotation after prepare failure",
              {
                message:
                  installError instanceof Error
                    ? installError.message
                    : String(installError),
              },
            );
          });
        }
        throw error;
      }
    },

    async finishKeySource({ providerId, commit }) {
      const pending = pendingByProvider.get(providerId);
      if (!pending) {
        throw new Error(`供应商 ${providerId} 没有进行中的 Key 保存流程`);
      }
      pendingByProvider.delete(providerId);
      // Bugfix 诊断盲点：commit 与 rollback 共用同一条成功路径，RPC 层只打印
      // finishKeySource OK，无法区分「配置写成功」与「写失败后已恢复旧凭据」。
      // 曾出现三次保存全绿、但远端 config.toml 一步未改的现场无从判读。
      // scope 是 Environment 哈希，不含主机地址；mode/commit 不含 Key 材料。
      logger.info(undefined, "codex provider key finish", {
        providerId,
        scope,
        mode: pending.mode,
        commit,
        barrierBegan: pending.began,
      });
      try {
        if (!commit) {
          await restoreCredential(providerId, pending.oldCredential);
          await writeRegistryEntry(providerId, pending.oldRegistryEntry);
        } else if (pending.mode === "delete") {
          await options.credentialService.delete(credentialKey(providerId));
          await writeRegistryEntry(providerId, null);
        }
      } catch (error) {
        // 回滚/提交落盘失败仍需尝试解除屏障；把两个错误一起抛出，不掩盖半状态。
        const releaseError = await releaseAfterFinish(
          options,
          pending,
          commit,
        ).catch((release: unknown) => release);
        if (releaseError) {
          throw new AggregateError(
            [error, releaseError],
            "Key 保存恢复与远端屏障解除均失败",
          );
        }
        throw error;
      }
      await releaseAfterFinish(options, pending, commit);
    },
  };
}

async function releaseAfterFinish(
  options: CodexNativeProviderKeyServiceOptions,
  pending: PendingKeyChange,
  commit: boolean,
): Promise<void> {
  if (pending.began) await options.installKeys?.(commit);
  // 本地回滚时配置与凭据均已恢复原值，活动 runtime 无需重造。
  else if (commit) await options.disposeLocalRuntimes?.();
}
