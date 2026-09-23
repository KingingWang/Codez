import { homedir } from "node:os";
import { basename, join } from "node:path";
import { CODEZ_PRODUCT_FLAVOR, type CodezProductFlavor } from "@codez/shared";

export const CODEX_RELEASE_PAGE = "https://github.com/KingingWang/Codez/releases";
export const isCodexDesktop = CODEZ_PRODUCT_FLAVOR === "codex";
export const desktopProtocolScheme = isCodexDesktop ? "codez-codex" : "codez";
export const desktopIntegrationName = isCodexDesktop ? "codez-codex" : "codez";

export function resolveDesktopApplicationName(
  flavor: CodezProductFlavor,
  isPackaged: boolean,
): string {
  // 更名后 codex 与上游共享 Codez 显示名；隔离依赖 appId、协议与数据目录，而非产品名。
  return !isPackaged ? "Codez Dev" : flavor === "preview" ? "Codez Preview" : "Codez";
}

export function resolveDesktopDataBaseDir(
  configured: string | null | undefined,
  home = homedir(),
  flavor: CodezProductFlavor = CODEZ_PRODUCT_FLAVOR,
): string {
  const base = configured?.trim() || home;
  // services 固定拼接 .codez/v2，必须隔离其 base，而不只修改 Electron userData。
  return flavor === "codex" && basename(base) !== ".codez-codex"
    ? join(base, ".codez-codex")
    : base;
}

export function resolveDesktopBootstrapSettingsFile(
  home = homedir(),
  flavor: CodezProductFlavor = CODEZ_PRODUCT_FLAVOR,
): string {
  return join(resolveDesktopDataBaseDir(undefined, home, flavor), ".codez", "v2", "setting.json");
}

export function resolveDesktopUpdatePolicy(flavor: CodezProductFlavor = CODEZ_PRODUCT_FLAVOR) {
  return flavor === "codex"
    ? { automatic: false, manualReleasePage: CODEX_RELEASE_PAGE }
    : { automatic: flavor === "production", manualReleasePage: undefined };
}

export function resolveCodexRemoteAssetDirs(options: {
  isPackaged: boolean;
  resourcesPath: string;
  desktopRoot: string;
  cacheDir: string;
}): { bundledRemoteAssetsDir: string; remoteCacheDir: string } {
  // bundle 根不是已解包的 mock CDN；由 server 检测目标后校验并物化，禁止旧 CDN 回退。
  return {
    bundledRemoteAssetsDir: options.isPackaged
      ? join(options.resourcesPath, "codex-remote")
      : join(options.desktopRoot, "bundled-resources", "codex-remote"),
    remoteCacheDir: join(options.cacheDir, "codex"),
  };
}
