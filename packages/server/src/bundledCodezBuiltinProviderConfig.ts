import { materializeCodezBuiltinProviderConfig } from "@codez/services/node";

declare const __CODEZ_BUILTIN_PROVIDER_CONFIG_JSON__: string | undefined;

interface MaterializeBundledCodezBuiltinProviderConfigOptions {
  readonly environmentConfigRoot: string;
  readonly content: string;
}

/** 返回构建时嵌入远端 Server 的 Codez Built-in Provider Config。 */
export function readBundledCodezBuiltinProviderConfig(): string {
  if (typeof __CODEZ_BUILTIN_PROVIDER_CONFIG_JSON__ !== "string") {
    throw new Error("当前构建未嵌入 Codez Built-in Provider Config");
  }
  return __CODEZ_BUILTIN_PROVIDER_CONFIG_JSON__;
}

/**
 * 将 Codez Built-in Config 原子物化到所属环境的固定资源副本。
 * 升级前退出旧进程；不保留按内容 hash 增长的历史文件。
 */
export async function materializeBundledCodezBuiltinProviderConfig(
  options: MaterializeBundledCodezBuiltinProviderConfigOptions,
): Promise<string> {
  return materializeCodezBuiltinProviderConfig(options);
}
