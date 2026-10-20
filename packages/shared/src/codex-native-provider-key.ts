import { z } from "zod";

/**
 * Codex 原生自定义供应商「本机保存、临时环境变量」Key 的共享契约
 * （spec: specs/codex-provider-runtime-env-key.md）。
 *
 * - config.toml 只出现 env_key 引用；真实值只存在于桌面本机 Credential Store
 *   与目标 Host 进程内存（经可信远程 RPC 逐连接安装）。
 * - 环境变量名由 App 生成且只允许 App 识别的前缀，手工外部 env_key 不受影响。
 */

export const CODEX_NATIVE_PROVIDER_KEY_ENV_PREFIX = "CODEZ_CODEX_API_KEY_";

const ENV_NAME_PATTERN = /^CODEZ_CODEX_API_KEY_[A-F0-9]{16}$/;

const nonEmptyString = z.string().trim().min(1);

/** 仅识别 App 生成的变量名；用户手工配置的外部 env_key 一律返回 false。 */
export function isCodexNativeProviderKeyEnvName(name: string): boolean {
  return ENV_NAME_PATTERN.test(name);
}

export const codexNativeProviderKeyEnvNameSchema = z
  .string()
  .regex(ENV_NAME_PATTERN);

/**
 * Window Host → Remote Host 的逐连接安装载荷。value 为 null 表示该引用在本机
 * 尚无凭据：远端必须显式移除同名继承变量并把该供应商标记为禁止发起模型请求，
 * 而不是回退到旧值或外部同名变量。
 */
export const codexNativeProviderKeyEntrySchema = z
  .object({
    providerId: nonEmptyString,
    envName: codexNativeProviderKeyEnvNameSchema,
    value: nonEmptyString.nullable(),
  })
  .strict();

export const codexNativeProviderKeyInstallSchema = z
  .object({
    keys: z.array(codexNativeProviderKeyEntrySchema).max(64),
  })
  .strict();

export type CodexNativeProviderKeyEntry = z.infer<
  typeof codexNativeProviderKeyEntrySchema
>;
export type CodexNativeProviderKeyInstall = z.infer<
  typeof codexNativeProviderKeyInstallSchema
>;
