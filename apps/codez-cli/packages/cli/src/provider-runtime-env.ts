import { existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import {
  materializeCodezBuiltinProviderConfig,
  NodeCodezBuiltinProviderConfigSource,
  PERSONAL_PROVIDER_CONFIG_FILE_NAME,
  resolveCodezBuiltinCachePaths,
  resolveCodezBuiltinClientPlatform,
  CODEZ_BUILTIN_PROVIDER_BUNDLED_CONFIG_FILE_ENV,
  CODEZ_BUILTIN_PROVIDER_CONFIG_FILE_ENV,
  CODEZ_PERSONAL_PROVIDER_CONFIG_FILE_ENV,
  type CodezBuiltinRefreshEvent,
} from "@codez/provider-node";
import { resolveRuntimeCodezEndpointOrigin, CODEZ_VERSION } from "@codez/shared";
import type { CliEnv } from "./env.js";

export const SEA_CODEZ_BUILTIN_PROVIDER_CONFIG_ASSET_KEY = "codez-provider/codez-builtin.json";

export function createCliProviderRefreshReporter(
  stderr: Pick<NodeJS.WriteStream, "write"> = process.stderr,
) {
  return {
    onBuiltinRefreshError(error: unknown) {
      stderr.write(
        `Codez Built-in 刷新失败: ${error instanceof Error ? error.message : "unknown error"}\n`,
      );
    },
    onBuiltinRefreshResult(event: CodezBuiltinRefreshEvent) {
      // TTL 检查不是生产事件；成功更新才默认留痕，不能输出 CDN URL 查询参数或内容。
      if (event.result === "updated" || process.env.NODE_ENV !== "production") {
        stderr.write(
          `Codez Built-in ${event.result}${event.reason ? ` (${event.reason})` : ""}${event.revision === undefined ? "" : ` revision=${event.revision} source=CDN`}\n`,
        );
      }
    },
  };
}

type SeaProviderConfigAssets = Pick<typeof import("node:sea"), "getAsset" | "isSea">;

interface PrepareCliProviderRuntimeEnvOptions {
  readonly argv: readonly string[];
  readonly env: CliEnv;
  readonly dataBaseDir?: string;
  readonly entrypoint?: string;
  readonly sea?: SeaProviderConfigAssets;
  readonly appVersion?: string;
  readonly platform?: string;
}

/** 为运行 Core 或写入模型选择的 CLI Entry 定位同一 Environment 的 Provider Config。 */
export async function prepareCliProviderRuntimeEnv(
  options: PrepareCliProviderRuntimeEnvOptions,
): Promise<Record<string, string>> {
  if (!requiresProviderRuntime(options.argv)) return {};

  const explicitCodezBuiltin = options.env[CODEZ_BUILTIN_PROVIDER_CONFIG_FILE_ENV]?.trim();
  const explicitPersonal = options.env[CODEZ_PERSONAL_PROVIDER_CONFIG_FILE_ENV]?.trim();
  const dataBaseDir = options.dataBaseDir ?? options.env.CODEZ_DATA_BASE_DIR?.trim() ?? homedir();
  if (explicitCodezBuiltin && explicitPersonal) {
    return {
      [CODEZ_BUILTIN_PROVIDER_CONFIG_FILE_ENV]: explicitCodezBuiltin,
      [CODEZ_PERSONAL_PROVIDER_CONFIG_FILE_ENV]: explicitPersonal,
    };
  }

  const codezBuiltinFilePath =
    explicitCodezBuiltin ??
    (await resolveBundledCodezBuiltinProviderConfig({
      dataBaseDir,
      entrypoint: options.entrypoint ?? process.argv[1],
      sea: options.sea ?? getSeaProviderConfigAssets(),
    }));
  const personalFilePath =
    explicitPersonal ?? join(dataBaseDir, ".codez", "v2", PERSONAL_PROVIDER_CONFIG_FILE_NAME);
  const appVersion = options.appVersion ?? CODEZ_VERSION;
  const platform = options.platform ?? resolveCodezBuiltinClientPlatform();
  const codezEndpointOrigin = resolveRuntimeCodezEndpointOrigin(options.env);
  const cachePaths = resolveCodezBuiltinCachePaths({
    environmentConfigRoot: join(dataBaseDir, ".codez", "v2"),
    platform,
    appVersion,
    codezEndpointOrigin,
  });
  const source = new NodeCodezBuiltinProviderConfigSource({
    bundledFilePath: codezBuiltinFilePath,
    activeFilePath: cachePaths.activeFilePath,
    watch: false,
  });
  // 入口只准备资源和路径；下载由 Prompt/TUI 长生命周期 Runtime 持有并取消。
  try {
    await source.read();
  } finally {
    source.dispose();
  }

  return {
    [CODEZ_BUILTIN_PROVIDER_CONFIG_FILE_ENV]: cachePaths.activeFilePath,
    [CODEZ_BUILTIN_PROVIDER_BUNDLED_CONFIG_FILE_ENV]: codezBuiltinFilePath,
    [CODEZ_PERSONAL_PROVIDER_CONFIG_FILE_ENV]: personalFilePath,
  };
}

function requiresProviderRuntime(argv: readonly string[]): boolean {
  if (argv.some((arg) => arg === "--help" || arg === "-h" || arg === "--version" || arg === "-v")) {
    return false;
  }
  if (
    argv.some(
      (arg) =>
        arg === "--prompt" ||
        arg.startsWith("--prompt=") ||
        arg === "--target" ||
        arg.startsWith("--target="),
    )
  ) {
    return true;
  }

  const command = argv[0];
  if (command === undefined || command.startsWith("-")) return true;
  return (
    command === "tui" ||
    command === "app-server" ||
    command === "agent-server" ||
    command === "login" ||
    command === "logout"
  );
}

async function resolveBundledCodezBuiltinProviderConfig(input: {
  readonly dataBaseDir: string;
  readonly entrypoint: string | undefined;
  readonly sea: SeaProviderConfigAssets | undefined;
}): Promise<string> {
  if (input.sea?.isSea()) {
    const content = input.sea.getAsset(SEA_CODEZ_BUILTIN_PROVIDER_CONFIG_ASSET_KEY, "utf8");
    return materializeCodezBuiltinProviderConfig({
      environmentConfigRoot: join(input.dataBaseDir, ".codez", "v2"),
      content,
    });
  }

  const entrypoint = input.entrypoint?.trim();
  if (!entrypoint) throw new Error("无法定位 CLI Codez Built-in Provider Config：缺少入口路径");
  // 全局 bin 可以是软链接，随包配置必须相对真实入口定位。
  const entryDirectory = dirname(realpathSync(resolve(entrypoint)));
  const candidates = [
    join(entryDirectory, "provider", "codez-builtin.json"),
    resolve(entryDirectory, "../../../../../config/provider/codez-builtin.json"),
  ];
  const candidate = candidates.find((filePath) => existsSync(filePath));
  if (candidate) return candidate;
  throw new Error(`无法定位 CLI Codez Built-in Provider Config：${candidates.join(", ")}`);
}

function getSeaProviderConfigAssets(): SeaProviderConfigAssets | undefined {
  const getBuiltinModule = process.getBuiltinModule as
    | ((id: "node:sea") => typeof import("node:sea"))
    | undefined;
  return getBuiltinModule?.("node:sea");
}
