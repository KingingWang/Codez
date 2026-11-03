export const CODEZ_BUILTIN_PROVIDER_CONFIG_FILE_ENV = "CODEZ_BUILTIN_PROVIDER_CONFIG_FILE";
export const CODEZ_BUILTIN_PROVIDER_BUNDLED_CONFIG_FILE_ENV =
  "CODEZ_BUILTIN_PROVIDER_BUNDLED_CONFIG_FILE";
export const CODEZ_PERSONAL_PROVIDER_CONFIG_FILE_ENV = "CODEZ_PERSONAL_PROVIDER_CONFIG_FILE";
export const PERSONAL_PROVIDER_CONFIG_FILE_NAME = "provider_config.json";

export interface NodeProviderRuntimePaths {
  readonly codezBuiltinFilePath: string;
  readonly personalFilePath: string;
}

export function createNodeProviderRuntimePathEnv(
  paths: NodeProviderRuntimePaths,
): Record<string, string> {
  return {
    [CODEZ_BUILTIN_PROVIDER_CONFIG_FILE_ENV]: paths.codezBuiltinFilePath,
    [CODEZ_PERSONAL_PROVIDER_CONFIG_FILE_ENV]: paths.personalFilePath,
  };
}

export function resolveNodeProviderRuntimePaths(
  env: Readonly<Record<string, string | undefined>>,
): NodeProviderRuntimePaths | null {
  const codezBuiltinFilePath = env[CODEZ_BUILTIN_PROVIDER_CONFIG_FILE_ENV]?.trim();
  const personalFilePath = env[CODEZ_PERSONAL_PROVIDER_CONFIG_FILE_ENV]?.trim();
  if (!codezBuiltinFilePath && !personalFilePath) return null;
  if (!codezBuiltinFilePath || !personalFilePath) {
    throw new Error("Codez Built-in 与 Personal Provider Config 路径必须同时提供");
  }
  return Object.freeze({ codezBuiltinFilePath, personalFilePath });
}
