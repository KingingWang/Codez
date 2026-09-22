import { homedir } from "node:os";
import { basename, join } from "node:path";
import { ZCODE_PRODUCT_FLAVOR, type ZCodeProductFlavor } from "@zcode/shared";

export const CODEX_RELEASE_PAGE = "https://github.com/KingingWang/ZCode/releases";
export const isCodexDesktop = ZCODE_PRODUCT_FLAVOR === "codex";
export const desktopProtocolScheme = isCodexDesktop ? "zcode-codex" : "zcode";
export const desktopIntegrationName = isCodexDesktop ? "zcode-codex" : "zcode";

export function resolveDesktopApplicationName(
  flavor: ZCodeProductFlavor,
  isPackaged: boolean,
): string {
  if (flavor === "codex") return isPackaged ? "ZCode Codex" : "ZCode Codex Dev";
  return !isPackaged ? "ZCode Dev" : flavor === "preview" ? "ZCode Preview" : "ZCode";
}

export function resolveDesktopDataBaseDir(
  configured: string | null | undefined,
  home = homedir(),
  flavor: ZCodeProductFlavor = ZCODE_PRODUCT_FLAVOR,
): string {
  const base = configured?.trim() || home;
  // services 固定拼接 .zcode/v2，必须隔离其 base，而不只修改 Electron userData。
  return flavor === "codex" && basename(base) !== ".zcode-codex"
    ? join(base, ".zcode-codex")
    : base;
}

export function resolveDesktopBootstrapSettingsFile(
  home = homedir(),
  flavor: ZCodeProductFlavor = ZCODE_PRODUCT_FLAVOR,
): string {
  return join(resolveDesktopDataBaseDir(undefined, home, flavor), ".zcode", "v2", "setting.json");
}

export function resolveDesktopUpdatePolicy(flavor: ZCodeProductFlavor = ZCODE_PRODUCT_FLAVOR) {
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
