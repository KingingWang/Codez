import { homedir } from "node:os";
import { basename, join } from "node:path";
import { CODEZ_PRODUCT_FLAVOR, type CodezProductFlavor } from "@codez/shared";

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
  // codex 已接入 GitHub releases 自动更新（electron-updater github provider + per-arch
  // channel，见 specs/codex-desktop-distribution.md），不再回退到手动打开发布页。
  // 只有 preview 保持关闭：preview 身份不对外分发更新。
  return { automatic: flavor !== "preview" };
}

export function resolveCodexGitHubUpdateFeedOptions(arch: string): {
  provider: "github";
  owner: string;
  repo: string;
  channel: string;
} {
  // 运行时 channel 必须随 feed 显式给出：setFeedURL 会直接安装 provider，
  // electron-updater 的 GitHub provider 只从 feed options（或 autoUpdater.channel）取
  // channel，不再回读 app-update.yml 的烘焙值；缺省静默回退 "latest"，请求
  // latest-mac.yml 会 404（release 只发布 per-arch yml，见 specs/codex-desktop-distribution.md）。
  return {
    provider: "github",
    owner: "KingingWang",
    repo: "Codez",
    channel: `${arch}-latest`,
  };
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
