import {
  createCuaHelperInstaller,
  defaultCuaHelperVerifierDependencies,
  type CuaHelperInstaller,
  type CuaHelperInstallerOptions,
} from "@codez/codez-cua/broker/server";

type CuaHelperInstallerFactory = (options: CuaHelperInstallerOptions) => CuaHelperInstaller;

/**
 * macOS `lipo -archs` 对 Intel 二进制返回 `x86_64`，而 Node 的运行时架构名是 `x64`。
 * 两者表示同一架构；如果直接比较字符串，合法的 Intel Helper 会被误判为不可用。
 */
export function normalizeCuaHelperArch(rawArch: string): string {
  switch (rawArch.trim().toLowerCase()) {
    case "amd64":
    case "x86_64":
    case "x64":
      return "x64";
    case "aarch64":
    case "arm64":
      return "arm64";
    default:
      return rawArch.trim();
  }
}

export function normalizeCuaHelperArchs(archs: readonly string[]): string[] {
  return [...new Set(archs.map(normalizeCuaHelperArch).filter(Boolean))];
}

export function canonicalizeCuaHelperInstallerOptions(
  options: CuaHelperInstallerOptions,
): CuaHelperInstallerOptions {
  const readExecutableArchs =
    options.dependencies?.readExecutableArchs ??
    defaultCuaHelperVerifierDependencies.readExecutableArchs;
  return {
    ...options,
    // 根因：发行包只有 ad-hoc Helper 签名，不能提供 Developer ID/TeamIdentifier 身份。
    // Main 与 Local Host 共用此入口，只对随包来源关闭开发者签名链，不放宽身份、架构或安装目录。
    ...(options.bundledAppPath ? { verifySignature: false } : {}),
    dependencies: {
      ...options.dependencies,
      readExecutableArchs: async (executablePath) =>
        normalizeCuaHelperArchs(await readExecutableArchs(executablePath)),
    },
  };
}

export function createCanonicalCuaHelperInstaller(
  options: CuaHelperInstallerOptions,
  createInstaller: CuaHelperInstallerFactory = createCuaHelperInstaller,
): CuaHelperInstaller {
  return createInstaller(canonicalizeCuaHelperInstallerOptions(options));
}

/**
 * 把 Helper 启动/读取失败映射为 unavailable 结果的结构化 errorKind。
 * 只认契约约定的两种 kind（见 docs/cua-permission-broker/codez-cua-permission-broker.md）：
 * bootstrap 前 SIGKILL = Gatekeeper/AMFI 拒杀（helper_launch_blocked）；
 * quarantine 剥离失败 = 安装器 fail-closed（helper_quarantine_present）。
 * 其余失败返回 undefined，UI 沿用现有"未知"展示与重试语义，不被本次改动改变。
 */
export function resolveCuaPermissionUnavailableErrorKind(
  error: unknown,
): "helper_launch_blocked" | "helper_quarantine_present" | undefined {
  const code = (error as { code?: unknown } | null)?.code;
  return code === "helper_launch_blocked" || code === "helper_quarantine_present"
    ? code
    : undefined;
}
